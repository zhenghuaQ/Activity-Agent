import type { AgentEvent, AgentEventScope } from "../../spec/agent-event.js";
import { decodeAgentEvent } from "../../spec/agent-event-compat.js";
import type { AgentRunStatus } from "../../spec/agent.js";
import { assertRunTransition } from "../../spec/run-lifecycle.js";

/** 可重放的运行视图；不声称恢复输入、工具返回正文或完整业务状态。 */
export interface AgentRunProjection {
  readonly scope?: AgentEventScope;
  readonly sequence: number;
  readonly seen: Readonly<Record<string, number>>;
  readonly status: AgentRunStatus;
  readonly cancellationRequested: boolean;
  readonly pendingInput?: { requestId: string; expiresAt: number; questionIds: string[] };
  readonly currentStep?: string;
  readonly activeSteps: readonly string[];
  readonly planId?: string;
  readonly stage?: string;
  readonly replanCount: number;
  readonly final?: { success: boolean; status: AgentRunStatus };
  readonly errors: readonly string[];
}

export function createAgentRunProjection(): AgentRunProjection {
  return { sequence: 0, seen: {}, status: "pending", cancellationRequested: false, activeSteps: [], replanCount: 0, errors: [] };
}

/** 纯函数：同 ID/sequence 幂等，倒序拒绝；允许过滤/未知事件导致的序号间隙。 */
export function reduceAgentEvent(state: AgentRunProjection, event: AgentEvent): AgentRunProjection {
  if (state.scope && (state.scope.runId !== event.scope.runId || state.scope.traceId !== event.scope.traceId || state.scope.sessionId !== event.scope.sessionId)) throw new Error("event_scope_mismatch");
  if (Object.hasOwn(state.seen, event.id)) {
    if (state.seen[event.id] !== event.sequence) throw new Error("event_identity_conflict");
    return state;
  }
  if (event.sequence <= state.sequence) throw new Error("event_out_of_order");
  const next = { ...state, scope: { ...event.scope }, sequence: event.sequence, seen: { ...state.seen, [event.id]: event.sequence } };
  const terminal = ["completed", "failed", "cancelled"].includes(state.status);
  switch (event.type) {
    case "run_created": return next;
    case "run_started": return terminal ? next : { ...next, status: "running" }; // v1 旧事件
    case "run_status_changed":
      if (terminal && event.payload.status !== state.status) throw new Error("event_after_final");
      if (event.payload.previousStatus !== state.status) throw new Error("event_previous_status_mismatch");
      assertRunTransition(event.payload.previousStatus, event.payload.status);
      return { ...next, status: event.payload.status };
    case "run_cancel_requested": return { ...next, cancellationRequested: true };
    case "follow_up_requested":
      if (state.status !== "waiting_input" || state.pendingInput) throw new Error("invalid_follow_up_request_event");
      return { ...next, pendingInput: { requestId: event.payload.requestId, expiresAt: event.payload.expiresAt, questionIds: event.payload.questions.map(q => q.id) } };
    case "follow_up_answered":
      if (state.status !== "waiting_input" || state.pendingInput?.requestId !== event.payload.requestId) throw new Error("invalid_follow_up_answer_event");
      return { ...next, pendingInput: undefined };
    case "plan_created": return { ...next, planId: event.payload.planId };
    case "step_started": {
      if (terminal) return next;
      const step = event.stepId ?? event.payload.stepType;
      return { ...next, currentStep: step, activeSteps: [...state.activeSteps.filter(id => id !== step), step] };
    }
    case "step_finished": {
      const activeSteps = state.activeSteps.filter(id => id !== (event.stepId ?? event.payload.stepType));
      return { ...next, activeSteps, currentStep: activeSteps.at(-1) };
    }
    case "stage_update": return { ...next, stage: event.payload.stage };
    case "replan": return { ...next, replanCount: event.payload.count };
    case "error": return event.payload.message ? { ...next, errors: [...state.errors, event.payload.message] } : next;
    case "final":
      if (event.payload.success !== (event.payload.status === "completed")) throw new Error("invalid_agent_run_result");
      if (terminal && state.status !== event.payload.status) throw new Error("conflicting_final_event");
      if (state.final && (state.final.status !== event.payload.status || state.final.success !== event.payload.success)) throw new Error("conflicting_final_event");
      return { ...next, status: event.payload.status, pendingInput: undefined, currentStep: undefined, activeSteps: [], final: { success: event.payload.success, status: event.payload.status } };
    default: return next;
  }
}

/** 可用于从 JSON trace 重建视图；未知 v1 类型跳过，非法/未来版本显式拒绝。 */
export function replayAgentEvents(events: readonly unknown[]): AgentRunProjection {
  let state = createAgentRunProjection();
  for (const raw of events) {
    const decoded = decodeAgentEvent(raw);
    if (decoded.kind === "rejected") throw new Error(decoded.reason);
    if (decoded.kind === "event") state = reduceAgentEvent(state, decoded.event);
  }
  return state;
}
