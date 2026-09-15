// ============================================================
// src/runtime/trace.ts — Agent Runtime 统一 Trace 事件
// ============================================================

import { newAgentId, type AgentState } from "../../spec/agent.js";
import { defaultRuntimeEventBus } from "./event-bus.js";

export type TraceEventType =
  | "run_started"
  | "plan_created"
  | "step_started"
  | "step_finished"
  | "tool_call"
  | "tool_result"
  | "evaluation"
  | "replan"
  | "final"
  | "error"
  | "stage_update";

export interface TraceEvent {
  id: string;
  traceId: string;
  runId: string;
  type: TraceEventType;
  timestamp: number;
  stepId?: string;
  toolName?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface TraceCollector {
  emit(event: Omit<TraceEvent, "id" | "traceId" | "runId" | "timestamp">): TraceEvent;
  getEvents(): readonly TraceEvent[];
}

/**
 * 内存 Trace Collector。
 * v1 先作为 Run 级事件总线；后续可以替换为 OTEL / 日志 / DB sink。
 */
export class InMemoryTraceCollector implements TraceCollector {
  private readonly events: TraceEvent[] = [];

  constructor(
    private readonly traceId: string,
    private readonly runId: string,
  ) {}

  emit(
    event: Omit<TraceEvent, "id" | "traceId" | "runId" | "timestamp">,
  ): TraceEvent {
    const record: TraceEvent = {
      id: newAgentId("traceevt"),
      traceId: this.traceId,
      runId: this.runId,
      timestamp: Date.now(),
      ...event,
    };
    this.events.push(record);
    return record;
  }

  getEvents(): readonly TraceEvent[] {
    return this.events;
  }
}

export function appendTraceEvent(
  state: AgentState,
  event: Omit<TraceEvent, "id" | "traceId" | "runId" | "timestamp">,
): TraceEvent {
  const record: TraceEvent = {
    id: newAgentId("traceevt"),
    traceId: state.traceId,
    runId: state.runId,
    timestamp: Date.now(),
    ...event,
  };
  state.trace ??= [];
  state.trace.push(record);
  defaultRuntimeEventBus.publish(record);
  return record;
}
