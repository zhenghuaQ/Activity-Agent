import { categoryForAgentEvent, type AgentEvent, type AgentEventType } from "./agent-event.js";
import { isFollowUpQuestions } from "./follow-up.js";

type Check = (value: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const string: Check = v => typeof v === "string";
const number: Check = v => typeof v === "number" && Number.isFinite(v);
const boolean: Check = v => typeof v === "boolean";
const strings: Check = v => Array.isArray(v) && v.every(string);
const oneOf = (...values: unknown[]): Check => v => values.includes(v);
const optional = (check: Check): Check => v => v === undefined || check(v);
const status = oneOf("pending", "running", "waiting_input", "completed", "failed", "cancelled");
const rules: Record<AgentEventType, Record<string, Check>> = {
  follow_up_requested: { requestId: string, expiresAt: number, questions: isFollowUpQuestions },
  follow_up_answered: { requestId: string, questionIds: strings },
  run_created: { status: oneOf("pending") },
  run_started: { inputLength: optional(number), planner: optional(string) },
  run_status_changed: { previousStatus: status, status, reason: optional(string), source: optional(oneOf("runtime", "planner", "control", "transport")) },
  run_cancel_requested: { reason: string, source: oneOf("control", "transport") },
  plan_created: { planId: string, steps: strings },
  profile_resolved: { source: oneOf("explicit", "inferred"), segment: string, profileId: optional(string) },
  step_started: { stepType: string },
  step_finished: { stepType: string, status },
  tool_call: { input: () => true, logicalCallId: string },
  tool_result: { status: optional(oneOf("success", "partial", "error")), errorCode: optional(string), attempt: optional(number), recovery: optional(string), failureKind: optional(string), retryable: optional(boolean), recovered: optional(boolean) },
  evaluation: { passed: boolean, failureRules: strings },
  replan: { count: number, reason: string, strategy: optional(string) },
  final: { success: boolean, status: oneOf("completed", "failed", "cancelled") },
  error: { message: optional(string), phase: optional(string), cancelled: optional(boolean), source: optional(string) },
  stage_update: { stage: string, index: number, total: number, data: optional(object), replan: optional(boolean) },
};

export type AgentEventDecodeResult =
  | { kind: "event"; event: AgentEvent }
  | { kind: "ignored"; reason: "unknown_event_type"; sequence: number }
  | { kind: "rejected"; reason: "unsupported_schema_version" | "invalid_event" };

/** 外部/持久化数据入口：v1 允许新增字段和类型，禁止猜测缺失或未来版本。 */
export function decodeAgentEvent(value: unknown): AgentEventDecodeResult {
  const invalid = { kind: "rejected", reason: "invalid_event" } as const;
  if (!object(value)) return invalid;
  if (value.schemaVersion !== 1) return { kind: "rejected", reason: "unsupported_schema_version" };
  if (!string(value.id) || !value.id || !string(value.type) || !number(value.timestamp)
    || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1
    || !object(value.scope) || !["runId", "sessionId", "traceId"].every(key => string(value.scope && (value.scope as Record<string, unknown>)[key]) && !!(value.scope as Record<string, unknown>)[key])
    || !string(value.category) || !object(value.payload)
    || !optional(string)(value.stepId) || !optional(string)(value.toolName) || !optional(number)(value.durationMs)) return invalid;
  if (!Object.hasOwn(rules, value.type as string)) return { kind: "ignored", reason: "unknown_event_type", sequence: value.sequence as number };
  const type = value.type as AgentEventType;
  if (value.category !== categoryForAgentEvent(type)) return invalid;
  const payload = value.payload;
  if (!Object.entries(rules[type]).every(([key, check]) => check(payload[key]))) return invalid;
  if (type === "tool_call" && !Object.hasOwn(payload, "input")) return invalid;
  return { kind: "event", event: value as unknown as AgentEvent };
}
