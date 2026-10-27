import type { DecisionScenarioExecutionInput } from "../decision/scenarios/schema.js";
import type { ChatCompletionMessage } from "openevals";

/** OpenEvals static user response array, derived only from the canonical fixed Scenario turns. */
export function scenarioScriptedResponses(scenario: DecisionScenarioExecutionInput): string[] {
  return scenario.turns.map(({ user }) => user);
}

/** Deterministic callback equivalent for tests or integrations needing per-turn message IDs. */
export function createScenarioScriptedUser(scenario: DecisionScenarioExecutionInput) {
  return ({ turnCounter }: { turnCounter: number }): ChatCompletionMessage => {
    const turn = scenario.turns[turnCounter];
    if (!turn) throw new Error("openevals_scripted_turns_exhausted");
    return { role: "user", content: turn.user, id: `${scenario.id}:user:${turnCounter + 1}` };
  };
}
