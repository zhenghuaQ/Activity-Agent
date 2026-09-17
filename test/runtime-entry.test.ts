import { describe, expect, it, vi } from "vitest";
import type { AgentState } from "../spec/agent.js";
import type { PlanResult } from "../src/planner/engine.js";
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

  it("releases an ephemeral session after its turn completes", async () => {
    const sessionStore = new InMemorySessionStore();
    const runtime = new AgentRuntime({ sessionStore });

    const result = await runtime.submit("朋友4人下午聚会逛展吃饭", {
      sessionId: "ephemeral-session",
      sessionRetention: "ephemeral",
    });

    expect(result.runId).toBeTruthy();
    expect(sessionStore.get("ephemeral-session")).toBeUndefined();
    runtime.shutdown();
  });

  it("rejects inspect and cancel from a foreign session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let announceRun!: (runId: string) => void;
    const started = new Promise<string>((resolve) => { announceRun = resolve; });
    const planner = {
      run: vi.fn(async (state: AgentState): Promise<PlanResult> => {
        announceRun(state.runId);
        await gate;
        state.status = "failed";
        state.result = { success: false, message: "fixture released" };
        return {
          success: false,
          state: state.planning,
          message: "fixture released",
          agentState: state,
        };
      }),
    };
    const runtime = new AgentRuntime({ planner });
    const activeTurn = runtime.submit("one", { sessionId: "session_a" });
    const runId = await started;

    const inspect = await runtime.submit("inspect", {
      sessionId: "session_b",
      op: { type: "inspect_run", runId },
    });
    const cancel = await runtime.submit("cancel", {
      sessionId: "session_b",
      op: { type: "cancel", runId },
    });

    expect(inspect).toMatchObject({ status: "rejected", error: "未找到可控制的运行。" });
    expect(cancel).toMatchObject({ status: "rejected", error: "未找到可控制的运行。" });
    release();
    await activeTurn;
    runtime.shutdown();
  });
});
