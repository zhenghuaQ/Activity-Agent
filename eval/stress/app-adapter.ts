import type { ChatCompletionMessage, MultiturnSimulationParams } from "openevals";
import {
  createAgentScenarioSession,
  type DecisionScenarioRunOutput,
  type DecisionScenarioSession,
} from "../decision/evaluators/conversation.js";
import type { StressScenario } from "./schema.js";

export class StressAgentRuntimeFailure extends Error {
  constructor(message: string, readonly execution: DecisionScenarioRunOutput) {
    super(message);
    this.name = "StressAgentRuntimeFailure";
  }
}

export class StressSessionIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StressSessionIsolationError";
  }
}

export class StressAppInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StressAppInputError";
  }
}

interface ThreadSession {
  session: DecisionScenarioSession;
  turnCount: number;
  busy: boolean;
}

export interface StressAppAdapter {
  app: NonNullable<MultiturnSimulationParams["app"]>;
  getExecution(threadId: string): DecisionScenarioRunOutput | undefined;
  isolationFailure(threadId: string): boolean;
  disposeAll(): void;
  sessionCount(): number;
}

export type StressSessionFactory = typeof createAgentScenarioSession;

/** One adapter is created per repetition; its only state is the Runtime session for that run. */
export function createStressAgentApp(
  scenario: StressScenario,
  expectedThreadId: string,
  createSession: StressSessionFactory = createAgentScenarioSession,
): StressAppAdapter {
  const sessions = new Map<string, ThreadSession>();
  const observedThreadIds = new Set<string>();
  let sessionCreationCount = 0;
  let isolationFailed = false;

  const threadFor = (threadId: string): ThreadSession => {
    observedThreadIds.add(threadId);
    if (threadId !== expectedThreadId || observedThreadIds.size > 1) {
      isolationFailed = true;
      throw new StressSessionIsolationError("stress_thread_id_changed_within_run");
    }
    let thread = sessions.get(threadId);
    if (!thread) {
      sessionCreationCount += 1;
      thread = {
        session: createSession(scenario.id, scenario.environment, true, threadId),
        turnCount: 0,
        busy: false,
      };
      sessions.set(threadId, thread);
    }
    return thread;
  };

  return {
    async app({ inputs, threadId }): Promise<ChatCompletionMessage> {
      if (typeof threadId !== "string" || threadId.length === 0) {
        isolationFailed = true;
        throw new StressSessionIsolationError("stress_thread_id_required");
      }
      if (inputs.role !== "user" || typeof inputs.content !== "string") {
        throw new StressAppInputError("stress_app_requires_current_user_message");
      }
      const thread = threadFor(threadId);
      if (thread.busy) {
        isolationFailed = true;
        throw new StressSessionIsolationError("stress_concurrent_turn_for_same_thread");
      }
      if (thread.turnCount >= scenario.maxTurns) throw new StressAppInputError("stress_max_turns_exceeded");

      thread.busy = true;
      try {
        let snapshot;
        try {
          snapshot = await thread.session.runTurn(inputs.content);
        } catch (error) {
          const execution = thread.session.toOutput();
          throw new StressAgentRuntimeFailure(error instanceof Error ? error.message : String(error), execution);
        }
        thread.turnCount += 1;
        const execution = thread.session.toOutput();
        if (!execution.runtime.completed) {
          throw new StressAgentRuntimeFailure(
            execution.runtime.errors.at(-1) ?? "activity_agent_runtime_failure",
            execution,
          );
        }
        if (typeof snapshot.userVisibleMessage !== "string" || snapshot.userVisibleMessage.length === 0) {
          throw new StressAgentRuntimeFailure("activity_agent_missing_user_visible_message", execution);
        }
        return {
          role: "assistant",
          content: snapshot.userVisibleMessage,
          id: `${threadId}:assistant:${snapshot.turnIndex}`,
        };
      } finally {
        thread.busy = false;
      }
    },

    getExecution(threadId: string): DecisionScenarioRunOutput | undefined {
      return sessions.get(threadId)?.session.toOutput();
    },

    isolationFailure(threadId: string): boolean {
      return isolationFailed
        || sessionCreationCount !== 1
        || observedThreadIds.size !== 1
        || !observedThreadIds.has(threadId);
    },

    disposeAll(): void {
      for (const [threadId, thread] of sessions) {
        sessions.delete(threadId);
        thread.session.dispose();
      }
    },

    sessionCount(): number {
      return sessionCreationCount;
    },
  };
}
