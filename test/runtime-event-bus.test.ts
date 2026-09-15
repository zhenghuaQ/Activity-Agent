import { describe, expect, it } from "vitest";
import { InMemoryRuntimeEventBus } from "../src/runtime/event-bus.js";
import type { TraceEvent } from "../src/runtime/trace.js";

function event(traceId: string, type: TraceEvent["type"]): TraceEvent {
  return {
    id: `${type}_1`,
    traceId,
    runId: "run_1",
    type,
    timestamp: Date.now(),
  };
}

describe("RuntimeEventBus", () => {
  it("按 traceId 路由，并按发布顺序提供异步事件", async () => {
    const bus = new InMemoryRuntimeEventBus();
    const sub = bus.subscribe("trace_a");

    bus.publish(event("trace_b", "run_started"));
    bus.publish(event("trace_a", "run_started"));
    bus.publish(event("trace_a", "final"));

    const first = await sub[Symbol.asyncIterator]().next();
    const second = await sub[Symbol.asyncIterator]().next();

    expect(first.value.type).toBe("run_started");
    expect(second.value.type).toBe("final");
    expect(bus.subscriberCount("trace_a")).toBe(1);

    sub.close();
    expect(bus.subscriberCount("trace_a")).toBe(0);
  });

  it("关闭订阅后不会继续收到事件", async () => {
    const bus = new InMemoryRuntimeEventBus();
    const sub = bus.subscribe("trace_a");
    const iterator = sub[Symbol.asyncIterator]();
    sub.close();

    const result = await iterator.next();
    expect(result.done).toBe(true);
  });
});
