import type { DecisionResult } from "./decision.js";
import type { Plan, PlanningStage } from "./types.js";

export interface DecisionResponse {
  success: boolean;
  message: string;
  decision?: DecisionResult;
  selectedPlan?: Plan;
  notes: string[];
  constraints?: unknown;
  submissionId?: string;
  sessionId?: string;
  runId?: string;
  traceId?: string;
  conversationId?: string;
  planVersion?: number;
}
export interface DecisionStage { stage: PlanningStage; message: string; ts?: number }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(text);
const oneOf = (v: unknown, values: readonly string[]) => text(v) && values.includes(v);
const optional = (v: unknown, check: (value: unknown) => boolean) => v === undefined || check(v);
const dimensions = ["time", "transit", "preference", "crowd", "budget", "popularity"];
const objectives = ["balanced", "time_saver", "budget_saver", "experience"];
const stages = ["intent_parsing", "follow_up_questions", "candidate_generation", "feasibility_check", "fine_scheduling"];
const confidence = (v: unknown) => finite(v) && v >= 0 && v <= 1;
const score = (v: unknown) => record(v) && finite(v.total) && v.total >= 0 && v.total <= 100 && confidence(v.confidence)
  && Array.isArray(v.dimensions) && v.dimensions.every(d => record(d) && oneOf(d.dimension, dimensions)
    && finite(d.score) && finite(d.weight) && finite(d.weighted) && text(d.reason));
const explanation = (v: unknown) => record(v) && strings(v.highlights) && strings(v.tradeoffs) && optional(v.whyNotOthers, strings);

function plan(v: unknown): boolean {
  if (!record(v) || !text(v.id) || !text(v.summary) || !finite(v.totalDurationHours)
    || !finite(v.totalTransitMinutes) || !finite(v.feasibilityScore)
    || !oneOf(v.scenario, ["family", "friends", "couple", "solo"])
    || !oneOf(v.leadRole, ["kids", "elderly", "mixed_family", "partner", "friends_group", "solo_relax"])
    || !optional(v.totalCost, finite) || !optional(v.score, score) || !optional(v.explanation, explanation)
    || !Array.isArray(v.activities)) return false;
  return v.activities.every(a => {
    if (!record(a) || !finite(a.order) || !text(a.scheduledStart) || !text(a.scheduledEnd)
      || !oneOf(a.status, ["pending", "scheduled"]) || !record(a.place)) return false;
    const p = a.place;
    return text(p.id) && text(p.name) && text(p.address) && finite(p.distanceKm) && finite(p.rating)
      && strings(p.crowdTags) && strings(p.localFeatures) && record(p.location)
      && finite(p.location.lat) && finite(p.location.lng) && text(p.location.address) && text(p.location.city)
      && oneOf(p.type, ["attraction", "break", "restaurant", "delivery", "walking"])
      && optional(a.crowd, c => record(c) && oneOf(c.level, ["low", "medium", "high", "packed"]) && confidence(c.confidence));
  });
}
const candidate = (v: unknown) => record(v) && plan(v.plan) && finite(v.feasibilityScore) && text(v.reason) && optional(v.objective, o => oneOf(o, objectives));
const decision = (v: unknown) => record(v) && candidate(v.recommended) && Array.isArray(v.pareto) && v.pareto.every(candidate) && confidence(v.confidence) && strings(v.notes);

/** HTTP 与 SSE done 共用；额外字段保留，错误在进入 React state 前抛出。 */
export function parseDecisionResponse(v: unknown): DecisionResponse {
  if (!record(v) || typeof v.success !== "boolean" || !text(v.message) || !strings(v.notes)
    || !optional(v.decision, decision) || !optional(v.selectedPlan, plan)
    || (v.success && !v.decision)
    || !["submissionId", "sessionId", "runId", "traceId", "conversationId"].every(key => optional(v[key], text))
    || !optional(v.planVersion, value => finite(value) && Number.isSafeInteger(value) && value >= 1)) throw new Error("决策结果结构无效，请重试");
  return v as unknown as DecisionResponse;
}

export function parseDecisionStage(v: unknown): DecisionStage {
  if (!record(v) || !oneOf(v.stage, stages) || !text(v.message) || !optional(v.ts, finite)) throw new Error("规划进度结构无效，请重试");
  return v as unknown as DecisionStage;
}
