import { describe, expect, it } from "vitest";
import {
  appendAgentEvent,
  InMemoryAgentEventCollector,
} from "../src/runtime/trace.js";
import { createAgentState } from "../spec/agent.js";

describe("AgentEvent", () => {
  it("records a versioned event envelope with complete correlation scope", () => {
    const state = createAgentState(
      { rawText: "test" },
      { runId: "run_1", sessionId: "sess_1", traceId: "trace_1" },
    );

    const event = appendAgentEvent(state, {
      type: "run_started",
      payload: { test: true },
    });

    expect(state.trace).toHaveLength(1);
    expect(event).toMatchObject({
      schemaVersion: 1,
      category: "lifecycle",
      type: "run_started",
      sequence: 1,
      scope: { runId: "run_1", sessionId: "sess_1", traceId: "trace_1" },
      payload: { test: true },
    });
  });

  it("keeps monotonically ordered events in the in-memory collector", () => {
    const collector = new InMemoryAgentEventCollector("trace_2", "run_2", "sess_2");
    collector.emit({ type: "run_started", payload: { planner: "test" } });
    collector.emit({ type: "plan_created", payload: { planId: "p1", steps: [] } });
    collector.emit({ type: "final", payload: { success: true, status: "completed" } });

    const events = collector.getEvents();
    expect(events.map((item) => item.type)).toEqual([
      "run_started",
      "plan_created",
      "final",
    ]);
    expect(events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(events.every((item) =>
      item.scope.runId === "run_2"
      && item.scope.sessionId === "sess_2"
      && item.scope.traceId === "trace_2"
    )).toBe(true);
  });
});
