import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../spec/agent-event.js";
import {
  InMemoryAgentEventBus,
  type AgentEventSubscriber,
} from "../src/runtime/event-bus.js";
import { createAgentEvent } from "../src/runtime/trace.js";

function event(traceId: string, type: "run_started" | "final", sequence = 1): AgentEvent {
  const scope = { traceId, runId: "run_1", sessionId: "session_1" };
  return type === "final"
    ? createAgentEvent(scope, sequence, {
        type,
        payload: { success: true, status: "completed" },
      })
    : createAgentEvent(scope, sequence, {
        type,
        payload: { planner: "test" },
      });
}

describe("AgentEventBus", () => {
  it("异步订阅者串行执行，拒绝隔离且不阻塞同步订阅者", async () => {
    const bus = new InMemoryAgentEventBus();
    const received: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow = bus.subscribe({
      id: "slow", matches: () => true,
      handle: async e => { received.push(e.sequence); if (e.sequence === 1) { await gate; throw new Error("async_failure"); } },
      onError: async () => { throw new Error("reporter_failure"); },
    });
    const fast: number[] = [];
    bus.subscribe({ id: "fast", matches: () => true, handle: e => { fast.push(e.sequence); } });
    bus.publish(event("trace", "run_started", 1));
    bus.publish(event("trace", "final", 2));
    expect(received).toEqual([1]);
    expect(fast).toEqual([1, 2]);
    slow.close();
    bus.publish(event("trace", "final", 3));
    release();
    expect(await slow.drain()).toMatchObject({ delivered: 1, failed: 1, rejected: 0, errorHandlerFailures: 1 });
    expect(received).toEqual([1, 2]);
  });

  it("队列溢出显式计入拒绝，drain 超时后仍可等待完成", async () => {
    const bus = new InMemoryAgentEventBus(1);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sub = bus.subscribe({ id: "bounded", matches: () => true, handle: () => gate });
    bus.publish(event("trace", "run_started", 1));
    bus.publish(event("trace", "final", 2));
    await expect(sub.drain(1)).rejects.toThrow("subscriber_drain_timeout");
    release();
    expect(await sub.drain()).toMatchObject({ delivered: 1, rejected: 1, pending: 0 });
    expect(bus.snapshot()).toMatchObject({ delivered: 1, rejected: 1, pending: 0 });
  });

  it("重入发布不打乱其他订阅者的事件顺序", () => {
    const bus = new InMemoryAgentEventBus();
    const received: number[] = [];
    bus.subscribe({ id: "publisher", matches: () => true, handle: e => { if (e.sequence === 1) bus.publish(event("trace", "final", 2)); } });
    bus.subscribe({ id: "observer", matches: () => true, handle: e => { received.push(e.sequence); } });
    bus.publish(event("trace", "run_started", 1));
    expect(received).toEqual([1, 2]);
  });

  it("过滤异常记录为拒绝，关闭幂等且可重新注册", async () => {
    const bus = new InMemoryAgentEventBus();
    const subscriber = { id: "filter", matches: () => { throw new Error("bad_filter"); }, handle: () => {} };
    const sub = bus.subscribe(subscriber);
    expect(() => bus.subscribe(subscriber)).toThrow("duplicate_agent_event_subscriber");
    bus.publish(event("trace", "final"));
    expect(await sub.drain()).toMatchObject({ delivered: 0, rejected: 1 });
    sub.close(); sub.close();
    const fresh = bus.subscribe(subscriber);
    sub.close();
    expect(fresh.closed).toBe(false);
    expect(bus.subscriberCount()).toBe(1);
  });

  it("向多个 Subscriber 按注册和发布顺序扇出，并由 Subscriber 自行过滤", () => {
    const bus = new InMemoryAgentEventBus();
    const traceEvents: string[] = [];
    const lifecycleEvents: string[] = [];
    const traceSubscriber: AgentEventSubscriber = {
      id: "trace-a",
      matches: (item) => item.scope.traceId === "trace_a",
      handle: (item) => { traceEvents.push(item.type); },
    };
    const lifecycleSubscriber: AgentEventSubscriber = {
      id: "all-lifecycle",
      matches: (item) => item.category === "lifecycle",
      handle: (item) => { lifecycleEvents.push(`${item.scope.traceId}:${item.type}`); },
    };
    const traceSubscription = bus.subscribe(traceSubscriber);
    bus.subscribe(lifecycleSubscriber);

    bus.publish(event("trace_b", "run_started"));
    bus.publish(event("trace_a", "run_started"));
    bus.publish(event("trace_a", "final", 2));

    expect(traceEvents).toEqual(["run_started", "final"]);
    expect(lifecycleEvents).toEqual([
      "trace_b:run_started",
      "trace_a:run_started",
      "trace_a:final",
    ]);
    expect(bus.subscriberCount()).toBe(2);

    traceSubscription.close();
    expect(traceSubscription.closed).toBe(true);
    expect(bus.subscriberCount()).toBe(1);
  });

  it("隔离 Subscriber 异常，不影响后续 Subscriber", () => {
    const bus = new InMemoryAgentEventBus();
    const errors: unknown[] = [];
    const received: string[] = [];
    bus.subscribe({
      id: "broken",
      matches: () => true,
      handle: () => { throw new Error("subscriber_failed"); },
      onError: (error) => { errors.push(error); },
    });
    bus.subscribe({
      id: "healthy",
      matches: () => true,
      handle: (item) => { received.push(item.type); },
    });

    bus.publish(event("trace_a", "final"));

    expect(errors).toHaveLength(1);
    expect(received).toEqual(["final"]);
  });
});
