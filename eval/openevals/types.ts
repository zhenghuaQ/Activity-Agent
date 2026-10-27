import type { ChatCompletionMessage } from "openevals";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";

/** User-visible chronology returned by OpenEvals paired with internal Agent evidence. */
export interface DecisionScenarioTrajectory {
  trajectory: Array<Pick<ChatCompletionMessage, "role" | "content">>;
  execution: DecisionScenarioRunOutput;
  turnCount: number;
  simulationDurationMs: number;
}

export interface OpenEvalsScenarioRun {
  threadId: string;
  trajectory: DecisionScenarioTrajectory;
  execution: DecisionScenarioRunOutput;
}
