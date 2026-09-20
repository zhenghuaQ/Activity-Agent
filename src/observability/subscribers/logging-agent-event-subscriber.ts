import type { AgentEvent } from "../../../spec/agent-event.js";
import { childLogger } from "../../core/logger.js";
import {
  defaultAgentEventBus,
  type AgentEventBus,
  type AgentEventSubscriber,
  type AgentEventSubscription,
} from "../../runtime/event-bus.js";

const log = childLogger("agent-event");

/** AgentEvent → 结构化日志；Runtime 本身不 import 日志设施。 */
export class LoggingAgentEventSubscriber implements AgentEventSubscriber {
  readonly id = "observability:structured-logger:v1";

  matches(event: AgentEvent): boolean {
    return event.category === "lifecycle"
      || event.type === "profile_resolved"
      || event.type === "error";
  }

  handle(event: AgentEvent): void {
    const context = {
      eventId: event.id,
      eventType: event.type,
      sequence: event.sequence,
      ...event.scope,
      ...event.payload,
    };
    if (event.type === "error") {
      log.error(context, "Agent 运行事件");
      return;
    }
    log.info(context, "Agent 运行事件");
  }

  onError(error: unknown, event: AgentEvent): void {
    log.warn(
      {
        eventId: event.id,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      },
      "AgentEvent 日志订阅者处理失败",
    );
  }
}

const registrations = new WeakMap<AgentEventBus, AgentEventSubscription>();

/** 在应用组合根注册一次，避免 Runtime 对日志表现层产生依赖。 */
export function registerAgentEventLogging(
  eventBus: AgentEventBus = defaultAgentEventBus,
): AgentEventSubscription {
  const existing = registrations.get(eventBus);
  if (existing && !existing.closed) return existing;
  const subscription = eventBus.subscribe(new LoggingAgentEventSubscriber());
  registrations.set(eventBus, subscription);
  return subscription;
}
