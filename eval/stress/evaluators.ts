import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import { normalizeDietaryRestriction } from "../../spec/dietary.js";
import type {
  SimulationRunStatus,
  StressOutcome,
  StressRunMetrics,
  StressScenario,
  StressInvariantExpectation,
} from "./schema.js";

function evaluateHardConstraints(execution: DecisionScenarioRunOutput): { checks: number; violations: number } {
  const constraints = execution.finalConstraints;
  const plan = execution.selectedPlan;
  if (!constraints || !plan) return { checks: 0, violations: 0 };
  const checks: boolean[] = [];
  if (constraints.destination?.city) {
    checks.push(plan.activities.every(activity => activity.place.location.city === constraints.destination!.city));
  }
  const maxKm = constraints.distance.hardMaxKm;
  if (maxKm !== undefined) checks.push(plan.activities.every(activity => activity.place.distanceKm <= maxKm));
  return { checks: checks.length, violations: checks.filter(passed => !passed).length };
}

function invariantRetained(
  field: StressInvariantExpectation,
  constraints: NonNullable<DecisionScenarioRunOutput["finalConstraints"]>,
): boolean {
  switch (field.field) {
    case "destination.city": return constraints.destination?.city === field.value;
    case "distance.hardMaxKm": return constraints.distance.hardMaxKm === field.value;
    case "group.preferences.dietaryRestrictions": {
      const requirement = normalizeDietaryRestriction(field.value);
      return requirement !== undefined && constraints.group.preferences.dietaryRestrictions.includes(requirement);
    }
  }
}

function classifyStressOutcome(
  status: SimulationRunStatus,
  execution: DecisionScenarioRunOutput,
  hardConstraintViolations: number,
): StressOutcome | undefined {
  if (status === "agent_failure" || !execution.runtime.completed) return "runtime_failure";
  if (execution.planningTermination?.reason === "no_feasible_plan") return "no_feasible_plan";
  if (execution.planningTermination?.reason === "plan_selected" && execution.selectedPlan) {
    return hardConstraintViolations > 0 ? "invalid_plan" : "feasible_plan";
  }
  // Without a feasibility reference, an unterminated run cannot honestly be labeled a missed feasible plan.
  return undefined;
}

export function evaluateStressRun(input: {
  scenario: StressScenario;
  status: SimulationRunStatus;
  execution?: DecisionScenarioRunOutput;
  observedTurnCount: number;
  isolationFailure: boolean;
}): StressRunMetrics {
  const execution = input.execution;
  const hard = execution ? evaluateHardConstraints(execution) : { checks: 0, violations: 0 };
  let immutableFactChecks = 0;
  let immutableFactsRetained = 0;
  if (execution) {
    for (const snapshot of execution.turnSnapshots) {
      for (const invariant of input.scenario.invariants ?? []) {
        immutableFactChecks += 1;
        if (snapshot.constraints && invariantRetained(invariant, snapshot.constraints)) immutableFactsRetained += 1;
      }
    }
  }
  const planningTerminated = Boolean(execution?.planningTermination);
  const turnExhausted = input.status === "completed"
    && input.observedTurnCount >= input.scenario.maxTurns
    && !planningTerminated;
  const runtimeCompleted = input.status === "completed" && Boolean(execution?.runtime.completed);
  const runtimeError = input.status === "agent_failure"
    || Boolean(execution?.runtime.errors.length)
    || (input.status === "completed" && !execution?.runtime.completed);

  return {
    runtimeCompleted,
    planningTerminated,
    hardConstraintChecks: hard.checks,
    hardConstraintViolations: hard.violations,
    immutableFactChecks,
    immutableFactsRetained,
    sessionIsolationFailure: input.isolationFailure,
    turnExhausted,
    runtimeError,
    outcome: execution ? classifyStressOutcome(input.status, execution, hard.violations) : undefined,
    turnCount: input.observedTurnCount,
    replanCount: execution?.runtime.replans ?? 0,
  };
}
