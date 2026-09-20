import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { AgentRuntime } from "../src/runtime/router.js";
import { createSessionSubmissionLoop } from "../src/runtime/submission-loop.js";
import { createSubmission } from "../src/runtime/submission.js";
import { SseWriter } from "../src/server/sse-writer.js";

afterEach(() => vi.useRealTimers());
describe("资源边界", () => {
  it("排队请求取消后立即移出队列，不执行其任务", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    const loop = createSessionSubmissionLoop("s", {
      executeTurn: async s => { starts++; await gate; return { submissionId: s.id, sessionId: s.sessionId, traceId: s.traceId, status: "completed" }; },
      executeControl: async () => { throw new Error("unused"); },
    });
    const first = loop.submit(createSubmission("first", { sessionId: "s" }));
    const controller = new AbortController();
    const queued = loop.submit(createSubmission("queued", { sessionId: "s", signal: controller.signal }));
    controller.abort();
    expect((await queued).error).toBe("submission_cancelled");
    expect(loop.queuedCount()).toBe(0);
    release(); await first; expect(starts).toBe(1); loop.stop();
  });

  it("任务队列满时拒绝 turn，control 仍可执行", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loop = createSessionSubmissionLoop("s", {
      executeTurn: async s => { await gate; return { submissionId: s.id, sessionId: s.sessionId, traceId: s.traceId, status: "completed" }; },
      executeControl: async s => ({ submissionId: s.id, sessionId: s.sessionId, traceId: s.traceId, status: "completed" }),
    }, { maxQueuedTurns: 1 });
    const first = loop.submit(createSubmission("first", { sessionId: "s" }));
    const second = loop.submit(createSubmission("second", { sessionId: "s" }));
    expect((await loop.submit(createSubmission("third", { sessionId: "s" }))).error).toBe("submission_queue_full");
    expect((await loop.submit(createSubmission("inspect", { sessionId: "s", op: { type: "inspect_run", runId: "r" } }))).status).toBe("completed");
    release(); await first; await second; loop.stop();
  });

  it("截止时间包含排队，运行中的任务收到 abort", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let signal!: AbortSignal;
    let starts = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loop = createSessionSubmissionLoop("s", {
      executeTurn: async (s, controller) => { starts++; signal = controller.signal; await gate; return { submissionId: s.id, sessionId: s.sessionId, traceId: s.traceId, status: "completed" }; },
      executeControl: async () => { throw new Error("unused"); },
    }, { deadlineMs: 10 });
    const first = loop.submit(createSubmission("first", { sessionId: "s" }));
    const second = loop.submit(createSubmission("second", { sessionId: "s" }));
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).error).toBe("submission_deadline_exceeded");
    expect((await second).error).toBe("submission_deadline_exceeded");
    expect(signal.aborted).toBe(true); expect(starts).toBe(1);
    release(); loop.stop();
  });

  it("超时答复不会提前释放仍在执行的并发额度", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtime = new AgentRuntime({ limits: { maxConcurrentRuns: 1, deadlineMs: 10 }, planner: {
      run: async (run, options) => {
        await gate;
        if (options?.signal?.aborted) throw new Error("aborted");
        const state = "state" in run ? run.state : run;
        return { success: true, message: "done", state: state.planning, agentState: state };
      },
    } });
    const first = runtime.submit("one", { sessionId: "s1" });
    await vi.advanceTimersByTimeAsync(10);
    expect((await first).error).toBe("submission_deadline_exceeded");
    expect(runtime.router.snapshot().activeRuns).toBe(1);
    expect((await runtime.submit("two", { sessionId: "s2" })).error).toBe("runtime_capacity");
    release();
    await vi.waitFor(() => expect(runtime.router.snapshot().activeRuns).toBe(0));
    expect(runtime.router.snapshot().sessions).toBe(0);
    runtime.shutdown();
  });

  it("SSE 遵守背压和顺序，并清理 drain 监听", async () => {
    const frames: string[] = [];
    const callbacks: Array<() => void> = [];
    const stream = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { frames.push(String(chunk)); callbacks.push(callback); } });
    const writer = new SseWriter(stream);
    const first = writer.send("stage", { n: 1 });
    const second = writer.send("done", { n: 2 });
    await Promise.resolve(); expect(frames).toHaveLength(1);
    callbacks[0](); await first;
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    callbacks[1](); await second; await writer.drain();
    expect(frames[0]).toContain("stage"); expect(frames[1]).toContain("done");
    expect(stream.listenerCount("drain")).toBe(0); stream.destroy();
  });

  it("SSE 容量和等待时间有上限", async () => {
    const stream = new Writable({ highWaterMark: 1, write() {} });
    const writer = new SseWriter(stream, 1000, 5);
    await expect(writer.send("stage", {})).rejects.toThrow("sse_drain_timeout");
    expect(stream.destroyed).toBe(true);
    const other = new Writable({ write(_c, _e, done) { done(); } });
    await expect(new SseWriter(other, 1).send("done", {})).rejects.toThrow("sse_buffer_capacity");
    expect(other.destroyed).toBe(true);
  });
});
