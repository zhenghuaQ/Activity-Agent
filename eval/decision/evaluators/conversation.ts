import { createAgentInput } from "../../../src/runtime/index.js";
import { parseIntent } from "../../../src/intent/parser.js";
import type { PlanResult } from "../../../src/planner/engine.js";
import type { StructuredConstraints } from "../../../spec/types.js";
import type { ConstraintExpectationProjection, DecisionScenario, PreservedConstraint } from "../scenarios/schema.js";
import type { ConversationEvalResult } from "../types.js";
import { createScenarioRuntime } from "../scenarios/runtime.js";
import {
  classifyDecisionOutcome,
  isDecisionTaskSuccess,
  runtimeCompletedWithoutInfrastructureFailure,
  runtimeEvidenceFromPlanResult,
} from "../outcome.js";

interface CheckResult {
  checks: number;
  errors: string[];
}

function includesAll(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return expected.every(value => actual?.includes(value));
}

function project(constraints: StructuredConstraints): ConstraintExpectationProjection {
  return {
    destinationCity: constraints.destination?.city,
    leadRole: constraints.group.leadRole,
    budget: constraints.group.preferences.budget,
    preferredCuisine: constraints.group.preferences.preferredCuisine,
    dietaryRestrictions: constraints.group.preferences.dietaryRestrictions,
    hardMaxKm: constraints.distance.hardMaxKm,
    preferredMaxKm: constraints.distance.preferredMaxKm,
  };
}

function checkProjection(
  actual: ConstraintExpectationProjection,
  expected: ConstraintExpectationProjection | undefined,
  prefix: string,
): CheckResult {
  if (!expected) return { checks: 0, errors: [] };
  const checks: [boolean, string][] = [];
  if (expected.destinationCity) checks.push([actual.destinationCity === expected.destinationCity, "destinationCity"]);
  if (expected.leadRole) checks.push([actual.leadRole === expected.leadRole, "leadRole"]);
  if (expected.budget) checks.push([actual.budget === expected.budget, "budget"]);
  if (expected.preferredCuisine) checks.push([
    includesAll(actual.preferredCuisine, expected.preferredCuisine)
      && (actual.preferredCuisine?.length ?? 0) === expected.preferredCuisine.length,
    "preferredCuisine",
  ]);
  if (expected.dietaryRestrictions) checks.push([
    includesAll(actual.dietaryRestrictions, expected.dietaryRestrictions),
    "dietaryRestrictions",
  ]);
  if (expected.hardMaxKm !== undefined) checks.push([actual.hardMaxKm === expected.hardMaxKm, "hardMaxKm"]);
  if (expected.preferredMaxKm !== undefined) checks.push([actual.preferredMaxKm === expected.preferredMaxKm, "preferredMaxKm"]);
  return {
    checks: checks.length,
    errors: checks.filter(([passed]) => !passed).map(([, name]) => `${prefix}:${name}`),
  };
}

function preservedValue(value: ConstraintExpectationProjection, field: PreservedConstraint): unknown {
  switch (field) {
    case "destination": return value.destinationCity;
    case "leadRole": return value.leadRole;
    case "budget": return value.budget;
    case "preferredCuisine": return value.preferredCuisine;
    case "dietaryRestrictions": return value.dietaryRestrictions;
    case "distance": return [value.hardMaxKm, value.preferredMaxKm];
  }
}

function checkPreserved(
  previous: ConstraintExpectationProjection | undefined,
  current: ConstraintExpectationProjection,
  fields: readonly PreservedConstraint[] | undefined,
  prefix: string,
): CheckResult {
  if (!previous || !fields?.length) return { checks: 0, errors: [] };
  const errors: string[] = [];
  for (const field of fields) {
    if (JSON.stringify(preservedValue(previous, field)) !== JSON.stringify(preservedValue(current, field))) {
      errors.push(`${prefix}:preserved:${field}`);
    }
  }
  return { checks: fields.length, errors };
}

