import fs from "node:fs/promises";
import { DECISION_ARTIFACT_SCHEMA_VERSION, type DecisionEvaluationArtifact, type DecisionEvaluationArtifactScenario } from "../decision-artifact/schema.js";
import { DECISION_SCENARIOS } from "../decision/scenarios/cases.js";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";

export class InvalidDecisionArtifactError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidDecisionArtifactError"; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDecisionArtifact(value: unknown): DecisionEvaluationArtifact {
  if (!record(value)) throw new InvalidDecisionArtifactError("artifact_root_must_be_object");
  if (value.schemaVersion !== DECISION_ARTIFACT_SCHEMA_VERSION) throw new InvalidDecisionArtifactError("unsupported_artifact_schema_version");
  if (value.benchmarkVersion !== DECISION_BENCHMARK_VERSION) throw new InvalidDecisionArtifactError("artifact_benchmark_version_mismatch");
  if (!record(value.provenance)
    || typeof value.provenance.artifactId !== "string"
    || typeof value.provenance.gitDirty !== "boolean"
    || typeof value.provenance.createdAt !== "string"
    || value.provenance.runner !== "openevals-scripted"
    || typeof value.provenance.nodeVersion !== "string"
    || (value.provenance.gitCommit !== undefined && typeof value.provenance.gitCommit !== "string")
    || (value.provenance.variantLabel !== undefined && typeof value.provenance.variantLabel !== "string")) {
    throw new InvalidDecisionArtifactError("invalid_artifact_provenance");
  }
  if (value.evaluatorVersion !== undefined && value.evaluatorVersion !== "decision-evaluator-v1.0") {
    throw new InvalidDecisionArtifactError("unsupported_decision_evaluator_version");
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== 12) throw new InvalidDecisionArtifactError("artifact_scenario_count_mismatch");
  const expectedIds = new Set(DECISION_SCENARIOS.map(scenario => scenario.id));
  const ids = new Set<string>();
  for (const raw of value.scenarios) {
    if (!record(raw)) throw new InvalidDecisionArtifactError("invalid_scenario_artifact");
    const scenario = raw as unknown as DecisionEvaluationArtifactScenario;
    if (typeof scenario.scenarioId !== "string" || !scenario.scenarioId || ids.has(scenario.scenarioId)) {
      throw new InvalidDecisionArtifactError("missing_or_duplicate_scenario_id");
    }
    ids.add(scenario.scenarioId);
    if (!expectedIds.has(scenario.scenarioId)) throw new InvalidDecisionArtifactError(`unknown_scenario_id:${scenario.scenarioId}`);
    if (typeof scenario.scenarioHash !== "string" || !/^[a-f0-9]{64}$/.test(scenario.scenarioHash)) {
      throw new InvalidDecisionArtifactError(`invalid_scenario_hash:${scenario.scenarioId}`);
    }
    if (!record(scenario.reference) || !record(scenario.decision)
      || !record(scenario.conversation) || !record(scenario.deterministic)) {
      throw new InvalidDecisionArtifactError(`missing_scenario_execution_fields:${scenario.scenarioId}`);
    }
    if (typeof scenario.reference.userGoal !== "string"
      || !["feasible", "infeasible"].includes(scenario.reference.expectedFeasibility)
      || !record(scenario.reference.hardConstraints)
      || !Array.isArray(scenario.reference.hardConstraints.dietaryRestrictions)
      || !record(scenario.reference.softPreferences)
      || !Array.isArray(scenario.reference.softPreferences.preferredCuisine)
      || !Array.isArray(scenario.reference.softPreferences.desiredTags)
      || !Array.isArray(scenario.reference.adaptationRequirements)
      || !Array.isArray(scenario.decision.userVisibleConversation)
      || scenario.decision.userVisibleConversation.some(message => !record(message)
        || !["user", "assistant"].includes(message.role)
        || typeof message.content !== "string")) {
      throw new InvalidDecisionArtifactError(`invalid_reference_or_decision_context:${scenario.scenarioId}`);
    }
    if (scenario.decision.finalConstraints !== undefined && !record(scenario.decision.finalConstraints)) {
      throw new InvalidDecisionArtifactError(`invalid_final_constraints:${scenario.scenarioId}`);
    }
    if (scenario.decision.planningTermination !== undefined
      && (!record(scenario.decision.planningTermination) || typeof scenario.decision.planningTermination.reason !== "string")) {
      throw new InvalidDecisionArtifactError(`invalid_planning_termination:${scenario.scenarioId}`);
    }
    if (scenario.decision.selectedPlan !== undefined
      && (!record(scenario.decision.selectedPlan) || !Array.isArray(scenario.decision.selectedPlan.activities))) {
      throw new InvalidDecisionArtifactError(`invalid_selected_plan:${scenario.scenarioId}`);
    }
    if (!Array.isArray(scenario.conversation.userTurns) || scenario.conversation.userTurns.some(turn => typeof turn !== "string")
      || !Array.isArray(scenario.conversation.assistantMessages) || scenario.conversation.assistantMessages.some(message => typeof message !== "string")) {
      throw new InvalidDecisionArtifactError(`invalid_conversation:${scenario.scenarioId}`);
    }
    const deterministic = scenario.deterministic;
    if (!["feasible_plan", "no_feasible_plan", "invalid_plan", "missed_feasible_plan", "runtime_failure"].includes(deterministic.outcome)
      || typeof deterministic.taskSuccess !== "boolean"
      || typeof deterministic.runtimeCompleted !== "boolean"
      || typeof deterministic.planGenerated !== "boolean"
      || !record(deterministic.hardConstraintResult)
      || !validCount(deterministic.hardConstraintResult.checks)
      || !validCount(deterministic.hardConstraintResult.violations)
      || typeof deterministic.hardConstraintResult.passed !== "boolean"
      || deterministic.hardConstraintResult.violations > deterministic.hardConstraintResult.checks
      || !record(deterministic.adaptationResult)
      || !validCount(deterministic.adaptationResult.checks)
      || !validCount(deterministic.adaptationResult.errors)
      || typeof deterministic.adaptationResult.passed !== "boolean"
      || deterministic.adaptationResult.errors > deterministic.adaptationResult.checks
      || !record(deterministic.preferenceResult)
      || !validCount(deterministic.preferenceResult.checks)
      || !validCount(deterministic.preferenceResult.matches)
      || typeof deterministic.preferenceResult.passed !== "boolean") {
      throw new InvalidDecisionArtifactError(`invalid_deterministic_metrics:${scenario.scenarioId}`);
    }
    if (value.evaluatorVersion !== undefined) {
      const recommendation = deterministic.recommendationPreferenceResult;
      if (!record(recommendation)
        || typeof recommendation.applicable !== "boolean"
        || !validCount(recommendation.satisfied)
        || !validCount(recommendation.total)
        || (recommendation.coverage !== null && (typeof recommendation.coverage !== "number" || recommendation.coverage < 0 || recommendation.coverage > 1))
        || !Array.isArray(recommendation.details)
        || (recommendation.notApplicableReason !== undefined && typeof recommendation.notApplicableReason !== "string")) {
        throw new InvalidDecisionArtifactError(`invalid_recommendation_preference_result:${scenario.scenarioId}`);
      }
      if (recommendation.satisfied > recommendation.total
        || recommendation.applicable !== (recommendation.coverage !== null)
        || (recommendation.applicable && recommendation.total === 0)
        || (recommendation.coverage !== null && recommendation.coverage !== recommendation.satisfied / recommendation.total)
        || deterministic.preferenceResult.checks !== recommendation.total
        || deterministic.preferenceResult.matches !== recommendation.satisfied
        || deterministic.preferenceResult.passed !== (recommendation.applicable && recommendation.satisfied === recommendation.total)) {
        throw new InvalidDecisionArtifactError(`inconsistent_recommendation_preference_result:${scenario.scenarioId}`);
      }
    }
    if (deterministic.preferenceResult.matches > deterministic.preferenceResult.checks
      || deterministic.hardConstraintResult.passed !== (deterministic.hardConstraintResult.violations === 0)
      || deterministic.adaptationResult.passed !== (deterministic.adaptationResult.errors === 0)
      || (value.evaluatorVersion === undefined
        && deterministic.preferenceResult.passed !== (deterministic.preferenceResult.matches === deterministic.preferenceResult.checks))) {
      throw new InvalidDecisionArtifactError(`inconsistent_deterministic_metrics:${scenario.scenarioId}`);
    }
    if (scenario.decision.userVisibleConversation.length !== scenario.conversation.userTurns.length + scenario.conversation.assistantMessages.length
      || scenario.decision.userVisibleConversation.filter(message => message.role === "user").some((message, index) => message.content !== scenario.conversation.userTurns[index])
      || scenario.decision.userVisibleConversation.filter(message => message.role === "assistant").some((message, index) => message.content !== scenario.conversation.assistantMessages[index])) {
      throw new InvalidDecisionArtifactError(`invalid_decision_conversation:${scenario.scenarioId}`);
    }
  }
  if (ids.size !== expectedIds.size || [...expectedIds].some(id => !ids.has(id))) {
    throw new InvalidDecisionArtifactError("artifact_scenario_id_set_mismatch");
  }
  return value as unknown as DecisionEvaluationArtifact;
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

