import type { AgentEvent } from "../../../spec/agent-event.js";
import type { AgentEventSubscriber } from "../../runtime/event-bus.js";

export type SseEmitter = import("../../../spec/channel.js").ChannelEmitter;

let nextSubscriberId = 0;

/**
 * AgentEvent → SSE 的协议适配器。
 * 过滤、事件名映射和终态观察均属于 Subscriber，而不是 EventBus。
 */
export class SseAgentEventSubscriber implements AgentEventSubscriber {
  readonly id: string;
  private finalEvent?: AgentEvent;
  private readonly finalPromise: Promise<AgentEvent>;
  private resolveFinal!: (event: AgentEvent) => void;
  private rejectFinal!: (error: unknown) => void;

  constructor(
    private readonly traceId: string,
    private readonly emit: SseEmitter,
  ) {
    nextSubscriberId += 1;
    this.id = `sse:${traceId}:${nextSubscriberId}`;
    this.finalPromise = new Promise<AgentEvent>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    // 发布可能早于 Handler 安装 Promise.race；提前标记 rejection 已被观察。
    void this.finalPromise.catch(() => {});
  }

  matches(event: AgentEvent): boolean {
    return event.scope.traceId === this.traceId;
  }

  async handle(event: AgentEvent): Promise<void> {
    if (event.type === "stage_update") {
      await this.emit("stage", {
        stage: event.payload.stage,
        index: event.payload.index,
        total: event.payload.total,
        message: event.payload.stage,
        data: event.payload.data,
      });
    } else if (event.type === "follow_up_requested") {
      await this.emit("follow_up", { ...event.scope, ...event.payload });
    } else {
      await this.emit("agent_event", event);
    }

    if (event.type === "final" && !this.finalEvent) {
      this.finalEvent = event;
      this.resolveFinal(event);
    }
  }

  onError(error: unknown): void {
    this.rejectFinal(error);
  }

  waitForFinal(): Promise<AgentEvent> {
    return this.finalPromise;
  }

  get hasFinal(): boolean {
    return this.finalEvent !== undefined;
  }

  async complete(data: unknown): Promise<void> {
    await this.emit("done", data);
  }

  async fail(message: string, submissionId?: string): Promise<void> {
    await this.emit("error", {
      message,
      ...(submissionId ? { submissionId } : {}),
    });
  }
}
