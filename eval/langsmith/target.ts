import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";
import { runScenarioManual, type DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import { parseDecisionScenarioInputs } from "./schema.js";
import { runScenarioOpenEvals } from "../openevals/scripted-runner.js";

export interface LangSmithDecisionTargetOutput extends DecisionScenarioRunOutput {
  benchmarkVersion: typeof DECISION_BENCHMARK_VERSION;
}

function assertJsonSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("langsmith_target_output_not_json_serializable");
}

/** Runs only agent-visible inputs; referenceOutputs are intentionally not accepted here. */
export async function runLangSmithDecisionTarget(inputs: unknown): Promise<LangSmithDecisionTargetOutput> {
  const scenario = parseDecisionScenarioInputs(inputs);
  const output = process.env.LANGSMITH_DECISION_RUNNER === "openevals-scripted"
    ? (await runScenarioOpenEvals(scenario, true)).execution
    : await runScenarioManual(scenario, true);
  if (output.scenarioId !== scenario.id) throw new Error("langsmith_target_scenario_id_mismatch");
  assertJsonSafe(output);
  return {
    ...output,
    benchmarkVersion: DECISION_BENCHMARK_VERSION,
  };
}
