import { describe, expect, expectTypeOf, it } from "vitest";
import type { AgentEvent } from "../spec/agent-event.js";
import { AgentRun } from "../src/runtime/agent-run.js";
import { InMemoryAgentEventBus } from "../src/runtime/event-bus.js";

describe("AgentRun aggregate", () => {
  it("重复完成幂等，冲突不会改写结果、状态和事件", () => {
    const run = AgentRun.create({ rawText: "test" });
    run.transition("running");
    const result = { success: true, message: "first", data: { value: 1 } };
    const final = run.finish("completed", result);
    const trace = [...run.state.trace];
    expect(run.finish("completed", structuredClone(result))).toBe(final);
    expect(() => run.finish("completed", { success: false, message: "second" })).toThrow("conflicting_agent_run_finish");
    expect(() => run.finish("failed", { success: false, message: "second" })).toThrow("conflicting_agent_run_finish");
    expect(run.state.result).toEqual(result);
    expect(run.state.trace).toEqual(trace);
    expect(run.projection.final).toEqual({ success: true, status: "completed" });
  });

  it("非法终结请求不留下部分修改", () => {
    const run = AgentRun.create({ rawText: "test" });
    expect(() => run.finish("completed", { success: true, message: "bad" })).toThrow("invalid_agent_run_transition");
    expect(run.state.status).toBe("pending");
    expect(run.state.result).toBeUndefined();
    expect(run.state.trace).toHaveLength(1);
  });

  it("owns state transitions and publishes through the injected EventBus", () => {
    const eventBus = new InMemoryAgentEventBus();
    const received: AgentEvent[] = [];
    eventBus.subscribe({
      id: "capture",
      matches: () => true,
      handle: (event) => { received.push(event); },
    });
    const run = AgentRun.create(
      { rawText: "test" },
      {
        runId: "run_lifecycle",
        sessionId: "session_lifecycle",
        traceId: "trace_lifecycle",
        eventBus,
      },
    );

    run.transition("running", { source: "runtime", reason: "started" });
    run.requestCancellation("user_requested", "control");
    run.finish(
      "cancelled",
      { success: false, message: "cancelled" },
      { source: "runtime", reason: "aborted" },
    );

    expect(run.state.status).toBe("cancelled");
    expect(received.map((event) => event.type)).toEqual([
      "run_created",
      "run_status_changed",
      "run_cancel_requested",
      "run_status_changed",
      "final",
    ]);
    expect(run.state.trace).toEqual(received);
    expect(received.at(-2)?.payload).toMatchObject({
      previousStatus: "running",
      status: "cancelled",
      source: "runtime",
    });
  });

  it("rejects invalid transitions from a terminal state", () => {
    const run = AgentRun.create({ rawText: "test" });
    run.transition("running");
    run.finish("completed", { success: true, message: "done" });

    expect(() => run.transition("running"))
      .toThrow("invalid_agent_run_transition:completed->running");
  });

  it("narrows payload types from the event discriminator", () => {
    const run = AgentRun.create({ rawText: "test" });
    const event = run.emit({
      type: "evaluation",
      payload: { passed: true, failureRules: [] },
    });

    expectTypeOf(event.payload.passed).toEqualTypeOf<boolean>();
    if (false) {
      // @ts-expect-error final 事件必须同时提供 status
      run.emit({ type: "final", payload: { success: true } });
      // @ts-expect-error 生命周期状态只能由 AgentRun 修改
      run.state.status = "failed";
    }
  });
});
