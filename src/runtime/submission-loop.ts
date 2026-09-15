// ============================================================
// src/runtime/submission-loop.ts — Session Submission Loop
//
// Control plane：外部输入先进入 Session 自己的 Submission Queue，由
// submission_loop 有序消费。Turn 异步派生 AgentRun；control op（如
// cancel / inspect）可以在长时间 Turn 运行期间继续被消费。
// ============================================================

import type { SessionId } from "../../spec/agent.js";
import type { Submission, SubmissionResult } from "./submission.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface QueuedSubmission {
  submission: Submission;
  deferred: Deferred<SubmissionResult>;
}

export interface SubmissionLoopHandlers {
  executeTurn: (
    submission: Submission,
    controller: AbortController,
  ) => Promise<SubmissionResult>;
  executeControl: (submission: Submission) => Promise<SubmissionResult>;
}

/**
 * Session 级 Actor-like 控制循环：
 * - 同一 Session 的 turn 串行；
 * - 不同 Session 各自拥有 loop，因此天然可以并行；
 * - control op 可以穿过正在运行的 turn，从而及时执行 cancel/inspect。
 */
export class SessionSubmissionLoop {
  private readonly queue: QueuedSubmission[] = [];
  private running = false;
  private stopped = false;
  private currentTurn:
    | {
        submissionId: string;
        controller: AbortController;
        promise: Promise<void>;
      }
    | undefined;
  private notification: Promise<void> | undefined;
  private notifyResolve: (() => void) | undefined;

  constructor(
    readonly sessionId: SessionId,
    private readonly handlers: SubmissionLoopHandlers,
  ) {}

  submit(submission: Submission): Promise<SubmissionResult> {
    if (this.stopped) {
      return Promise.resolve({
        submissionId: submission.id,
        status: "rejected",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        error: "Session submission loop 已停止",
      });
    }

    const item: QueuedSubmission = {
      submission,
      deferred: deferred<SubmissionResult>(),
    };
    this.queue.push(item);
    this.notify();
    this.ensureStarted();
    return item.deferred.promise;
  }

  isRunning(): boolean {
    return Boolean(this.currentTurn);
  }

  queuedCount(): number {
    return this.queue.length;
  }

  stop(reason = "Session submission loop 已停止"): void {
    this.stopped = true;
    this.currentTurn?.controller.abort(reason);

    for (const item of this.queue.splice(0)) {
      item.deferred.resolve({
        submissionId: item.submission.id,
        status: "rejected",
        sessionId: item.submission.sessionId,
        traceId: item.submission.traceId,
        error: reason,
      });
    }
    this.notify();
  }

  private ensureStarted(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    try {
      while (!this.stopped) {
        if (this.currentTurn) {
          // Turn 正在运行：只有 control op 可以立刻穿透；新的 turn 继续排队。
          const nextSignal = await Promise.race([
            this.currentTurn.promise.then(() => "completed" as const),
            this.waitForNotification().then(() => "submission" as const),
          ]);

          if (nextSignal === "completed") {
            continue;
          }

          const control = this.takeNextControl();
          if (control) {
            await this.handleItem(control);
          }
          continue;
        }

        const item = this.queue.shift();
        if (!item) {
          await this.waitForNotification();
          continue;
        }

        await this.handleItem(item);
      }
    } finally {
      this.running = false;
    }
  }

  private async handleItem(item: QueuedSubmission): Promise<void> {
    const { submission } = item;

    if (submission.op.type !== "turn") {
      try {
        item.deferred.resolve(await this.handlers.executeControl(submission));
      } catch (error) {
        item.deferred.resolve({
          submissionId: submission.id,
          status: "failed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const controller = new AbortController();
    const completion = this.handlers
      .executeTurn(submission, controller)
      .then((result) => item.deferred.resolve(result))
      .catch((error) => {
        item.deferred.resolve({
          submissionId: submission.id,
          status: "failed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (this.currentTurn?.submissionId === submission.id) {
          this.currentTurn = undefined;
        }
        this.notify();
      });

    this.currentTurn = {
      submissionId: submission.id,
      controller,
      promise: completion,
    };
  }

  private takeNextControl(): QueuedSubmission | undefined {
    const index = this.queue.findIndex(
      (item) => item.submission.op.type !== "turn",
    );
    if (index < 0) return undefined;
    return this.queue.splice(index, 1)[0];
  }

  private async waitForNotification(): Promise<void> {
    if (this.queue.length > 0) return;
    if (!this.notification) {
      this.notification = new Promise<void>((resolve) => {
        this.notifyResolve = resolve;
      }).finally(() => {
        this.notification = undefined;
        this.notifyResolve = undefined;
      });
    }
    await this.notification;
  }

  private notify(): void {
    this.notifyResolve?.();
  }
}

export function createSessionSubmissionLoop(
  sessionId: SessionId,
  handlers: SubmissionLoopHandlers,
): SessionSubmissionLoop {
  return new SessionSubmissionLoop(sessionId, handlers);
}