function checkHardConstraints(
  scenario: DecisionScenario,
  plan: PlanResult["state"]["selectedPlan"],
): CheckResult {
  const hard = scenario.expectations.hardConstraints;
  const checks: [boolean, string][] = [];
  if (hard.destinationCity) checks.push([
    !plan || plan.activities.every(activity => activity.place.location.city === hard.destinationCity),
    "destinationCity",
  ]);
  if (hard.maxDistanceKm !== undefined) checks.push([
    !plan || plan.activities.every(activity => activity.place.distanceKm <= hard.maxDistanceKm!),
    "maxDistanceKm",
  ]);
  if (hard.dietaryRestrictions?.length) {
    const restaurant = plan?.activities.find(activity => activity.place.type === "restaurant");
    checks.push([
      !plan || Boolean(restaurant && "dietaryOptions" in restaurant.place && restaurant.place.dietaryOptions === true),
      "dietaryRestrictions",
    ]);
  }
  return {
    checks: checks.length,
    errors: checks.filter(([passed]) => !passed).map(([, name]) => `hard:${name}`),
  };
}

function checkPreferences(
  scenario: DecisionScenario,
  constraints: StructuredConstraints | undefined,
  result: PlanResult | undefined,
): CheckResult {
  const expected = scenario.expectations.preferences;
  const errors: string[] = [];
  let checks = 0;
  if (expected.leadRole) {
    checks++;
    if (constraints?.group.leadRole !== expected.leadRole) errors.push("preference:leadRole");
  }
  if (expected.preferredCuisine?.length) {
    checks++;
    const offeredPlans = result?.state.decision?.pareto.map(candidate => candidate.plan)
      ?? (result?.state.selectedPlan ? [result.state.selectedPlan] : []);
    const covered = offeredPlans.some(plan => {
      const restaurant = plan.activities.find(activity => activity.place.type === "restaurant");
      const cuisine = restaurant && "cuisine" in restaurant.place
        ? (restaurant.place as import("../../../spec/types.js").Restaurant).cuisine
        : undefined;
      return Boolean(cuisine && expected.preferredCuisine!.some(item => cuisine.includes(item)));
    });
    if (!covered) errors.push("preference:preferredCuisine");
  }
  if (expected.dietaryRestrictions?.length) {
    checks++;
    if (!includesAll(constraints?.group.preferences.dietaryRestrictions, expected.dietaryRestrictions)) {
      errors.push("preference:dietaryRestrictions");
    }
  }
  if (expected.preferredMaxKm !== undefined) {
    checks++;
    if (constraints?.distance.preferredMaxKm !== expected.preferredMaxKm) errors.push("preference:preferredMaxKm");
  }
  if (expected.desiredTags?.length) {
    checks++;
    const tags = result?.state.selectedPlan?.activities.flatMap(activity => [
      ...activity.place.crowdTags,
      ...activity.place.localFeatures,
    ]) ?? [];
    if (!includesAll(tags, expected.desiredTags)) errors.push("preference:desiredTags");
  }
  return { checks, errors };
}

