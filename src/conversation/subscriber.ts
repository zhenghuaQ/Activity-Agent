import type { AgentEvent } from "../../spec/agent-event.js";
import type { StructuredConstraints } from "../../spec/types.js";
import type { AgentEventSubscriber } from "../runtime/event-bus.js";
import type { ConversationStore } from "./store.js";

export type ConversationMemoryWriter = Pick<ConversationStore, "checkpointConstraints" | "setPendingQuestion">;

/**
 * 将 Runtime 领域事件投影成可恢复的短期会话记忆。
 * 它是 EventBus 的独立 Subscriber，不依赖 SSE 是否存在或是否仍连接。
 */
export class ConversationMemorySubscriber implements AgentEventSubscriber {
  readonly id: string;

  constructor(
    private readonly traceId: string,
    private readonly store: ConversationMemoryWriter,
  ) {
    this.id = `conversation-memory:${traceId}`;
  }

  matches(event: AgentEvent): boolean {
    return event.scope.traceId === this.traceId;
  }

  async handle(event: AgentEvent): Promise<void> {
    const conversationId = event.scope.sessionId;
    if (event.type === "stage_update" && event.payload.stage === "intent_parsing") {
      const constraints = event.payload.data?.constraints as StructuredConstraints | undefined;
      if (constraints) await this.store.checkpointConstraints(conversationId, constraints);
      return;
    }
    if (event.type === "follow_up_requested") {
      await this.store.setPendingQuestion(conversationId, event.payload.requestId);
      return;
    }
    if (event.type === "follow_up_answered" || event.type === "final" || event.type === "error") {
      await this.store.setPendingQuestion(conversationId, undefined);
    }
  }
}
