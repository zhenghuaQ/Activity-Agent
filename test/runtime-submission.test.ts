import { describe, expect, it, vi } from "vitest";
import { inboundUserInput } from "../spec/agent.js";
import type { LocationRequest } from "../spec/location.js";
import {
  AgentRuntime,
  InMemorySessionStore,
  SessionScheduler,
  createAgentInput,
  createSubmission,
  toAgentRunInput,
} from "../src/runtime/index.js";


describe("submission runtime", () => {
  it("packs input/session/trace/op into a submission", () => {
    const input = createAgentInput("test input");
    const submission = createSubmission(input, { sessionId: "sess_1", traceId: "trace_1" });

    expect(submission.id).toBeTruthy();
    expect(submission.input.id).toBe(input.id);
    expect(submission.sessionId).toBe("sess_1");
    expect(submission.traceId).toBe("trace_1");
    expect(submission.op.type).toBe("turn");
    expect(submission.sessionRetention).toBe("retained");
  });

  it("carries an explicit location context through submission normalization", () => {
    const context = { location: { kind: "coords" as const, lat: 31.23, lng: 121.47 } };
    const input = createAgentInput("上海周末计划", { context });
    const shorthand = createAgentInput("上海周末计划", { location: context.location });
    const submission = createSubmission(input, { sessionId: "sess_location" });

    expect(input.context).toEqual(context);
    expect(shorthand.context).toEqual(context);
    expect(toAgentRunInput(submission.input)).toMatchObject({
      rawText: "上海周末计划",
      context,
    });

    const direct = createSubmission(
      { rawText: "直接提交", context },
      { sessionId: "sess_location_direct" },
    );
    expect(toAgentRunInput(direct.input).context).toEqual(context);
  });

  it("keeps the legacy string-only input and all LocationRequest variants usable", () => {
    const legacy = createAgentInput("xxx");
    expect(legacy.content).toBe("xxx");
    expect(legacy.context).toBeUndefined();

    const requests: LocationRequest[] = [
      { kind: "coords", lat: 31.23, lng: 121.47 },
      { kind: "address", address: "上海市静安区" },
      { kind: "ip", ip: "203.0.113.1" },
      { kind: "default" },
    ];
    expect(requests).toHaveLength(4);
  });

  it("routes non-turn ops without entering the planning pipeline", async () => {
    const runtime = new AgentRuntime();
    const result = await runtime.submit("ping", {
      sessionId: "sess_health",
      op: { type: "health_check" },
    });

    expect(result.status).toBe("completed");
    expect(result.runId).toBeUndefined();
    expect(result.result).toEqual({ status: "ok" });
  });

  it("serializes submissions within one session but allows other sessions to start", async () => {
    const scheduler = new SessionScheduler();
    const order: string[] = [];

    const first = scheduler.runExclusive("A", async () => {
      order.push("A:start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("A:end");
    });

    const second = scheduler.runExclusive("A", async () => {
      order.push("A2:start");
      order.push("A2:end");
    });

    const other = scheduler.runExclusive("B", async () => {
      order.push("B:start");
      order.push("B:end");
    });

    await Promise.all([first, second, other]);

    expect(order.indexOf("A:start")).toBeLessThan(order.indexOf("A:end"));
    expect(order.indexOf("A:end")).toBeLessThan(order.indexOf("A2:start"));
    expect(order).toContain("B:start");
  });

  it("stores session messages across runs", () => {
    const store = new InMemorySessionStore();
    const session = store.getOrCreate("sess_1", "user_1");
    expect(session.messages).toHaveLength(0);
    expect(store.get("sess_1")?.userId).toBe("user_1");
  });

  it("bounds transcripts and evicts only inactive sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const store = new InMemorySessionStore({
      maxSessions: 2,
      idleTtlMs: 100,
      maxMessagesPerSession: 3,
    });
    store.getOrCreate("active");
    store.getOrCreate("expired");
    for (const text of ["one", "two", "three", "four"]) {
      store.appendMessage("active", inboundUserInput(text, "run_active"));
    }
    expect(store.get("active")?.messages.map((message) =>
      message.kind === "user_input" ? message.text : message.kind))
      .toEqual(["two", "three", "four"]);

    vi.setSystemTime(1_101);
    store.cleanup(new Set(["active"]), Date.now());
    expect(store.get("active")).toBeDefined();
    expect(store.get("expired")).toBeUndefined();
    expect(store.size()).toBe(1);
    vi.useRealTimers();
  });
});
