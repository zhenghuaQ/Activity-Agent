import type { Writable } from "node:stream";

/** 有界、顺序写入；write(false) 后等待 drain，失败时关闭连接。 */
export class SseWriter {
  private tail = Promise.resolve();
  private pendingBytes = 0;
  private failure?: Error;
  constructor(private readonly stream: Writable, private readonly maxBytes = 1_048_576, private readonly drainMs = 10_000) {
    if (![maxBytes, drainMs].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error("invalid_sse_limit");
    const failed = (error: Error) => { this.failure = error; this.stream.destroy(); };
    stream.on("error", failed);
    stream.once("close", () => stream.off("error", failed));
  }

  send(event: string, data: unknown): Promise<void> {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const size = Buffer.byteLength(frame);
    if (this.failure) return Promise.reject(this.failure);
    if (this.pendingBytes + size > this.maxBytes) {
      this.failure = new Error("sse_buffer_capacity");
      this.stream.destroy();
      return Promise.reject(this.failure);
    }
    this.pendingBytes += size;
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      if (this.stream.destroyed) throw new Error("sse_connection_closed");
      if (!this.stream.write(frame)) await new Promise<void>((resolve, reject) => {
        const clean = () => { clearTimeout(timer); this.stream.off("drain", drained); this.stream.off("close", closed); this.stream.off("error", failed); };
        const drained = () => { clean(); resolve(); };
        const failed = (error: Error) => { clean(); reject(error); };
        const closed = () => failed(new Error("sse_connection_closed"));
        const timer = setTimeout(() => failed(new Error("sse_drain_timeout")), this.drainMs);
        this.stream.once("drain", drained); this.stream.once("close", closed); this.stream.once("error", failed);
      });
    }).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.stream.destroy();
      throw this.failure;
    }).finally(() => { this.pendingBytes -= size; });
    this.tail = operation.catch(() => {});
    return operation;
  }

  async drain(): Promise<void> { await this.tail; if (this.failure) throw this.failure; }
}
