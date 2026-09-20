import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime, AgentRun, InMemoryAgentEventBus, InMemorySessionStore, createAgentInput } from "../src/runtime/index.js";
import type { AgentEventOf } from "../spec/agent-event.js";
import type { FollowUpQuestion } from "../spec/types.js";
import { parseFollowUpRequest, validateFollowUpAnswers } from "../spec/follow-up.js";
import { parseIntent } from "../src/intent/parser.js";
import { interpretFollowUpAnswers } from "../src/planner/follow-up.js";
import { stage2_followUp } from "../src/planner/stages.js";
import type { PipelineOptions, PlanResult } from "../src/planner/engine.js";
import { buildChannelRoutes } from "../src/server/handlers.js";
import type { ChannelRequest } from "../spec/channel.js";
import { replayAgentEvents } from "../src/runtime/event-reducer.js";
import { SearchRestaurantsTool } from "../src/tools/restaurants.js";
import { GenerateFollowUpTool } from "../src/tools/followup.js";
import { generateFollowUpWithLLM } from "../src/llm/followup.js";

vi.mock("../src/llm/followup.js", () => ({ generateFollowUpWithLLM: vi.fn(async () => []) }));

const question: FollowUpQuestion = { id: "budget", question: "预算？", reason: "控制花费", type: "single_choice",
  options: [{ value: "low", label: "低", hint: "节约" }, { value: "high", label: "高", hint: "品质" }] };
const answers = [{ questionId: "budget", selectedValues: ["low"] }];
const runtimes: AgentRuntime[] = [];
afterEach(() => { runtimes.forEach(r => r.shutdown()); runtimes.length = 0; vi.useRealTimers(); });

function setup(options: ConstructorParameters<typeof AgentRuntime>[0] = {}) {
  const eventBus = new InMemoryAgentEventBus();
  let resolve!: (event: AgentEventOf<"follow_up_requested">) => void;
  const requested = new Promise<AgentEventOf<"follow_up_requested">>(r => { resolve = r; });
  const events: import("../spec/agent-event.js").AgentEvent[] = [];
  eventBus.subscribe({ id: "capture", matches: () => true, handle: event => {
    events.push(event); if (event.type === "follow_up_requested") resolve(event);
  } });
  const runtime = new AgentRuntime({ eventBus, sessionStore: new InMemorySessionStore(), ...options });
  runtimes.push(runtime);
  return { runtime, requested, events, eventBus };
}
const waitingPlanner = { run: async (run: AgentRun, opts: PipelineOptions): Promise<PlanResult> => {
  await opts.requestFollowUp!([question]);
  run.finish("completed", { success: true, message: "ok" });
  return { success: true, message: "ok", state: run.state.planning, agentState: run.state };
} };

