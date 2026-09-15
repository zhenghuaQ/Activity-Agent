import { describe, expect, it } from "vitest";
import { appendTraceEvent, InMemoryTraceCollector } from "../src/runtime/trace.js";
import { createAgentState } from "../spec/agent.js";

describe("runtime trace", () => {
  it("records events on AgentState with run/trace correlation", () => {
    const state = createAgentState(
      { rawText: "test" },
      { runId: "run_1", sessionId: "sess_1", traceId: "trace_1" },
    );

    const event = appendTraceEvent(state, {
      type: "run_started",
      metadata: { test: true },
    });

    expect(state.trace).toHaveLength(1);
    expect(event.runId).toBe("run_1");
    expect(event.traceId).toBe("trace_1");
    expect(event.type).toBe("run_started");
  });

  it("keeps an ordered in-memory event stream", () => {
    const collector = new InMemoryTraceCollector("trace_2", "run_2");
    collector.emit({ type: "run_started" });
    collector.emit({ type: "plan_created", metadata: { planId: "p1" } });
    collector.emit({ type: "final", metadata: { success: true } });

    const events = collector.getEvents();
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "plan_created",
      "final",
    ]);
    expect(events.every((event) => event.runId === "run_2" && event.traceId === "trace_2")).toBe(true);
  });
});
