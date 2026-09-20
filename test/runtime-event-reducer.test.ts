import { describe, expect, it } from "vitest";
import { decodeAgentEvent } from "../spec/agent-event-compat.js";
import { AgentRun } from "../src/runtime/agent-run.js";
import { InMemoryAgentEventBus } from "../src/runtime/event-bus.js";
import { createAgentRunProjection, reduceAgentEvent, replayAgentEvents } from "../src/runtime/event-reducer.js";
import { createAgentEvent } from "../src/runtime/trace.js";

const scope = { runId: "run", sessionId: "session", traceId: "trace" };
const started = () => createAgentEvent(scope, 1, { type: "run_started", payload: { planner: "legacy" } });
const final = () => createAgentEvent(scope, 3, { type: "final", payload: { success: true, status: "completed" } });

describe("Event Reducer", () => {
  it("拒绝 previousStatus 不一致及非法迁移", () => {
    const state = replayAgentEvents([started()]);
    expect(() => reduceAgentEvent(state, createAgentEvent(scope, 2, {
      type: "run_status_changed", payload: { previousStatus: "pending", status: "running" },
    }))).toThrow("event_previous_status_mismatch");
    expect(() => reduceAgentEvent(state, createAgentEvent(scope, 2, {
      type: "run_status_changed", payload: { previousStatus: "running", status: "pending" },
    }))).toThrow("invalid_agent_run_transition");
  });

  it("DAG 并行步骤完成一个时保留其他活动步骤", () => {
    const projection = replayAgentEvents([
      started(),
      createAgentEvent(scope, 2, { type: "step_started", stepId: "a", payload: { stepType: "task" } }),
      createAgentEvent(scope, 3, { type: "step_started", stepId: "b", payload: { stepType: "task" } }),
      createAgentEvent(scope, 4, { type: "step_finished", stepId: "a", payload: { stepType: "task", status: "running" } }),
    ]);
    expect(projection.activeSteps).toEqual(["b"]);
    expect(projection.currentStep).toBe("b");
  });

  it("在线视图与 JSON trace 重放一致，发布时视图已更新", async () => {
    const bus = new InMemoryAgentEventBus();
    const run = AgentRun.create({ rawText: "test" }, { eventBus: bus });
    const subscription = bus.subscribe({ id: "view", matches: () => true, handle: event => { expect(run.projection.sequence).toBe(event.sequence); } });
    run.transition("running", { details: { status: "failed" } });
    run.emit({ type: "plan_created", payload: { planId: "plan", steps: ["parse"] } });
    run.emit({ type: "step_started", stepId: "parse", payload: { stepType: "parse" } });
    run.emit({ type: "stage_update", payload: { stage: "intent_parsing", index: 1, total: 5 } });
    run.emit({ type: "replan", payload: { count: 1, reason: "retry" } });
    run.requestCancellation("user");
    run.finish("cancelled", { success: false, message: "cancelled" }, {}, { status: "completed", success: true });
    const replayed = replayAgentEvents(JSON.parse(JSON.stringify(run.state.trace)));
    expect(run.projection).toEqual(replayed);
    expect(replayed).toMatchObject({ status: "cancelled", planId: "plan", replanCount: 1, cancellationRequested: true, final: { status: "cancelled", success: false } });
    expect(replayed.currentStep).toBeUndefined();
    expect((await subscription.drain()).failed).toBe(0);
  });

  it("纯函数与重复交付幂等，旧 run_started 可重放", () => {
    const initial = createAgentRunProjection();
    const event = started();
    const next = reduceAgentEvent(initial, event);
    expect(initial.sequence).toBe(0);
    expect(next.status).toBe("running");
    expect(reduceAgentEvent(next, event)).toBe(next);
    expect(() => reduceAgentEvent(next, { ...event, sequence: 2 })).toThrow("event_identity_conflict");
    expect(() => reduceAgentEvent(next, { ...event, id: "other" })).toThrow("event_out_of_order");
    expect(() => reduceAgentEvent(next, { ...final(), scope: { ...scope, runId: "other" } })).toThrow("event_scope_mismatch");
  });

  it("终态后拒绝状态回退及冲突的 final", () => {
    const done = replayAgentEvents([started(), final()]);
    expect(() => reduceAgentEvent(done, createAgentEvent(scope, 4, {
      type: "run_status_changed", payload: { previousStatus: "completed", status: "running" },
    }))).toThrow("event_after_final");
    expect(() => reduceAgentEvent(done, createAgentEvent(scope, 4, {
      type: "final", payload: { success: false, status: "failed" },
    }))).toThrow("conflicting_final_event");
  });
});

describe("事件兼容策略", () => {
  it("v1 保留额外字段，跳过未知类型（含原型属性名），允许序号间隙", () => {
    const first = started();
    const extended = { ...first, extension: 1, payload: { ...first.payload, future: true } };
    expect(decodeAgentEvent(extended)).toEqual({ kind: "event", event: extended });
    const unknown = { ...first, id: "new", type: "future_event", sequence: 2 };
    expect(decodeAgentEvent(unknown)).toEqual({ kind: "ignored", reason: "unknown_event_type", sequence: 2 });
    expect(decodeAgentEvent({ ...unknown, type: "toString" }).kind).toBe("ignored");
    expect(replayAgentEvents([extended, unknown, final()]).status).toBe("completed");
  });

  it("未来/缺失版本及畸形 payload 明确拒绝", () => {
    const event = final();
    for (const schemaVersion of [undefined, 0, 2, "1"]) {
      expect(decodeAgentEvent({ ...event, schemaVersion })).toEqual({ kind: "rejected", reason: "unsupported_schema_version" });
    }
    for (const patch of [{ sequence: 0 }, { scope: {} }, { category: "tool" }, { payload: {} }, { payload: { success: "yes", status: "completed" } }]) {
      expect(decodeAgentEvent({ ...event, ...patch })).toEqual({ kind: "rejected", reason: "invalid_event" });
    }
    expect(() => replayAgentEvents([{ ...event, schemaVersion: 2 }])).toThrow("unsupported_schema_version");
  });
});
