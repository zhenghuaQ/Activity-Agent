// ============================================================
// src/runtime/scheduler.ts — Session 级串行调度
//
// 策略：不同 Session 可以并行；同一 Session 默认串行。
// Submission 可以先入队，再由 Scheduler 决定何时真正执行。
// ============================================================

import type { SessionId } from "../../spec/agent.js";

export type SessionConcurrencyPolicy = "serial";

export class SessionScheduler {
  private readonly tails = new Map<SessionId, Promise<void>>();

  constructor(
    readonly policy: SessionConcurrencyPolicy = "serial",
  ) {}

  async runExclusive<T>(sessionId: SessionId, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const tail = previous.then(() => gate);
    this.tails.set(sessionId, tail);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) {
        this.tails.delete(sessionId);
      }
    }
  }

  queuedSessions(): number {
    return this.tails.size;
  }

  clear(): void {
    this.tails.clear();
  }
}

export const defaultSessionScheduler = new SessionScheduler();
