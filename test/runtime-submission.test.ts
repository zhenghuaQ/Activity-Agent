import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  InMemorySessionStore,
  SessionScheduler,
  createAgentInput,
  createSubmission,
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
});
