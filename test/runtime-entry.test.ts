import { describe, expect, it, vi } from "vitest";
import type { AgentState } from "../spec/agent.js";
import type { PlanResult } from "../src/planner/engine.js";
import {
  AgentRuntime,
  AgentRun,
  createAgentInput,
  createSubmission,
  InMemoryAgentEventBus,
  InMemorySessionStore,
} from "../src/runtime/index.js";

describe("AgentRuntime canonical entry", () => {
  it("publishes only to its injected EventBus", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const eventTypes: string[] = [];
    eventBus.subscribe({
      id: "runtime-capture",
      matches: () => true,
      handle: (event) => { eventTypes.push(event.type); },
    });
    const planner = {
      run: vi.fn(async (run: AgentRun): Promise<PlanResult> => {
        run.finish("completed", { success: true, message: "ok" });
        return {
          success: true,
          state: run.state.planning,
          message: "ok",
          agentState: run.state,
        };
      }),
    };
    const runtime = new AgentRuntime({ eventBus, planner });

    await runtime.submit("test", { sessionId: "injected-bus" });

    expect(eventTypes).toEqual([
      "run_created",
      "run_status_changed",
      "run_status_changed",
      "final",
    ]);
    expect(runtime.eventBus).toBe(eventBus);
    runtime.shutdown();
  });

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
    const pipelineResult = result.result as PlanResult;
    expect(pipelineResult.agentState.messages[0]).toMatchObject({
      direction: "inbound",
      kind: "user_input",
      runId: pipelineResult.agentState.runId,
    });
    expect(pipelineResult.agentState.messages.at(-1)).toMatchObject({
      direction: "outbound",
      kind: "decision",
      runId: pipelineResult.agentState.runId,
    });
    expect(pipelineResult.agentState.trace.filter((event) => event.type === "final"))
      .toHaveLength(1);
    expect(pipelineResult.agentState.trace[0]).toMatchObject({
      type: "run_created",
      sequence: 1,
      payload: { status: "pending" },
    });
    const lifecycleTransitions = pipelineResult.agentState.trace.filter((event) =>
      event.type === "run_status_changed"
    ).map((event) => [event.payload?.previousStatus, event.payload?.status]);
    expect(lifecycleTransitions[0]).toEqual(["pending", "running"]);
    expect(lifecycleTransitions.at(-1)).toEqual(["running", pipelineResult.agentState.status]);
    expect(pipelineResult.agentState.trace.map((event) => event.sequence)).toEqual(
      pipelineResult.agentState.trace.map((_, index) => index + 1),
    );
    expect(session?.messages.map((message) => message.id)).toEqual(
      pipelineResult.agentState.messages.map((message) => message.id),
    );

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
      run: vi.fn(async (run: AgentRun): Promise<PlanResult> => {
        const state = run.state;
        announceRun(state.runId);
        await gate;
        run.finish("failed", { success: false, message: "fixture released" });
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

  it("publishes cancellation intent and terminal lifecycle events", async () => {
    let capturedState!: AgentState;
    let announceRun!: (runId: string) => void;
    const started = new Promise<string>((resolve) => { announceRun = resolve; });
    const planner = {
      run: vi.fn(async (run: AgentRun, opts: { signal?: AbortSignal }): Promise<PlanResult> => {
        const state = run.state;
        capturedState = state;
        announceRun(state.runId);
        await new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
        });
        throw new Error("unreachable");
      }),
    };
    const runtime = new AgentRuntime({ planner });
    const activeTurn = runtime.submit("one", { sessionId: "session_cancel" });
    const runId = await started;

    const cancel = await runtime.submit("cancel", {
      sessionId: "session_cancel",
      op: { type: "cancel", runId },
    });
    const result = await activeTurn;

    expect(cancel).toMatchObject({ status: "completed", result: { cancelled: true } });
    expect(result.status).toBe("failed");
    expect(capturedState.status).toBe("cancelled");
    expect(capturedState.trace.filter((event) => event.type === "run_cancel_requested"))
      .toHaveLength(1);
    expect(capturedState.trace.at(-1)).toMatchObject({
      type: "final",
      payload: { status: "cancelled", success: false },
    });
    runtime.shutdown();
  });
});
