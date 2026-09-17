import { describe, expect, it, vi } from "vitest";
import type { ChannelRequest } from "../spec/channel.js";
import type { Submission } from "../src/runtime/submission.js";
import type { TraceEvent } from "../src/runtime/trace.js";
import { InMemoryRuntimeEventBus } from "../src/runtime/event-bus.js";
import {
  buildChannelRoutes,
  type HandlerDependencies,
} from "../src/server/handlers.js";

function makeRequest(
  query: Record<string, string>,
  signal?: AbortSignal,
): ChannelRequest {
  return {
    method: "GET",
    path: "/api/decide/stream",
    params: {},
    query,
    body: undefined,
    headers: {},
    clientIp: "127.0.0.1",
    ...(signal ? { signal } : {}),
  };
}

function createBlockingRuntime(
  onSubmit: (submission: Submission) => void,
): HandlerDependencies["runtime"] {
  return {
    submit: vi.fn(),
    submitSubmission: vi.fn(async (submission: Submission) => {
      onSubmit(submission);
      if (!submission.signal?.aborted) {
        await new Promise<void>((resolve) => {
          submission.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      return {
        submissionId: submission.id,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        status: "failed",
        error: String(submission.signal?.reason ?? "cancelled"),
      } as const;
    }),
  } as HandlerDependencies["runtime"];
}

function makeTrace(traceId: string, type: TraceEvent["type"]): TraceEvent {
  return {
    id: `${traceId}_${type}`,
    runId: "run_test",
    traceId,
    type,
    timestamp: Date.now(),
  };
}

describe("Runtime SSE adapter", () => {
  it("closes an SSE subscription when submission fails before final", async () => {
    const eventBus = new InMemoryRuntimeEventBus();
    const runtime = {
      submit: vi.fn(),
      submitSubmission: vi.fn(async (submission: Submission) => ({
        submissionId: submission.id,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        status: "failed" as const,
        error: "failed_before_run",
      })),
    } as HandlerDependencies["runtime"];
    const routes = buildChannelRoutes({
      runtime,
      eventBus,
      createId: () => "trace_test",
    });
    const route = routes.find((item) => item.path === "/api/decide/stream")!;
    const emitted: Array<{ event: string; data: unknown }> = [];

    await expect(route.stream!(makeRequest({ q: "test" }), (event, data) => {
      emitted.push({ event, data });
    })).resolves.toBeUndefined();

    expect(emitted.at(-1)).toMatchObject({ event: "error" });
    expect(eventBus.subscriberCount("trace_test")).toBe(0);
  });

  it("cancels the Runtime submission when the transport disconnects", async () => {
    const transport = new AbortController();
    let submittedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const runtime = createBlockingRuntime((submission) => {
      submittedSignal = submission.signal;
      markStarted();
    });
    const routes = buildChannelRoutes({
      runtime,
      eventBus: new InMemoryRuntimeEventBus(),
      createId: () => "trace_disconnect",
    });
    const stream = routes.find((item) => item.path === "/api/decide/stream")!.stream!;
    const pending = stream(
      makeRequest({ q: "test" }, transport.signal),
      () => undefined,
    );

    await started;
    transport.abort(new Error("client_disconnected"));
    await pending;

    expect(submittedSignal?.aborted).toBe(true);
    expect(submittedSignal?.reason).toEqual(new Error("client_disconnected"));
  });

  it("emits done only after the matching final runtime event", async () => {
    const eventBus = new InMemoryRuntimeEventBus();
    const runtime = {
      submit: vi.fn(),
      submitSubmission: vi.fn(async (submission: Submission) => {
        eventBus.publish(makeTrace("trace_other", "run_started"));
        eventBus.publish(makeTrace(submission.traceId, "run_started"));
        eventBus.publish(makeTrace(submission.traceId, "final"));
        return {
          submissionId: submission.id,
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          runId: "run_test",
          status: "completed" as const,
          result: {
            success: true,
            message: "ok",
            state: { stage: "fine_scheduling", planningNotes: [], errors: [] },
          },
        };
      }),
    } as HandlerDependencies["runtime"];
    const routes = buildChannelRoutes({
      runtime,
      eventBus,
      createId: () => "trace_test",
    });
    const stream = routes.find((item) => item.path === "/api/decide/stream")!.stream!;
    const emitted: Array<{ event: string; data: unknown }> = [];

    await stream(
      makeRequest({ q: "test" }),
      (event, data) => emitted.push({ event, data }),
    );

    const runtimeEvents = emitted.filter((item) => item.event === "runtime");
    expect(runtimeEvents.every((item) =>
      (item.data as TraceEvent).traceId === "trace_test")).toBe(true);
    expect(emitted.at(-1)?.event).toBe("done");
  });
});
