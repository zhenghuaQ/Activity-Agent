import type { ChatCompletionMessage, MultiturnSimulationParams } from "openevals";
import type { DecisionScenarioExecutionInput } from "../decision/scenarios/schema.js";
import {
  createDecisionScenarioSession,
  type DecisionScenarioRunOutput,
  type DecisionScenarioSession,
} from "../decision/evaluators/conversation.js";

interface ThreadSession {
  session: DecisionScenarioSession;
  nextTurnIndex: number;
  busy: boolean;
}

export class OpenEvalsRuntimeFailure extends Error {
  constructor(message: string, readonly execution: DecisionScenarioRunOutput) {
    super(message);
    this.name = "OpenEvalsRuntimeFailure";
  }
}

export interface OpenEvalsAppAdapter {
  app: NonNullable<MultiturnSimulationParams["app"]>;
  getExecution(threadId: string): DecisionScenarioRunOutput | undefined;
  activeSessionCount(): number;
  dispose(threadId: string): void;
  disposeAll(): void;
}

export type ScenarioSessionFactory = typeof createDecisionScenarioSession;

/** Adapts one fixed Scenario to OpenEvals' app callback without exposing its full turns/history. */
export function createOpenEvalsApp(
  scenario: DecisionScenarioExecutionInput,
  memoryEnabled = true,
  createSession: ScenarioSessionFactory = createDecisionScenarioSession,
): OpenEvalsAppAdapter {
  const sessions = new Map<string, ThreadSession>();

  const getOrCreate = (threadId: string): ThreadSession => {
    let thread = sessions.get(threadId);
    if (!thread) {
      thread = {
        session: createSession(scenario, memoryEnabled, threadId),
        nextTurnIndex: 0,
        busy: false,
      };
      sessions.set(threadId, thread);
    }
    return thread;
  };

  return {
    async app({ inputs, threadId }): Promise<ChatCompletionMessage> {
      if (typeof threadId !== "string" || threadId.length === 0) throw new Error("openevals_thread_id_required");
      const thread = getOrCreate(threadId);
      if (thread.busy) throw new Error("openevals_concurrent_turn_for_thread");
      const expected = scenario.turns[thread.nextTurnIndex];
      if (!expected) throw new Error("openevals_turn_count_exceeded");
      if (inputs.role !== "user" || typeof inputs.content !== "string" || inputs.content !== expected.user) {
        throw new Error(`openevals_scripted_turn_mismatch:${thread.nextTurnIndex + 1}`);
      }

      thread.busy = true;
      try {
        const snapshot = await thread.session.runTurn(inputs.content);
        thread.nextTurnIndex += 1;
        const execution = thread.session.toOutput();
        if (!execution.runtime.completed) {
          throw new OpenEvalsRuntimeFailure(
            execution.runtime.errors.at(-1) ?? "runtime_infrastructure_failure",
            execution,
          );
        }
        if (typeof snapshot.userVisibleMessage !== "string" || snapshot.userVisibleMessage.length === 0) {
          throw new OpenEvalsRuntimeFailure("runtime_missing_user_visible_message", execution);
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

    activeSessionCount(): number {
      return sessions.size;
    },

    dispose(threadId: string): void {
      const thread = sessions.get(threadId);
      if (!thread) return;
      sessions.delete(threadId);
      thread.session.dispose();
    },

    disposeAll(): void {
      for (const threadId of sessions.keys()) this.dispose(threadId);
    },
  };
}
