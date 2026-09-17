import { describe, expect, it } from "vitest";
import { createSessionSubmissionLoop } from "../src/runtime/index.js";
import { createAgentInput, createSubmission } from "../src/runtime/index.js";

describe("session submission loop", () => {
  it("serializes turns while allowing control ops to preempt a running turn", async () => {
    const events: string[] = [];
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });

    const loop = createSessionSubmissionLoop("sess_loop", {
      executeTurn: async (submission) => {
        events.push(`turn:start:${submission.input.content}`);
        await turnGate;
        events.push(`turn:end:${submission.input.content}`);
        return {
          submissionId: submission.id,
          status: "completed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          result: submission.input.content,
        };
      },
      executeControl: async (submission) => {
        events.push(`control:${submission.op.type}`);
        return {
          submissionId: submission.id,
          status: "completed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          result: { ok: true },
        };
      },
    });

    const turn1 = loop.submit(createSubmission(createAgentInput("one"), { sessionId: "sess_loop" }));
    await Promise.resolve();
    const turn2 = loop.submit(createSubmission(createAgentInput("two"), { sessionId: "sess_loop" }));
    const inspect = loop.submit(createSubmission("inspect", {
      sessionId: "sess_loop",
      op: { type: "inspect_run", runId: "run_x" },
    }));

    await inspect;
    expect(events).toEqual(["turn:start:one", "control:inspect_run"]);

    releaseTurn();
    await turn1;
    const result2 = await turn2;
    expect(result2.status).toBe("completed");
    expect(events).toEqual([
      "turn:start:one",
      "control:inspect_run",
      "turn:end:one",
      "turn:start:two",
      "turn:end:two",
    ]);

    loop.stop();
  });

  it("passes one AbortController to a turn so cancel can signal the active run", async () => {
    let controllerFromLoop: AbortController | undefined;
    const loop = createSessionSubmissionLoop("sess_cancel", {
      executeTurn: async (_submission, controller) => {
        controllerFromLoop = controller;
        await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        return {
          submissionId: _submission.id,
          status: "failed",
          sessionId: _submission.sessionId,
          traceId: _submission.traceId,
          error: "cancelled",
        };
      },
      executeControl: async (submission) => ({
        submissionId: submission.id,
        status: "completed",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
      }),
    });

    const turn = loop.submit(createSubmission("cancel me", { sessionId: "sess_cancel" }));
    await Promise.resolve();
    expect(controllerFromLoop).toBeDefined();
    controllerFromLoop!.abort(new Error("test_cancel"));
    expect((await turn).status).toBe("failed");
    loop.stop();
  });

  it("does not starve a timer-driven active turn when another turn is queued", async () => {
    const events: string[] = [];
    const loop = createSessionSubmissionLoop("sess_timer", {
      executeTurn: async (submission) => {
        events.push(`start:${submission.input.content}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`end:${submission.input.content}`);
        return {
          submissionId: submission.id,
          status: "completed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
        };
      },
      executeControl: async (submission) => ({
        submissionId: submission.id,
        status: "completed",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
      }),
    });

    const first = loop.submit(createSubmission("one", { sessionId: "sess_timer" }));
    const second = loop.submit(createSubmission("two", { sessionId: "sess_timer" }));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(events).toEqual(["start:one", "end:one", "start:two", "end:two"]);
    loop.stop();
  });

  it("links an external submission signal to the active turn", async () => {
    const external = new AbortController();
    const loop = createSessionSubmissionLoop("sess_external_cancel", {
      executeTurn: async (submission, controller) => {
        await new Promise<void>((resolve) => {
          if (controller.signal.aborted) resolve();
          else controller.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          submissionId: submission.id,
          status: "failed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          error: controller.signal.reason instanceof Error
            ? controller.signal.reason.message
            : String(controller.signal.reason),
        };
      },
      executeControl: async (submission) => ({
        submissionId: submission.id,
        status: "completed",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
      }),
    });
    const turn = loop.submit(createSubmission("cancel me", {
      sessionId: "sess_external_cancel",
      signal: external.signal,
    }));

    external.abort(new Error("transport_closed"));

    await expect(turn).resolves.toMatchObject({
      status: "failed",
      error: "transport_closed",
    });
    loop.stop();
  });
});
