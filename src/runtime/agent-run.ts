// ============================================================
// src/runtime/agent-run.ts — Agent Run 聚合根
// ============================================================

import type {
  AgentEventInput,
  AgentEventOf,
  AgentEventType,
} from "../../spec/agent-event.js";
import { isDeepStrictEqual } from "node:util";
import { assertRunTransition } from "../../spec/run-lifecycle.js";
import {
  createAgentState,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRunStatus,
  type AgentState,
  type RunId,
  type SessionId,
  type TraceId,
} from "../../spec/agent.js";
import {
  defaultAgentEventBus,
  type AgentEventBus,
} from "./event-bus.js";
import { appendAgentEvent, bindAgentEventBus, getAgentRunProjection } from "./trace.js";

type MutableAgentState = Omit<AgentState, "status"> & { status: AgentRunStatus };
type TerminalRunStatus = Extract<AgentRunStatus, "completed" | "failed" | "cancelled">;

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "failed", "cancelled"]);

const aggregates = new WeakMap<AgentState, AgentRun>();

export interface AgentRunTransitionContext {
  reason?: string;
  source?: "runtime" | "planner" | "control" | "transport";
  details?: Record<string, unknown>;
}

export interface CreateAgentRunOptions {
  runId?: RunId;
  sessionId?: SessionId;
  traceId?: TraceId;
  eventBus?: AgentEventBus;
}

/**
 * 一次 Agent 执行的聚合根：拥有运行状态、生命周期迁移和事件发布能力。
 * AgentState.status 对外只读，只有本聚合可以改变它。
 */
export class AgentRun {
  private readonly mutableState: MutableAgentState;

  constructor(
    state: AgentState,
    readonly eventBus: AgentEventBus = defaultAgentEventBus,
  ) {
    this.mutableState = state as MutableAgentState;
    bindAgentEventBus(state, eventBus);
    aggregates.set(state, this);
    this.ensureCreated();
  }

  static create(input: AgentRunInput, options: CreateAgentRunOptions = {}): AgentRun {
    const state = createAgentState(input, options);
    return new AgentRun(state, options.eventBus ?? defaultAgentEventBus);
  }

  static fromState(
    state: AgentState,
    eventBus: AgentEventBus = defaultAgentEventBus,
  ): AgentRun {
    return aggregates.get(state) ?? new AgentRun(state, eventBus);
  }

  get state(): AgentState {
    return this.mutableState;
  }

  get projection() {
    return getAgentRunProjection(this.mutableState);
  }

  emit<TType extends AgentEventType>(
    event: AgentEventInput<TType>,
  ): AgentEventOf<TType> {
    return appendAgentEvent(this.mutableState, event);
  }

  ensureCreated(): void {
    if (this.mutableState.trace.some((event) => event.type === "run_created")) return;
    this.emit({
      type: "run_created",
      payload: { status: "pending" },
    });
  }

  transition(
    nextStatus: AgentRunStatus,
    context: AgentRunTransitionContext = {},
  ): void {
    this.applyTransition(nextStatus, context);
  }

  private applyTransition(nextStatus: AgentRunStatus, context: AgentRunTransitionContext, commit?: () => void): void {
    const previousStatus = this.mutableState.status;
    if (this.projection.status !== previousStatus) throw new Error("agent_run_projection_mismatch");
    if (previousStatus === nextStatus) { commit?.(); return; }
    assertRunTransition(previousStatus, nextStatus);
    appendAgentEvent(this.mutableState, {
      type: "run_status_changed",
      payload: {
        ...context.details,
        previousStatus,
        status: nextStatus,
        reason: context.reason,
        source: context.source,
      },
    }, () => { this.mutableState.status = nextStatus; commit?.(); });
  }

  requestCancellation(
    reason: string,
    source: "control" | "transport" = "control",
  ): void {
    if (this.mutableState.trace.some((event) => event.type === "run_cancel_requested")) return;
    this.emit({ type: "run_cancel_requested", payload: { reason, source } });
  }

  finish(
    status: TerminalRunStatus,
    result: AgentRunResult,
    context: AgentRunTransitionContext = {},
    payload: Record<string, unknown> = {},
  ): AgentEventOf<"final"> {
    const existing = this.mutableState.trace.find(
      (event): event is AgentEventOf<"final"> => event.type === "final",
    );
    if (existing) {
      if (existing.payload.status !== status || !isDeepStrictEqual(this.mutableState.result, result)) {
        throw new Error("conflicting_agent_run_finish");
      }
      return existing;
    }
    if (result.success !== (status === "completed")) throw new Error("invalid_agent_run_result");
    this.applyTransition(status, context, () => { this.mutableState.result = result; });
    return this.emit({
      type: "final",
      payload: { ...payload, success: result.success, status },
    });
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.mutableState.status);
  }
}
