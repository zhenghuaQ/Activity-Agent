import type { DecisionScenario, DecisionScenarioExecutionInput } from "../decision/scenarios/schema.js";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";
import { validateDecisionScenario, validateDecisionScenarioExecutionInput } from "../decision/scenarios/validate.js";

export const LANGSMITH_INPUT_SCHEMA_VERSION = 1 as const;

export interface DecisionScenarioExampleInputs {
  schemaVersion: typeof LANGSMITH_INPUT_SCHEMA_VERSION;
  benchmarkVersion: typeof DECISION_BENCHMARK_VERSION;
  scenarioId: string;
  description: string;
  domain: DecisionScenarioExecutionInput["domain"];
  turns: DecisionScenarioExecutionInput["turns"];
  environment: DecisionScenarioExecutionInput["environment"];
  tags: string[];
}

export interface DecisionScenarioReferenceOutputs {
  expectations: DecisionScenario["expectations"];
}

export interface DecisionScenarioExample {
  inputs: DecisionScenarioExampleInputs;
  outputs: DecisionScenarioReferenceOutputs;
  metadata: {
    scenarioId: string;
    benchmarkVersion: typeof DECISION_BENCHMARK_VERSION;
    tags: string[];
    scenarioHash: string;
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(reason: string): never {
  throw new Error(`invalid_langsmith_decision_input:${reason}`);
}

export function parseDecisionScenarioInputs(value: unknown): DecisionScenarioExecutionInput {
  if (!record(value)) return fail("object_required");
  if ("referenceOutputs" in value || "expectations" in value) return fail("ground_truth_not_allowed");
  if (value.schemaVersion !== LANGSMITH_INPUT_SCHEMA_VERSION) return fail("schema_version");
  if (value.benchmarkVersion !== DECISION_BENCHMARK_VERSION) return fail("benchmark_version");
  if (typeof value.scenarioId !== "string" || typeof value.description !== "string") return fail("identity");
  if (value.domain !== "activity") return fail("domain");
  if (!Array.isArray(value.turns) || !value.turns.every((turn) => record(turn) && typeof turn.user === "string")) {
    return fail("turns");
  }
  if (!record(value.environment)) return fail("environment");
  if (!record(value.environment.location) || !record(value.environment.location.location)
    || !record(value.environment.data)) return fail("environment_shape");
  if (!["coords", "geocode", "ip", "default"].includes(String(value.environment.location.source))) {
    return fail("location_source");
  }
  for (const field of ["attractions", "restaurants", "breakPlaces"] as const) {
    if (!Array.isArray(value.environment.data[field])) return fail(`environment_${field}`);
  }
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) return fail("tags");

  const scenario: DecisionScenarioExecutionInput = {
    id: value.scenarioId,
    description: value.description,
    domain: value.domain,
    turns: value.turns as DecisionScenario["turns"],
    environment: value.environment as unknown as DecisionScenario["environment"],
    tags: value.tags as string[],
  };
  validateDecisionScenarioExecutionInput(scenario);
  try {
    return JSON.parse(JSON.stringify(scenario)) as DecisionScenarioExecutionInput;
  } catch {
    return fail("not_json_serializable");
  }
}

export function scenarioFromExample(
  inputs: unknown,
  referenceOutputs: unknown,
): DecisionScenario {
  const executionInput = parseDecisionScenarioInputs(inputs);
  if (!record(referenceOutputs) || !record(referenceOutputs.expectations)) return fail("expectations_required");
  const expectations = referenceOutputs.expectations;
  if ((expectations.expectedFeasibility !== "feasible" && expectations.expectedFeasibility !== "infeasible")
    || !record(expectations.hardConstraints) || !record(expectations.preferences)) {
    return fail("expectations_shape");
  }
  const scenario: DecisionScenario = {
    ...executionInput,
    expectations: expectations as unknown as DecisionScenario["expectations"],
  };
  return validateDecisionScenario(scenario);
}
