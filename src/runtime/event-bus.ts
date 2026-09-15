// ============================================================
// src/runtime/event-bus.ts — Runtime 异步事件总线 / Event Queue
//
// 设计：
// - 每个 traceId 是一条独立事件流；
// - publish 非阻塞，生产者不等待消费者；
// - subscribe 返回 AsyncIterable，适合 SSE / CLI / 测试等消费者；
// - subscriber 关闭后释放内存，不使用后台 timer；
// ============================================================

import type { TraceEvent } from "./trace.js";

type Resolver<T> = (result: IteratorResult<T>) => void;

class AsyncEventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly buffered: T[] = [];
  private readonly pending: Resolver<T>[] = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.pending.shift();
    if (resolve) {
      resolve({ value, done: false });
      return;
    }
    this.buffered.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.pending.length > 0) {
      this.pending.shift()!({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffered.length > 0) {
      return Promise.resolve({ value: this.buffered.shift()!, done: false });
    }
    if (this.closed) {
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise<IteratorResult<T>>((resolve) => {
      this.pending.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}

export interface EventSubscription<T = TraceEvent> extends AsyncIterable<T> {
  close(): void;
}

export interface RuntimeEventBus {
  publish(event: TraceEvent): void;
  subscribe(traceId: string): EventSubscription<TraceEvent>;
  closeTrace(traceId: string): void;
  subscriberCount(traceId: string): number;
}

type SubscriberSet = Set<AsyncEventQueue<TraceEvent>>;

/**
 * 进程内事件总线。
 *
 * 当前版本故意不持久化、不跨进程；后续可以替换成 Redis/NATS/Kafka 等实现，
 * Runtime 层只依赖 RuntimeEventBus 接口。
 */
export class InMemoryRuntimeEventBus implements RuntimeEventBus {
  private readonly subscribers = new Map<string, SubscriberSet>();

  publish(event: TraceEvent): void {
    const set = this.subscribers.get(event.traceId);
    if (!set) return;
    for (const queue of set) queue.push(event);
  }

  subscribe(traceId: string): EventSubscription<TraceEvent> {
    const queue = new AsyncEventQueue<TraceEvent>();
    let set = this.subscribers.get(traceId);
    if (!set) {
      set = new Set();
      this.subscribers.set(traceId, set);
    }
    set.add(queue);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      queue.close();
      set!.delete(queue);
      if (set!.size === 0 && this.subscribers.get(traceId) === set) {
        this.subscribers.delete(traceId);
      }
    };

    return {
      [Symbol.asyncIterator]: () => queue,
      close,
    };
  }

  closeTrace(traceId: string): void {
    const set = this.subscribers.get(traceId);
    if (!set) return;
    for (const queue of set) queue.close();
    this.subscribers.delete(traceId);
  }

  subscriberCount(traceId: string): number {
    return this.subscribers.get(traceId)?.size ?? 0;
  }
}

export const defaultRuntimeEventBus = new InMemoryRuntimeEventBus();