export async function runConversationCase(
  scenario: DecisionScenario,
  memoryEnabled: boolean,
): Promise<ConversationEvalResult> {
  const started = performance.now();
  const { runtime } = createScenarioRuntime(scenario);
  let memory: StructuredConstraints | undefined;
  let previousProjection: ConstraintExpectationProjection | undefined;
  let memoryChecks = 0;
  let memoryErrors = 0;
  let adaptationChecks = 0;
  let adaptationErrors = 0;
  let toolCalls = 0;
  let final: PlanResult | undefined;
  const errors: string[] = [];

  try {
    for (const [index, turn] of scenario.turns.entries()) {
      const submission = await runtime.submit(createAgentInput(turn.user, {
        parseFn: parseIntent,
        ...(memoryEnabled && memory ? { baseConstraints: memory } : {}),
      }), { sessionId: `eval_${memoryEnabled ? "memory" : "stateless"}_${scenario.id}` });
      if (!submission.result || typeof submission.result !== "object") {
        throw new Error(submission.error ?? "missing_result");
      }
      final = submission.result as PlanResult;
      memory = final.state.constraints;
      toolCalls += final.agentState.toolCalls.length;
      if (!memory) {
        errors.push(`turn_${index + 1}:missing_constraints`);
        continue;
      }

      const currentProjection = project(memory);
      const adaptation = scenario.expectations.adaptations?.find(item => item.afterTurn === index + 1);
      if (adaptation) {
        const required = {
          ...adaptation.requiredConstraintChanges,
          ...adaptation.requiredPreferenceChanges,
        };
        const requiredCheck = checkProjection(currentProjection, required, `turn_${index + 1}:adaptation`);
        const preservedCheck = checkPreserved(previousProjection, currentProjection, adaptation.preserved, `turn_${index + 1}:adaptation`);
        adaptationChecks += requiredCheck.checks + preservedCheck.checks;
        adaptationErrors += requiredCheck.errors.length + preservedCheck.errors.length;
        errors.push(...requiredCheck.errors, ...preservedCheck.errors);
      }
      previousProjection = currentProjection;
    }

    const plan = final?.state.selectedPlan;
    const hard = checkHardConstraints(scenario, plan);
    const runtimeEvidence = runtimeEvidenceFromPlanResult(final);
    const runtimeCompleted = Boolean(runtimeEvidence
      && runtimeCompletedWithoutInfrastructureFailure(runtimeEvidence));
    const planGenerated = Boolean(plan);
    const outcome = classifyDecisionOutcome({
      expectedFeasibility: scenario.expectations.expectedFeasibility,
      runtimeCompleted,
      planningTermination: runtimeEvidence?.planningTermination,
      planGenerated,
      hardConstraintsPassed: hard.errors.length === 0,
    });
    const taskSuccess = isDecisionTaskSuccess(scenario.expectations.expectedFeasibility, outcome);
    errors.push(...hard.errors);
    const finalProjection = memory ? project(memory) : undefined;
    const finalCheck = checkProjection(finalProjection ?? {}, scenario.expectations.finalConstraints, "final");
    memoryChecks += finalCheck.checks;
    memoryErrors += finalCheck.errors.length;
    errors.push(...finalCheck.errors);
    const preferences = checkPreferences(scenario, memory, final);
    errors.push(...preferences.errors);
    return {
      caseName: scenario.id,
      scenarioId: scenario.id,
      tags: [...scenario.tags],
      memoryEnabled,
      taskSuccess,
      outcome,
      planningTermination: final?.state.termination,
      runtimeCompleted,
      planGenerated,
      memoryChecks,
      memoryErrors,
      hardConstraintChecks: hard.checks,
      hardConstraintViolations: hard.errors.length,
      preferenceChecks: preferences.checks,
      preferenceMatches: preferences.checks - preferences.errors.length,
      adaptationChecks,
      adaptationErrors,
      durationMs: Math.round(performance.now() - started),
      toolCalls,
      turns: scenario.turns.length,
      errors,
      finalConstraints: memory,
      candidateIds: (final?.state.candidates ?? []).flatMap(candidate => candidate.plan.activities.map(activity => activity.place.id)).sort(),
      hardConstraintsPassed: hard.errors.length === 0,
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      caseName: scenario.id,
      scenarioId: scenario.id,
      tags: [...scenario.tags],
      memoryEnabled,
      taskSuccess: false,
      outcome: "runtime_failure",
      planningTermination: final?.state.termination,
      runtimeCompleted: false,
      planGenerated: Boolean(final?.state.selectedPlan),
      memoryChecks,
      memoryErrors,
      hardConstraintChecks: 0,
      hardConstraintViolations: 0,
      preferenceChecks: 0,
      preferenceMatches: 0,
      adaptationChecks,
      adaptationErrors,
      durationMs: Math.round(performance.now() - started),
      toolCalls,
      turns: scenario.turns.length,
      errors,
      finalConstraints: memory,
      candidateIds: [],
      hardConstraintsPassed: false,
    };
  } finally {
    runtime.shutdown();
  }
}
