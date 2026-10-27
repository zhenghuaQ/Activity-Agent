import type { DecisionScenarioEnvironment } from "../decision/scenarios/schema.js";

export const STRESS_BENCHMARK_VERSION = "stress-v1.0" as const;

export interface SimulatedUserProfile {
  initialMessage: string;
  persona: string;
  goal: string;
  immutableFacts?: string[];
  hiddenFacts?: string[];
  behavioralInstructions?: string[];
  forbiddenBehaviors?: string[];
}

export type StressInvariantExpectation =
  | { field: "destination.city"; value: string }
  | { field: "distance.hardMaxKm"; value: number }
  | { field: "group.preferences.dietaryRestrictions"; value: string };

export interface StressScenario {
  id: string;
  description: string;
  domain: "activity";
  environment: DecisionScenarioEnvironment;
  user: SimulatedUserProfile;
  maxTurns: number;
  tags: string[];
  invariants?: StressInvariantExpectation[];
}

export type StressOutcome =
  | "feasible_plan"
  | "no_feasible_plan"
  | "invalid_plan"
  | "missed_feasible_plan"
  | "runtime_failure";

export type SimulationRunStatus = "completed" | "agent_failure" | "simulator_failure";

export interface StressRunMetrics {
  runtimeCompleted: boolean;
  planningTerminated: boolean;
  hardConstraintChecks: number;
  hardConstraintViolations: number;
  immutableFactChecks: number;
  immutableFactsRetained: number;
  sessionIsolationFailure: boolean;
  turnExhausted: boolean;
  runtimeError: boolean;
  outcome?: StressOutcome;
  turnCount: number;
  replanCount: number;
}

export interface StressRunResult {
  stressBenchmarkVersion: typeof STRESS_BENCHMARK_VERSION;
  simulatedUserModel: string;
  scenarioId: string;
  runIndex: number;
  maxTurns: number;
  threadId: string;
  status: SimulationRunStatus;
  simulationDurationMs: number;
  trajectory: Array<{ role: string; content: unknown }>;
  execution?: import("../decision/evaluators/conversation.js").DecisionScenarioRunOutput;
  metrics: StressRunMetrics;
  simulatorError?: string;
}

export interface StressEvaluatorResult {
  metrics: StressRunMetrics;
}

export function validateStressScenarios(scenarios: readonly StressScenario[]): StressScenario[] {
  if (scenarios.length < 6 || scenarios.length > 8) {
    throw new Error("stress_benchmark_requires_6_to_8_scenarios");
  }
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.id.trim() || ids.has(scenario.id)) throw new Error(`invalid_or_duplicate_stress_scenario:${scenario.id}`);
    ids.add(scenario.id);
    if (scenario.domain !== "activity") throw new Error(`invalid_stress_domain:${scenario.id}`);
    if (!Number.isInteger(scenario.maxTurns) || scenario.maxTurns < 3 || scenario.maxTurns > 6) {
      throw new Error(`invalid_stress_max_turns:${scenario.id}`);
    }
    if (!scenario.user.initialMessage.trim() || !scenario.user.persona.trim() || !scenario.user.goal.trim()) {
      throw new Error(`incomplete_stress_user_profile:${scenario.id}`);
    }
    for (const invariant of scenario.invariants ?? []) {
      if (invariant.field === "distance.hardMaxKm"
        && (!Number.isFinite(invariant.value) || invariant.value <= 0)) {
        throw new Error(`invalid_stress_invariant:${scenario.id}:${invariant.field}`);
      }
      if (invariant.field !== "distance.hardMaxKm" && !invariant.value.trim()) {
        throw new Error(`invalid_stress_invariant:${scenario.id}:${invariant.field}`);
      }
    }
  }
  return [...scenarios];
}
