import type { ChatCompletionMessage } from "openevals";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import type { DecisionScenarioTrajectory } from "./types.js";

/** Keeps only externally visible messages; structured domain/runtime evidence stays separate. */
export function convertOpenEvalsTrajectory(
  trajectory: readonly ChatCompletionMessage[],
  execution: DecisionScenarioRunOutput,
  simulationDurationMs: number,
): DecisionScenarioTrajectory {
  const visibleTrajectory = trajectory.map(({ role, content }) => ({ role, content }));
  if (visibleTrajectory.some(message => message.role !== "user" && message.role !== "assistant")) {
    throw new Error("openevals_trajectory_contains_non_user_visible_message");
  }
  return {
    trajectory: visibleTrajectory,
    execution,
    turnCount: execution.turnSnapshots.length,
    simulationDurationMs,
  };
}
