import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  createAgentInput,
  createSubmission,
  InMemorySessionStore,
} from "../src/runtime/index.js";

describe("AgentRuntime canonical entry", () => {
  it("routes a turn through Submission -> Session Loop -> AgentRun", async () => {
    const sessionStore = new InMemorySessionStore();
    const runtime = new AgentRuntime({ sessionStore });

    const result = await runtime.submit(
      createAgentInput("朋友4人下午聚会逛展吃饭", {
        parseFn: () => ({
          group: { totalPeople: 4, leadRole: "friend", scenario: "gathering" },
        } as never),
      }),
      { sessionId: "entry-session" },
    );

    expect(result.submissionId).toBeTruthy();
    expect(result.sessionId).toBe("entry-session");
    expect(result.runId).toBeTruthy();

    const session = sessionStore.get("entry-session");
    expect(session?.messages.length).toBeGreaterThan(0);

    runtime.shutdown();
  });

  it("keeps different sessions isolated", async () => {
    const sessionStore = new InMemorySessionStore();
    const runtime = new AgentRuntime({ sessionStore });

    const [a, b] = await Promise.all([
      runtime.submit("朋友4人下午聚会逛展吃饭", { sessionId: "session-a" }),
      runtime.submit("情侣周末下午约会拍照", { sessionId: "session-b" }),
    ]);

    expect(a.sessionId).toBe("session-a");
    expect(b.sessionId).toBe("session-b");
    expect(a.runId).not.toBe(b.runId);
    expect(sessionStore.get("session-a")?.messages.length).toBeGreaterThan(0);
    expect(sessionStore.get("session-b")?.messages.length).toBeGreaterThan(0);

    runtime.shutdown();
  });

  it("supports prebuilt submissions without bypassing the runtime router", async () => {
    const runtime = new AgentRuntime();
    const submission = createSubmission("朋友4人下午聚会逛展吃饭", {
      sessionId: "prebuilt-session",
      op: { type: "health_check" },
    });

    const result = await runtime.submitSubmission(submission);
    expect(result.status).toBe("completed");
    expect(result.runId).toBeUndefined();

    runtime.shutdown();
  });
});
