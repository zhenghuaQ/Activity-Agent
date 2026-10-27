import { createAgentInput } from "../../../src/runtime/index.js";
import { parseIntent } from "../../../src/intent/parser.js";
import type { PlanResult } from "../../../src/planner/engine.js";
import type { DecisionResult } from "../../../spec/decision.js";
import type { PlanningTermination, Plan, Restaurant, StructuredConstraints } from "../../../spec/types.js";
import type {
  ConstraintExpectationProjection,
  DecisionScenario,
  DecisionScenarioEnvironment,
  DecisionScenarioExecutionInput,
  PreservedConstraint,
} from "../scenarios/schema.js";
import type { ConversationEvalResult } from "../types.js";
import type { DecisionTrace } from "../../../spec/decision-trace.js";
import { DECISION_EVALUATOR_VERSION } from "../evaluator-version.js";
import { getPlanPreferenceDistanceKm } from "../../../src/decision/distance-preference.js";
import { createScenarioRuntime } from "../scenarios/runtime.js";
import {
  classifyDecisionOutcome,
  isDecisionTaskSuccess,
  runtimeCompletedWithoutInfrastructureFailure,
  runtimeEvidenceFromPlanResult,
  type DecisionRuntimeEvidence,
} from "../outcome.js";

export interface DecisionScenarioTurnSnapshot {
  turnIndex: number;
  userInput: string;
  userVisibleMessage?: string;
  durationMs: number;
  toolCallSummary: Array<{ name: string; status: string }>;
  replanCount: number;
  runtimeErrors: string[];
  constraints?: StructuredConstraints;
  planningTermination?: PlanningTermination;
  selectedPlan?: Plan;
  finalDecision?: DecisionResult;
  candidateIds: string[];
  runtimeEvidence?: DecisionRuntimeEvidence;
  decisionTrace?: DecisionTrace;
}

/** Serializable output from executing the agent without consulting scenario ground truth. */
export interface DecisionScenarioRunOutput {
  scenarioId: string;
  turnSnapshots: DecisionScenarioTurnSnapshot[];
  finalConstraints?: StructuredConstraints;
  planningTermination?: PlanningTermination;
  selectedPlan?: Plan;
  finalDecision?: DecisionResult;
  decisionTrace?: DecisionTrace;
  runtime: {
    completed: boolean;
    status?: string;
    durationMs: number;
    toolCalls: number;
    replans: number;
    errors: string[];
    evidence?: DecisionRuntimeEvidence;
  };
}

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

