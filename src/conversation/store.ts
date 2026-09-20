import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { DecisionResult } from "../../spec/decision.js";
import type { PlanningConversation, ConversationTurnKind, ConversationTurnRole } from "../../spec/conversation.js";
import type { Plan, StructuredConstraints } from "../../spec/types.js";

interface StoreFile { version: 1; conversations: Record<string, PlanningConversation> }
const DEFAULT_PATH = process.env.VITEST
  ? path.join(tmpdir(), `activity-agent-conversations-${process.pid}.json`)
  : path.resolve(process.cwd(), "data", "conversations.json");

export class ConversationStore {
  private readonly conversations = new Map<string, PlanningConversation>();
  private loaded = false;
  private mutation: Promise<void> = Promise.resolve();
  constructor(private readonly filePath = DEFAULT_PATH) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreFile;
      if (data.version === 1) for (const [id, value] of Object.entries(data.conversations ?? {})) this.conversations.set(id, value);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.loaded = true;
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined); return result;
  }
  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    const data: StoreFile = { version: 1, conversations: Object.fromEntries(this.conversations) };
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), "utf8"); await fs.rename(temporary, this.filePath);
  }
  async get(id: string): Promise<PlanningConversation | undefined> {
    await this.load(); const value = this.conversations.get(id); return value ? structuredClone(value) : undefined;
  }
  async list(): Promise<PlanningConversation[]> {
    await this.load(); return [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)
      .map(value => structuredClone(value));
  }
  async getOrCreate(id: string, firstMessage?: string): Promise<PlanningConversation> {
    return this.enqueue(async () => { await this.load(); const existing = this.conversations.get(id);
      if (existing) return structuredClone(existing); const now = Date.now();
      const created: PlanningConversation = { id, title: firstMessage?.trim().slice(0, 30) || "新的活动规划",
        turns: [], memory: { revision: 0 }, plans: [], createdAt: now, updatedAt: now };
      this.conversations.set(id, created); await this.persist(); return structuredClone(created); });
  }
  async appendTurn(id: string, role: ConversationTurnRole, kind: ConversationTurnKind, content: string,
    options: { runId?: string; metadata?: Record<string, unknown> } = {}): Promise<PlanningConversation> {
    return this.update(id, conversation => { const now = Date.now(); return { ...conversation,
      title: conversation.turns.length ? conversation.title : content.trim().slice(0, 30), updatedAt: now,
      turns: [...conversation.turns, { id: `turn_${randomUUID()}`, role, kind, content, createdAt: now, ...options }] }; });
  }
  async setPendingQuestion(id: string, requestId?: string): Promise<PlanningConversation> {
    return this.update(id, conversation => ({ ...conversation, updatedAt: Date.now(), memory: {
      ...conversation.memory, pendingQuestionRequestId: requestId } }));
  }
  async checkpointConstraints(id: string, constraints: StructuredConstraints): Promise<PlanningConversation> {
    return this.update(id, conversation => ({ ...conversation, updatedAt: Date.now(), memory: {
      ...conversation.memory, revision: conversation.memory.revision + 1, constraints } }));
  }
  async completePlan(id: string, runId: string, constraints: StructuredConstraints, decision: DecisionResult,
    selectedPlan: Plan, message: string): Promise<PlanningConversation> {
    return this.update(id, conversation => { const now = Date.now(); const version = (conversation.plans.at(-1)?.version ?? 0) + 1;
      return { ...conversation, updatedAt: now,
        turns: [...conversation.turns, { id: `turn_${randomUUID()}`, role: "assistant", kind: "plan",
          content: message, createdAt: now, runId, metadata: { planVersion: version } }],
        plans: [...conversation.plans, { version, runId, constraints, decision, selectedPlan, createdAt: now }],
        memory: { revision: conversation.memory.revision + 1, constraints, currentPlanVersion: version,
          acceptedPlanVersion: conversation.memory.acceptedPlanVersion } }; });
  }
  async confirmPlan(id: string, version: number, planId?: string): Promise<PlanningConversation> {
    return this.update(id, conversation => { if (conversation.memory.currentPlanVersion !== version) throw new Error("plan_version_not_current");
      const current = conversation.plans.find(plan => plan.version === version)!;
      const selected = planId
        ? [current.decision.recommended, ...current.decision.pareto].find(candidate => candidate.plan.id === planId)?.plan
        : current.selectedPlan;
      if (!selected) throw new Error("plan_candidate_not_found");
      const now = Date.now(); return { ...conversation, updatedAt: now,
        plans: conversation.plans.map(plan => plan.version === version ? { ...plan, selectedPlan: selected, acceptedAt: now } : plan),
        turns: [...conversation.turns, { id: `turn_${randomUUID()}`, role: "user", kind: "choice",
          content: `确认采用方案 v${version}：${selected.summary}`, createdAt: now, metadata: { planVersion: version, planId: selected.id } }],
        memory: { ...conversation.memory, acceptedPlanVersion: version } }; });
  }
  private async update(id: string, reducer: (value: PlanningConversation) => PlanningConversation): Promise<PlanningConversation> {
    return this.enqueue(async () => { await this.load(); const current = this.conversations.get(id);
      if (!current) throw new Error("conversation_not_found"); const updated = reducer(current);
      this.conversations.set(id, updated); await this.persist(); return structuredClone(updated); });
  }
}
export const defaultConversationStore = new ConversationStore();
