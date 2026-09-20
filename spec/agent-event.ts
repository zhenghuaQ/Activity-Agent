// ============================================================
// spec/agent-event.ts — Agent 领域事件契约 v1
// ============================================================

import type { AgentRunStatus } from "./agent.js";
import type { FollowUpQuestion } from "./types.js";

export const AGENT_EVENT_SCHEMA_VERSION = 1 as const;

export type AgentEventType =
  | "run_created"
  | "run_started"
  | "run_status_changed"
  | "run_cancel_requested"
  | "follow_up_requested"
  | "follow_up_answered"
  | "plan_created"
  | "profile_resolved"
  | "step_started"
  | "step_finished"
  | "tool_call"
  | "tool_result"
  | "evaluation"
  | "replan"
  | "final"
  | "error"
  | "stage_update";

export type AgentEventCategory =
  | "lifecycle"
  | "planning"
  | "execution"
  | "tool"
  | "evaluation"
  | "progress";

export interface AgentEventScope {
  runId: string;
  sessionId: string;
  traceId: string;
}

type OpenPayload<T extends object> = T & Record<string, unknown>;

/** 每一种事件的 payload 契约；新增事件必须先在这里声明。 */
export interface AgentEventPayloadMap {
  follow_up_requested: OpenPayload<{ requestId: string; expiresAt: number; questions: FollowUpQuestion[] }>;
  follow_up_answered: OpenPayload<{ requestId: string; questionIds: string[] }>;
  run_created: OpenPayload<{ status: "pending" }>;
  /** @deprecated 使用 run_status_changed。 */
  run_started: OpenPayload<{ inputLength?: number; planner?: string }>;
  run_status_changed: OpenPayload<{
    previousStatus: AgentRunStatus;
    status: AgentRunStatus;
    reason?: string;
    source?: "runtime" | "planner" | "control" | "transport";
  }>;
  run_cancel_requested: OpenPayload<{
    reason: string;
    source: "control" | "transport";
  }>;
  plan_created: OpenPayload<{ planId: string; steps: string[] }>;
  profile_resolved: OpenPayload<{
    source: "explicit" | "inferred";
    segment: string;
    profileId?: string;
  }>;
  step_started: OpenPayload<{ stepType: string }>;
  step_finished: OpenPayload<{ stepType: string; status: AgentRunStatus }>;
  tool_call: OpenPayload<{ input: unknown; logicalCallId: string }>;
  tool_result: OpenPayload<{
    status?: "success" | "partial" | "error";
    errorCode?: string;
    attempt?: number;
    recovery?: string;
    failureKind?: string;
    retryable?: boolean;
    recovered?: boolean;
  }>;
  evaluation: OpenPayload<{ passed: boolean; failureRules: string[] }>;
  replan: OpenPayload<{ count: number; reason: string; strategy?: string }>;
  final: OpenPayload<{
    success: boolean;
    status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled">;
  }>;
  error: OpenPayload<{
    message?: string;
    phase?: string;
    cancelled?: boolean;
    source?: string;
  }>;
  stage_update: OpenPayload<{
    stage: string;
    index: number;
    total: number;
    data?: Record<string, unknown>;
    replan?: boolean;
  }>;
}

export interface AgentEventEnvelope<TType extends AgentEventType> {
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION;
  id: string;
  type: TType;
  category: AgentEventCategory;
  timestamp: number;
  sequence: number;
  scope: AgentEventScope;
  stepId?: string;
  toolName?: string;
  durationMs?: number;
  payload: AgentEventPayloadMap[TType];
}

/** 可判别联合：检查 type 后 payload 会自动收窄到对应契约。 */
export type AgentEventOf<TType extends AgentEventType> =
  TType extends AgentEventType ? AgentEventEnvelope<TType> : never;

export type AgentEvent = AgentEventOf<AgentEventType>;

export type AgentEventInput<TType extends AgentEventType = AgentEventType> =
  TType extends AgentEventType
    ? Omit<
        AgentEventEnvelope<TType>,
        "schemaVersion" | "id" | "category" | "timestamp" | "sequence" | "scope"
      >
    : never;

export function categoryForAgentEvent(type: AgentEventType): AgentEventCategory {
  switch (type) {
    case "run_started":
    case "run_created":
    case "run_status_changed":
    case "run_cancel_requested":
    case "follow_up_requested":
    case "follow_up_answered":
    case "final":
    case "error":
      return "lifecycle";
    case "plan_created":
    case "profile_resolved":
    case "replan":
      return "planning";
    case "step_started":
    case "step_finished":
      return "execution";
    case "tool_call":
    case "tool_result":
      return "tool";
    case "evaluation":
      return "evaluation";
    case "stage_update":
      return "progress";
  }
}
