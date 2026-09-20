import type { AgentEvent } from "../../spec/agent-event.js";

export interface AgentEventSubscriber {
  readonly id: string;
  /** 必须同步、无副作用。 */
  matches(event: AgentEvent): boolean;
  /** Promise 完成（含失败处理）后才交付下一事件。 */
  handle(event: AgentEvent): void | Promise<void>;
  onError?(error: unknown, event: AgentEvent): void | Promise<void>;
}

export interface DeliveryReport {
  readonly pending: number;
  readonly processingMs: number;
  readonly delivered: number;
  readonly failed: number;
  readonly rejected: number;
  readonly errorHandlerFailures: number;
  readonly lastError?: unknown;
}

export interface AgentEventSubscription {
  readonly closed: boolean;
  /** 停止接收新事件；已接收的事件继续处理。 */
  close(): void;
  /** 即使某个异步事务尚未完成，也可读取拒绝/失败计数。 */
  report(): DeliveryReport;
  /** 等待空闲并返回累计报告；超时不取消正在执行的副作用。 */
  drain(timeoutMs?: number): Promise<DeliveryReport>;
}

export interface AgentEventBus {
  /** 非阻塞、至多一次交付；不自动重试，不提供事务或持久化保证。 */
  publish(event: AgentEvent): void;
  subscribe(subscriber: AgentEventSubscriber): AgentEventSubscription;
  subscriberCount(): number;
  snapshot?(): { subscribers: number; pending: number; delivered: number; failed: number; rejected: number; processingMs: number };
}

/** 每个 Subscriber 独立 FIFO；同步 fast path 保留 v1 即时交付行为。 */
export class InMemoryAgentEventBus implements AgentEventBus {
  private readonly subscribers = new Map<string, { accept(event: AgentEvent): void }>();
  private readonly publications: AgentEvent[] = [];
  private publishing = false;
  private readonly pendingReaders = new Set<() => number>();
  private readonly totals = { delivered: 0, failed: 0, rejected: 0, processingMs: 0 };

  snapshot() {
    return { ...this.totals, subscribers: this.subscribers.size,
      pending: [...this.pendingReaders].reduce((sum, read) => sum + read(), 0) };
  }

  constructor(private readonly maxPending = 1024) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) throw new Error("invalid_subscriber_capacity");
  }

  publish(event: AgentEvent): void {
    this.publications.push(event);
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.publications.length) {
        const next = this.publications.shift()!;
        for (const subscriber of [...this.subscribers.values()]) subscriber.accept(next);
      }
    } finally { this.publishing = false; }
  }

  subscribe(subscriber: AgentEventSubscriber): AgentEventSubscription {
    if (this.subscribers.has(subscriber.id)) throw new Error(`duplicate_agent_event_subscriber:${subscriber.id}`);
    let closed = false;
    let busy = false;
    const queue: AgentEvent[] = [];
    const waiters = new Set<() => void>();
    const pending = () => queue.length + Number(busy);
    this.pendingReaders.add(pending);
    const report = { processingMs: 0, delivered: 0, failed: 0, rejected: 0, errorHandlerFailures: 0, lastError: undefined as unknown };
    const snapshot = () => ({ ...report, pending: pending() });

    const reportFailure = (error: unknown, event: AgentEvent): void | Promise<void> => {
      report.failed++;
      this.totals.failed++;
      report.lastError = error;
      const failedReporter = (reporterError: unknown) => {
        report.errorHandlerFailures++;
        report.lastError = reporterError;
      };
      try {
        const result = subscriber.onError?.(error, event);
        if (result) return Promise.resolve(result).catch(failedReporter);
      } catch (reporterError) { failedReporter(reporterError); }
    };

    const pump = (): void => {
      if (busy) return;
      busy = true;
      while (queue.length) {
        const event = queue.shift()!;
        const started = Date.now();
        const timed = () => { const elapsed = Date.now() - started; report.processingMs += elapsed; this.totals.processingMs += elapsed; };
        let completion: void | Promise<void> = undefined;
        try {
          const result = subscriber.handle(event);
          if (result) {
            completion = Promise.resolve(result).then(
              () => { report.delivered++; this.totals.delivered++; },
              (error: unknown) => reportFailure(error, event),
            );
          } else { report.delivered++; this.totals.delivered++; }
        } catch (error) { completion = reportFailure(error, event); }
        if (completion) {
          void completion.then(() => { timed(); busy = false; pump(); });
          return;
        }
        timed();
      }
      busy = false;
      if (closed) this.pendingReaders.delete(pending);
      for (const done of [...waiters]) done();
    };

    const registration = {
      accept: (event: AgentEvent) => {
        if (closed) return;
        // 入队前过滤失败与容量拒绝只写报告，避免递归/无限错误回调排队。
        try { if (!subscriber.matches(event)) return; }
        catch (error) { report.rejected++; this.totals.rejected++; report.lastError = error; return; }
        if (queue.length + Number(busy) >= this.maxPending) {
          report.rejected++;
          this.totals.rejected++;
          report.lastError = new Error(`subscriber_queue_overflow:${subscriber.id}`);
          return;
        }
        queue.push(event);
        pump();
      },
    };
    this.subscribers.set(subscriber.id, registration);
    return {
      get closed() { return closed; },
      report: snapshot,
      close: () => {
        if (closed) return;
        closed = true;
        if (!busy) this.pendingReaders.delete(pending);
        if (this.subscribers.get(subscriber.id) === registration) this.subscribers.delete(subscriber.id);
      },
      drain: (timeoutMs = 30_000) => {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new Error("invalid_drain_timeout"));
        if (!busy && queue.length === 0) return Promise.resolve(snapshot());
        return new Promise<DeliveryReport>((resolve, reject) => {
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(snapshot()); };
          const timer = setTimeout(() => {
            waiters.delete(done);
            reject(new Error(`subscriber_drain_timeout:${subscriber.id}`));
          }, timeoutMs);
          waiters.add(done);
        });
      },
    };
  }

  subscriberCount(): number { return this.subscribers.size; }
}

export const defaultAgentEventBus = new InMemoryAgentEventBus();