describe("追问交互闭环", () => {
  it("原运行等待回答，应用预算后只继续后续阶段，事件可重放", async () => {
    const { runtime, requested, events } = setup({ runOptions: { parseFn: parseIntent } });
    const done = runtime.submit(createAgentInput("周末带老婆孩子出去玩4个小时", { interactive: true }), { sessionId: "family" });
    const event = await requested;
    const active = runtime.router.getActiveRun(event.scope.runId)!;
    expect(active.status).toBe("waiting_input");
    expect(active.run.projection.pendingInput?.requestId).toBe(event.payload.requestId);
    expect(events.some(e => e.type === "step_started" && e.payload.stepType === "candidate_generation")).toBe(false);
    const selections = event.payload.questions.map(q => ({ questionId: q.id, selectedValues: [q.id === "budget" ? "low" : q.options[0].value] }));
    const accepted = await runtime.submit("", { sessionId: "family", op: { type: "answer", runId: event.scope.runId, requestId: event.payload.requestId, answers: selections } });
    expect(accepted.status).toBe("completed");
    const result = (await done).result as PlanResult;
    expect(result.success).toBe(true);
    expect(result.state.constraints?.group.preferences.budget).toBe("low");
    expect(result.state.selectedPlan?.score?.dimensions.find(d => d.dimension === "budget")?.reason).toContain("low");
    expect(result.state.followUpQuestions).toEqual([]);
    expect(result.agentState.messages.map(m => m.kind)).toContain("followup_answer");
    expect(events.filter(e => e.type === "step_started" && e.payload.stepType === "intent_parsing")).toHaveLength(1);
    expect(events.filter(e => e.type === "follow_up_requested")).toHaveLength(1);
    expect(replayAgentEvents(result.agentState.trace)).toMatchObject({ status: "completed", pendingInput: undefined });
    expect(runtime.router.snapshot().activeRuns).toBe(0);
  });

  it("隔离会话、拒绝旧标识/非法值/补丁注入/重复回答，合法回答后可继续", async () => {
    const { runtime, requested, events } = setup({ planner: waitingPlanner });
    const done = runtime.submit(createAgentInput("test", { interactive: true }), { sessionId: "a" });
    const event = await requested;
    const op = { type: "answer" as const, runId: event.scope.runId, requestId: event.payload.requestId, answers };
    expect((await runtime.submit("", { sessionId: "b", op })).status).toBe("rejected");
    expect((await runtime.submit("", { sessionId: "a", op: { ...op, requestId: "stale" } })).status).toBe("rejected");
    for (const bad of [[], [...answers, ...answers], [{ questionId: "budget", selectedValues: ["evil"] }], [{ ...answers[0], patches: { budget: "high" } }]]) {
      expect((await runtime.submit("", { sessionId: "a", op: { ...op, answers: bad } })).error).toBe("invalid_follow_up_answers");
    }
    expect(runtime.router.getActiveRun(op.runId)?.status).toBe("waiting_input");
    const results = await Promise.all([runtime.submit("", { sessionId: "a", op }), runtime.submit("", { sessionId: "a", op })]);
    expect(results.map(r => r.status).sort()).toEqual(["completed", "rejected"]);
    await done;
    expect(events.filter(e => e.type === "follow_up_answered")).toHaveLength(1);
  });

  it.each(["disconnect", "cancel", "shutdown"])("等待时 %s 清理运行且不再接受回答", async mode => {
    const { runtime, requested, events } = setup({ planner: waitingPlanner });
    const controller = new AbortController();
    const done = runtime.submit(createAgentInput("test", { interactive: true }), { sessionId: "a", signal: controller.signal });
    const event = await requested;
    if (mode === "disconnect") controller.abort(new Error("disconnected"));
    else if (mode === "shutdown") runtime.shutdown();
    else await runtime.submit("", { sessionId: "a", op: { type: "cancel", runId: event.scope.runId } });
    await done;
    expect(runtime.router.getActiveRun(event.scope.runId)).toBeUndefined();
    expect(runtime.router.snapshot().activeRuns).toBe(0);
    expect(events.filter(e => e.type === "final")).toHaveLength(1);
    expect(replayAgentEvents(events)).toMatchObject({ status: "cancelled", pendingInput: undefined });
  });

  it("等待期限包含用户回答时间，超时释放容量", async () => {
    vi.useFakeTimers();
    const { runtime, requested } = setup({ planner: waitingPlanner, limits: { deadlineMs: 100 } });
    const done = runtime.submit(createAgentInput("test", { interactive: true }), { sessionId: "a" });
    await requested;
    await vi.advanceTimersByTimeAsync(101);
    expect((await done).status).toBe("failed");
    expect(runtime.router.snapshot().activeRuns).toBe(0);
  });

  it("无需追问的运行不会等待", async () => {
    const { runtime, events } = setup({ runOptions: { parseFn: text => {
      const constraints = parseIntent(text); constraints.group.leadRole = "solo_relax"; return constraints;
    } } });
    await runtime.submit(createAgentInput("独自出去逛逛4小时", { interactive: true }), { sessionId: "solo" });
    expect(events.some(e => e.type === "follow_up_requested")).toBe(false);
  });

  it("单选协议拒绝不完整问题、未知题目、多选和重复 ID", () => {
    expect(() => validateFollowUpAnswers([question], [{ questionId: "other", selectedValues: ["low"] }])).toThrow();
    expect(() => validateFollowUpAnswers([question], [{ questionId: "budget", selectedValues: ["low", "high"] }])).toThrow();
    expect(() => parseFollowUpRequest({ requestId: "q", runId: "r", sessionId: "s", expiresAt: 1, questions: [question, question] })).toThrow();
  });

  it("问题目录不接受 LLM 增加问题或改选项，所有展示选项都有约束映射", async () => {
    const constraints = parseIntent("带爸妈和减肥老婆出去玩");
    constraints.group.leadRole = "elderly";
    constraints.group.preferences.dieting = true;
    constraints.group.preferences.budget = undefined;
    vi.mocked(generateFollowUpWithLLM).mockResolvedValueOnce([
      { ...question, id: "arbitrary" }, { ...question, options: [{ value: "unsafe", label: "unsafe", hint: "" }] },
    ]);
    const catalog = await new GenerateFollowUpTool().run({ constraints });
    expect(catalog.map(q => q.id)).toEqual(["trip_style", "elderly_dietary", "dieting_level", "budget"]);
    expect(catalog.find(q => q.id === "budget")?.options.map(o => o.value)).toEqual(["low", "medium", "high"]);
    for (const q of catalog) for (const option of q.options) {
      expect(interpretFollowUpAnswers(constraints, [q], [{ questionId: q.id, selectedValues: [option.value] }])[0].patches).toBeDefined();
    }
  });

  it("严格控卡的回答确实收紧餐厅筛选，而不是只保存字段", async () => {
    const constraints = parseIntent("带娃和减肥老婆出去玩");
    const catalog = await new GenerateFollowUpTool().run({ constraints });
    const q = catalog.find(q => q.id === "dieting_level")!;
    const patches = interpretFollowUpAnswers(constraints, [q], [{ questionId: q.id, selectedValues: ["strict"] }]);
    const state = await stage2_followUp({ stage: "follow_up_questions", constraints, errors: [] }, patches);
    const tool = new SearchRestaurantsTool();
    const input = { group: state.constraints!.group, distance: constraints.distance, timeWindow: constraints.timeWindow };
    const normal = await tool.run(input);
    const strict = await tool.run({ ...input, dietaryRestrictions: state.constraints!.group.preferences.dietaryRestrictions });
    expect(strict.length).toBeGreaterThan(0);
    expect(strict.length).toBeLessThan(normal.length);
    expect(strict.every(r => r.tags.includes("轻食") && r.tags.includes("低卡"))).toBe(true);
  });

  it("减脂回答影响约束，不清除原始忌口，且不再次生成问题", async () => {
    const constraints = parseIntent("带娃和减肥老婆出去玩");
    constraints.group.preferences.dietaryRestrictions = ["不吃海鲜"];
    constraints.group.preferences.dieting = true;
    const q: FollowUpQuestion = { ...question, id: "dieting_level", options: [
      { value: "cheat_day", label: "放松", hint: "" }, { value: "strict", label: "严格", hint: "" }] };
    const applied = interpretFollowUpAnswers(constraints, [q], [{ questionId: q.id, selectedValues: ["cheat_day"] }]);
    const state = await stage2_followUp({ stage: "follow_up_questions", constraints, errors: [] }, applied);
    expect(state.constraints?.group.preferences).toMatchObject({ dieting: false, dietaryRestrictions: ["不吃海鲜"] });
    expect(state.followUpQuestions).toEqual([]);
  });

  it("SSE 问题 → HTTP 回答 → 同一 SSE done，错误提交不打断等待", async () => {
    const { runtime, eventBus } = setup({ runOptions: { parseFn: parseIntent } });
    const routes = buildChannelRoutes({ runtime, eventBus, createId: prefix => `${prefix}_integration` });
    const stream = routes.find(r => r.path === "/api/decide/stream")!.stream!;
    const answer = routes.find(r => r.path === "/api/decide/answer")!.handler!;
    const req: ChannelRequest = { method: "GET", path: "/api/decide/stream", query: { q: "带娃出去玩4小时", interactive: "1" }, body: undefined, params: {}, headers: {}, clientIp: "test" };
    let resolve!: (value: unknown) => void;
    const followUp = new Promise<unknown>(r => { resolve = r; });
    const output: { type: string; data: unknown }[] = [];
    const done = stream(req, (type, data) => { output.push({ type, data }); if (type === "follow_up") resolve(data); });
    const input = parseFollowUpRequest(await followUp);
    expect(output.some(e => e.type === "done")).toBe(false);
    const response = await answer({ ...req, method: "POST", body: { ...input, answers: [] } });
    expect(response.statusCode).toBe(400);
    const accepted = await answer({ ...req, method: "POST", body: { ...input,
      answers: input.questions.map(q => ({ questionId: q.id, selectedValues: [q.options[0].value] })) } });
    expect(accepted.body).toMatchObject({ accepted: true });
    await done;
    expect(output.find(e => e.type === "done")?.data).toMatchObject({ runId: input.runId, sessionId: input.sessionId, success: true });
    expect(eventBus.subscriberCount()).toBe(1); // 只保留测试观察者
  });

  it("追问无法通过 Subscriber 送达时中止等待，不遗留占用的运行", async () => {
    const { runtime, eventBus } = setup({ planner: waitingPlanner });
    const route = buildChannelRoutes({ runtime, eventBus, createId: prefix => `${prefix}_broken` })
      .find(r => r.path === "/api/decide/stream")!;
    await route.stream!({ method: "GET", path: "/api/decide/stream", query: { q: "test", interactive: "1" },
      body: undefined, params: {}, headers: {}, clientIp: "test" }, type => {
      if (type === "follow_up") throw new Error("broken_transport");
    });
    await vi.waitFor(() => expect(runtime.router.snapshot().activeRuns).toBe(0));
    expect(eventBus.subscriberCount()).toBe(1);
  });
});