export async function readDecisionArtifact(filePath: string): Promise<DecisionEvaluationArtifact> {
  let contents: string;
  try { contents = await fs.readFile(filePath, "utf8"); }
  catch { throw new InvalidDecisionArtifactError("artifact_file_unreadable"); }
  let parsed: unknown;
  try { parsed = JSON.parse(contents); }
  catch { throw new InvalidDecisionArtifactError("artifact_json_invalid"); }
  return validateDecisionArtifact(parsed);
}

export function validateArtifactPair(a: DecisionEvaluationArtifact, b: DecisionEvaluationArtifact): void {
  if (a.benchmarkVersion !== b.benchmarkVersion) throw new InvalidDecisionArtifactError("artifact_benchmark_versions_differ");
  if (a.scenarios.length !== b.scenarios.length) throw new InvalidDecisionArtifactError("artifact_scenario_counts_differ");
  const aById = new Map(a.scenarios.map(item => [item.scenarioId, item]));
  const bById = new Map(b.scenarios.map(item => [item.scenarioId, item]));
  if (aById.size !== bById.size || [...aById.keys()].some(id => !bById.has(id))) {
    throw new InvalidDecisionArtifactError("artifact_scenario_id_sets_differ");
  }
  for (const [id, rowA] of aById) {
    const rowB = bById.get(id)!;
    if (rowA.scenarioHash !== rowB.scenarioHash) throw new InvalidDecisionArtifactError(`artifact_scenario_hash_differs:${id}`);
    if (JSON.stringify(rowA.reference) !== JSON.stringify(rowB.reference)
      || JSON.stringify(rowA.conversation.userTurns) !== JSON.stringify(rowB.conversation.userTurns)) {
      throw new InvalidDecisionArtifactError(`artifact_scenario_definition_differs:${id}`);
    }
  }
}
