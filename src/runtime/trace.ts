// ============================================================
// src/runtime/trace.ts — AgentEvent 创建与 Run 内收集
// ============================================================

import {
  AGENT_EVENT_SCHEMA_VERSION,
  categoryForAgentEvent,
  type AgentEvent,
  type AgentEventInput,
  type AgentEventOf,
  type AgentEventType,
} from "../../spec/agent-event.js";
import { newAgentId, type AgentState } from "../../spec/agent.js";
import { reduceAgentEvent, replayAgentEvents, type AgentRunProjection } from "./event-reducer.js";
import {
  defaultAgentEventBus,
  type AgentEventBus,
} from "./event-bus.js";

const eventBuses = new WeakMap<AgentState, AgentEventBus>();
const projections = new WeakMap<AgentState, AgentRunProjection>();

export function getAgentRunProjection(state: AgentState): AgentRunProjection {
  let projection = projections.get(state);
  if (!projection) {
    projection = replayAgentEvents(state.trace ?? []);
    projections.set(state, projection);
  }
  return projection;
}

export interface AgentEventCollector {
  emit(event: AgentEventInput): AgentEvent;
  getEvents(): readonly AgentEvent[];
}

/** 独立的内存收集器，适合测试和不经过 AgentState 的运行。 */
export class InMemoryAgentEventCollector implements AgentEventCollector {
  private readonly events: AgentEvent[] = [];

  constructor(
    private readonly traceId: string,
    private readonly runId: string,
    private readonly sessionId = "standalone",
  ) {}

  emit(event: AgentEventInput): AgentEvent {
    const record = createAgentEvent(
      { traceId: this.traceId, runId: this.runId, sessionId: this.sessionId },
      this.events.length + 1,
      event,
    );
    this.events.push(record);
    return record;
  }

  getEvents(): readonly AgentEvent[] {
    return this.events;
  }
}

export function createAgentEvent<TType extends AgentEventType>(
  scope: AgentEvent["scope"],
  sequence: number,
  event: AgentEventInput<TType>,
): AgentEventOf<TType> {
  return {
    schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
    id: newAgentId("agentevt"),
    category: categoryForAgentEvent(event.type),
    timestamp: Date.now(),
    sequence,
    scope,
    ...event,
  } as AgentEventOf<TType>;
}

/** 把一次 Run 显式绑定到注入的 EventBus。 */
export function bindAgentEventBus(state: AgentState, eventBus: AgentEventBus): void {
  eventBuses.set(state, eventBus);
}

/** 追加到 AgentState，并发布给该 Run 注入的 EventBus。 */
export function appendAgentEvent<TType extends AgentEventType>(
  state: AgentState,
  event: AgentEventInput<TType>,
  commit?: () => void,
): AgentEventOf<TType> {
  state.trace ??= [];
  const record = createAgentEvent(
    { traceId: state.traceId, runId: state.runId, sessionId: state.sessionId },
    state.trace.length + 1,
    event,
  );
  const projection = reduceAgentEvent(getAgentRunProjection(state), record);
  commit?.();
  state.trace.push(record);
  projections.set(state, projection);
  (eventBuses.get(state) ?? defaultAgentEventBus).publish(record);
  return record;
}