function checkHardConstraints(scenario: DecisionScenario, plan: Plan | undefined): CheckResult {
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

export interface RecommendationPreferenceEvaluation {
  applicable: boolean;
  satisfied: number;
  total: number;
  coverage: number | null;
  details: Array<{ preference: string; satisfied: boolean }>;
  notApplicableReason?: "no_preferences" | "no_feasible_plan" | "runtime_failure" | "missed_feasible_plan" | "no_recommendation";
}

/** Evaluate the benchmark's existing preference expectations against the final recommendation only. */
export function evaluateRecommendedPlanPreferences(input: {
  expected: DecisionScenario["expectations"]["preferences"];
  finalConstraints?: StructuredConstraints;
  selectedPlan?: Plan;
  outcome: ConversationEvalResult["outcome"];
}): RecommendationPreferenceEvaluation {
  const expected = input.expected;
  const items: Array<{ preference: string; satisfied: boolean }> = [];
  const plan = input.selectedPlan;
  const restaurant = plan?.activities.find(activity => activity.place.type === "restaurant")?.place;
  const cuisine = restaurant && "cuisine" in restaurant ? (restaurant as Restaurant).cuisine : undefined;
  const distance = plan ? getPlanPreferenceDistanceKm(plan) : undefined;
  const planTags = plan?.activities.flatMap(activity => [...activity.place.crowdTags, ...activity.place.localFeatures]) ?? [];

  if (expected.leadRole) items.push({ preference: "leadRole", satisfied: input.finalConstraints?.group.leadRole === expected.leadRole });
  if (expected.preferredCuisine?.length) items.push({
    preference: "preferredCuisine",
    satisfied: Boolean(cuisine && expected.preferredCuisine.some(item => cuisine.includes(item))),
  });
  if (expected.dietaryRestrictions?.length) items.push({
    preference: "dietaryRestrictions",
    satisfied: includesAll(input.finalConstraints?.group.preferences.dietaryRestrictions, expected.dietaryRestrictions),
  });
  if (expected.preferredMaxKm !== undefined) items.push({
    preference: "preferredMaxKm",
    satisfied: distance !== undefined && distance <= expected.preferredMaxKm,
  });
  if (expected.desiredTags?.length) items.push({
    preference: "desiredTags",
    satisfied: includesAll(planTags, expected.desiredTags),
  });

  let notApplicableReason: RecommendationPreferenceEvaluation["notApplicableReason"];
  if (input.outcome === "runtime_failure") notApplicableReason = "runtime_failure";
  else if (input.outcome === "no_feasible_plan") notApplicableReason = "no_feasible_plan";
  else if (input.outcome === "missed_feasible_plan") notApplicableReason = "missed_feasible_plan";
  else if (!plan) notApplicableReason = "no_recommendation";
  else if (items.length === 0) notApplicableReason = "no_preferences";

  if (notApplicableReason) return { applicable: false, satisfied: 0, total: 0, coverage: null, details: [], notApplicableReason };
  const satisfied = items.filter(item => item.satisfied).length;
  return { applicable: true, satisfied, total: items.length, coverage: satisfied / items.length, details: items };
}

/** One execution owns exactly one Scenario Runtime for its complete turn sequence. */
export interface DecisionScenarioSession {
  runTurn(userInput: string): Promise<DecisionScenarioTurnSnapshot>;
  toOutput(): DecisionScenarioRunOutput;
  dispose(): void;
}

export function createDecisionScenarioSession(
  scenario: DecisionScenarioExecutionInput,
  memoryEnabled = true,
  sessionId = `eval_${memoryEnabled ? "memory" : "stateless"}_${scenario.id}`,
  captureDecisionTrace = true,
): DecisionScenarioSession {
  return createAgentScenarioSession(scenario.id, scenario.environment, memoryEnabled, sessionId, captureDecisionTrace);
}

/** Shared eval-only Activity-Agent Runtime session primitive for fixed and stress runners. */
export function createAgentScenarioSession(
  scenarioId: string,
  environment: DecisionScenarioEnvironment,
  memoryEnabled = true,
  sessionId = `eval_memory_${scenarioId}`,
  captureDecisionTrace = true,
): DecisionScenarioSession {
  const started = performance.now();
  const { runtime } = createScenarioRuntime(environment);
  let memory: StructuredConstraints | undefined;
  let final: PlanResult | undefined;
  let status: string | undefined;
  let submissionFailed = false;
  const errors: string[] = [];
  const turnSnapshots: DecisionScenarioTurnSnapshot[] = [];
  let disposed = false;

  return {
    async runTurn(userInput: string): Promise<DecisionScenarioTurnSnapshot> {
      if (disposed) throw new Error("scenario_session_disposed");
      const turnStarted = performance.now();
      const previousToolCalls = final?.agentState.toolCalls.length ?? 0;
      const previousReplans = final?.agentState.replanCount ?? 0;
      const submission = await runtime.submit(createAgentInput(userInput, {
        parseFn: parseIntent,
        runOptions: { captureDecisionTrace },
        ...(memoryEnabled && memory ? { baseConstraints: memory } : {}),
      }), { sessionId });
      if (!submission.result || typeof submission.result !== "object") {
        const message = submission.error ?? "missing_result";
        errors.push(message);
        submissionFailed = true;
        throw new Error(message);
      }

      final = submission.result as PlanResult;
      memory = final.state.constraints;
      status = final.agentState.status;
      errors.push(...final.agentState.errors);
      const evidence = runtimeEvidenceFromPlanResult(final);
      if (!evidence || !runtimeCompletedWithoutInfrastructureFailure(evidence)) submissionFailed = true;
      const snapshot: DecisionScenarioTurnSnapshot = {
        turnIndex: turnSnapshots.length + 1,
        userInput,
        userVisibleMessage: final.message,
        durationMs: Math.round(performance.now() - turnStarted),
        toolCallSummary: final.agentState.toolCalls.slice(previousToolCalls).map(call => ({
          name: call.toolName,
          status: call.status,
        })),
        replanCount: Math.max(0, (final.agentState.replanCount ?? 0) - previousReplans),
        runtimeErrors: [...final.agentState.errors],
        constraints: memory ? structuredClone(memory) : undefined,
        planningTermination: final.state.termination,
        selectedPlan: final.state.selectedPlan ? structuredClone(final.state.selectedPlan) : undefined,
        finalDecision: final.state.decision ? structuredClone(final.state.decision) : undefined,
        decisionTrace: final.agentState.decisionTrace ? structuredClone(final.agentState.decisionTrace) : undefined,
        candidateIds: (final.state.candidates ?? [])
          .flatMap(candidate => candidate.plan.activities.map(activity => activity.place.id)).sort(),
        runtimeEvidence: evidence ? structuredClone(evidence) : undefined,
      };
      turnSnapshots.push(snapshot);
      if (!memory) errors.push(`turn_${snapshot.turnIndex}:missing_constraints`);
      return snapshot;
    },

    toOutput(): DecisionScenarioRunOutput {
      const finalSnapshot = turnSnapshots.at(-1);
      const evidence = finalSnapshot?.runtimeEvidence;
      return {
        scenarioId,
        turnSnapshots: structuredClone(turnSnapshots),
        finalConstraints: finalSnapshot?.constraints ? structuredClone(finalSnapshot.constraints) : undefined,
        planningTermination: finalSnapshot?.planningTermination,
        selectedPlan: finalSnapshot?.selectedPlan ? structuredClone(finalSnapshot.selectedPlan) : undefined,
        finalDecision: finalSnapshot?.finalDecision ? structuredClone(finalSnapshot.finalDecision) : undefined,
        decisionTrace: finalSnapshot?.decisionTrace ? structuredClone(finalSnapshot.decisionTrace) : undefined,
        runtime: {
          completed: !submissionFailed && Boolean(evidence && runtimeCompletedWithoutInfrastructureFailure(evidence)),
          status,
          durationMs: Math.round(performance.now() - started),
          toolCalls: turnSnapshots.reduce((total, snapshot) => total + snapshot.toolCallSummary.length, 0),
          replans: turnSnapshots.reduce((total, snapshot) => total + snapshot.replanCount, 0),
          errors: [...errors],
          evidence: evidence ? structuredClone(evidence) : undefined,
        },
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      runtime.shutdown();
    },
  };
}

/** Manual reference execution; OpenEvals uses the same per-turn session primitive. */
export async function runScenarioManual(
  scenario: DecisionScenarioExecutionInput,
  memoryEnabled = true,
): Promise<DecisionScenarioRunOutput> {
  const session = createDecisionScenarioSession(scenario, memoryEnabled);
  try {
    for (const turn of scenario.turns) await session.runTurn(turn.user);
    return session.toOutput();
  } catch (error) {
    const failed = session.toOutput();
    failed.runtime.completed = false;
    const message = error instanceof Error ? error.message : String(error);
    if (!failed.runtime.errors.includes(message)) failed.runtime.errors.push(message);
    return failed;
  } finally {
    session.dispose();
  }
}

/** Executes a fixed multi-turn scenario; it intentionally accepts no expectations/reference outputs. */
export const runDecisionScenario = runScenarioManual;

/** Shared deterministic evaluator core used by both the local runner and LangSmith adapters. */
export function evaluateDecisionScenario(
  scenario: DecisionScenario,
  execution: DecisionScenarioRunOutput,
  memoryEnabled: boolean,
): ConversationEvalResult {
  const snapshots = execution.turnSnapshots;
  let memoryChecks = 0;
  let memoryErrors = 0;
  let adaptationChecks = 0;
  let adaptationErrors = 0;
  const errors = [...execution.runtime.errors];
  let previousProjection: ConstraintExpectationProjection | undefined;

  for (const [index, snapshot] of snapshots.entries()) {
    if (!snapshot.constraints) continue;
    const currentProjection = project(snapshot.constraints);
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

  const finalSnapshot = snapshots.at(-1);
  const plan = execution.selectedPlan;
  const hard = checkHardConstraints(scenario, plan);
  const runtimeCompleted = Boolean(execution.runtime.completed);
  const planGenerated = Boolean(plan);
  const outcome = classifyDecisionOutcome({
    expectedFeasibility: scenario.expectations.expectedFeasibility,
    runtimeCompleted,
    planningTermination: execution.planningTermination,
    planGenerated,
    hardConstraintsPassed: hard.errors.length === 0,
  });
  const taskSuccess = isDecisionTaskSuccess(scenario.expectations.expectedFeasibility, outcome);
  errors.push(...hard.errors);
  const finalProjection = execution.finalConstraints ? project(execution.finalConstraints) : undefined;
  const finalCheck = checkProjection(finalProjection ?? {}, scenario.expectations.finalConstraints, "final");
  memoryChecks += finalCheck.checks;
  memoryErrors += finalCheck.errors.length;
  errors.push(...finalCheck.errors);
  const preferences = evaluateRecommendedPlanPreferences({
    expected: scenario.expectations.preferences,
    finalConstraints: execution.finalConstraints,
    selectedPlan: plan,
    outcome,
  });

  return {
    caseName: scenario.id,
    scenarioId: scenario.id,
    tags: [...scenario.tags],
    memoryEnabled,
    taskSuccess,
    outcome,
    planningTermination: execution.planningTermination,
    runtimeCompleted,
    planGenerated,
    memoryChecks,
    memoryErrors,
    hardConstraintChecks: hard.checks,
    hardConstraintViolations: hard.errors.length,
    preferenceChecks: preferences.total,
    preferenceMatches: preferences.satisfied,
    preferenceApplicable: preferences.applicable,
    preferenceCoverage: preferences.coverage,
    preferenceDetails: preferences.details,
    ...(preferences.notApplicableReason ? { preferenceNotApplicableReason: preferences.notApplicableReason } : {}),
    evaluatorVersion: DECISION_EVALUATOR_VERSION,
    adaptationChecks,
    adaptationErrors,
    durationMs: execution.runtime.durationMs,
    toolCalls: execution.runtime.toolCalls,
    turns: scenario.turns.length,
    errors,
    finalConstraints: execution.finalConstraints,
    candidateIds: finalSnapshot?.candidateIds ?? [],
    hardConstraintsPassed: hard.errors.length === 0,
  };
}

export async function runConversationCase(
  scenario: DecisionScenario,
  memoryEnabled: boolean,
): Promise<ConversationEvalResult> {
  const execution = await runDecisionScenario(scenario, memoryEnabled);
  return evaluateDecisionScenario(scenario, execution, memoryEnabled);
}
