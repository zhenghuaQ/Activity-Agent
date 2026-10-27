import type { PlanCandidate, StructuredConstraints } from "../../spec/types.js";
import type { ConstraintCheck } from "../../spec/constraints.js";
import type { DecisionTrace, DecisionTraceCandidate, DecisionTraceCheck, DecisionTraceRevision } from "../../spec/decision-trace.js";
import type { DecisionExplanationEvidence, PlanObjective } from "../../spec/decision.js";
import { getCanonicalPlanIdentity } from "./plan-identity.js";

export function projectDecisionConstraints(constraints: StructuredConstraints): DecisionTrace["constraints"] {
  return {
    ...(constraints.destination ? { destination: structuredClone(constraints.destination) } : {}),
    group: {
      scenario: constraints.group.scenario,
      totalPeople: constraints.group.totalPeople,
      maleCount: constraints.group.maleCount,
      femaleCount: constraints.group.femaleCount,
      ageGroup: structuredClone(constraints.group.ageGroup),
      leadRole: constraints.group.leadRole,
      preferences: {
        dieting: constraints.group.preferences.dieting,
        ...(constraints.group.preferences.budget ? { budget: constraints.group.preferences.budget } : {}),
        dietaryRestrictions: [...constraints.group.preferences.dietaryRestrictions],
        ...(constraints.group.preferences.preferredCuisine ? { preferredCuisine: [...constraints.group.preferences.preferredCuisine] } : {}),
      },
    },
    timeWindow: structuredClone(constraints.timeWindow),
    ...(constraints.hardMaxDurationMinutes !== undefined ? { hardMaxDurationMinutes: constraints.hardMaxDurationMinutes } : {}),
    distance: structuredClone(constraints.distance),
  };
}

export function projectTraceCandidate(candidate: PlanCandidate): DecisionTraceCandidate {
  const roleComposition: Record<string, number> = {};
  const placeIds = candidate.plan.activities.map(activity => activity.place.id).sort();
  for (const activity of candidate.plan.activities) {
    roleComposition[activity.place.type] = (roleComposition[activity.place.type] ?? 0) + 1;
  }
  return {
    canonicalPlanId: getCanonicalPlanIdentity(candidate.plan),
    runtimePlanId: candidate.plan.id,
    placeIds,
    roleComposition: Object.fromEntries(Object.entries(roleComposition).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    count: candidate.plan.activities.length,
  };
}

function projectCheck(check: ConstraintCheck): DecisionTraceCheck {
  return {
    code: check.rule,
    passed: check.passed,
    ...(check.actualMinutes !== undefined ? { actualMinutes: check.actualMinutes } : {}),
    ...(check.limitMinutes !== undefined ? { limitMinutes: check.limitMinutes } : {}),
    ...(check.dietaryEvidence ? { dietaryEvidence: check.dietaryEvidence.map(item => ({ ...item })) } : {}),
  };
}

function order<T extends { canonicalPlanId: string }>(items: T[]): T[] {
  return items.sort((a, b) => a.canonicalPlanId < b.canonicalPlanId ? -1 : a.canonicalPlanId > b.canonicalPlanId ? 1 : 0);
}

function getRevision(trace: DecisionTrace, revision: number): DecisionTraceRevision {
  let found = trace.revisions.find(item => item.revision === revision);
  if (!found) {
    found = { revision, candidates: [], hardFeasibility: [], scoredPlans: [], representatives: [] };
    trace.revisions.push(found);
    trace.revisions.sort((a, b) => a.revision - b.revision);
  }
  return found;
}

export function recordGeneratedCandidates(trace: DecisionTrace, revision: number, candidates: PlanCandidate[]): void {
  const target = getRevision(trace, revision);
  target.candidates = order(candidates.map(projectTraceCandidate));
  trace.status = "partial";
}

export function recordHardFeasibilityFromCandidates(trace: DecisionTrace, revision: number, candidates: PlanCandidate[], evaluations: Array<{
  candidateId: string; planId: string; passed: boolean; checks: ConstraintCheck[]; hardFailures: ConstraintCheck[];
}>): void {
  const target = getRevision(trace, revision);
  const plans = new Map(candidates.map(candidate => [candidate.plan.id, candidate.plan]));
  target.hardFeasibility = evaluations.map(evaluation => {
    const plan = plans.get(evaluation.planId);
    return plan ? {
      canonicalPlanId: getCanonicalPlanIdentity(plan),
      passed: evaluation.passed,
      checks: evaluation.checks.map(projectCheck),
      hardFailures: evaluation.hardFailures.map(projectCheck),
    } : undefined;
  }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  target.hardFeasibility.sort((a, b) => a.canonicalPlanId < b.canonicalPlanId ? -1 : a.canonicalPlanId > b.canonicalPlanId ? 1 : 0);
  trace.status = "partial";
}

export function recordScoring(
  trace: DecisionTrace,
  revision: number,
  scored: PlanCandidate[],
  representatives: Array<{ objective: PlanObjective; candidate: PlanCandidate; objectiveScore: number }>,
): void {
  const target = getRevision(trace, revision);
  target.scoredPlans = order(scored.flatMap(candidate => candidate.plan.score
    ? [{ canonicalPlanId: getCanonicalPlanIdentity(candidate.plan), runtimePlanId: candidate.plan.id, score: structuredClone(candidate.plan.score) }]
    : []));
  target.representatives = representatives.map(item => ({
    objective: item.objective,
    canonicalPlanId: getCanonicalPlanIdentity(item.candidate.plan),
    objectiveScore: item.objectiveScore,
  }));
  trace.status = "partial";
}

export function recordRecommendedPlan(trace: DecisionTrace, plan: PlanCandidate["plan"] | undefined): void {
  trace.selection.recommendedCanonicalPlanId = plan ? getCanonicalPlanIdentity(plan) : null;
}

export function recordFallbackAttempt(trace: DecisionTrace, failureCodes: string[]): void {
  trace.selection.fallbackFailureCodes = [...failureCodes].sort();
}

export function recordFinalAcceptance(
  trace: DecisionTrace,
  input: { selectedPlan?: PlanCandidate["plan"]; passed: boolean; checks: ConstraintCheck[]; failureCodes: string[]; explanation?: DecisionExplanationEvidence[] },
): void {
  const finalIdentity = input.selectedPlan ? getCanonicalPlanIdentity(input.selectedPlan) : null;
  trace.selection.finalSelectedCanonicalPlanId = finalIdentity;
  trace.selection.fallbackUsed = Boolean(finalIdentity && trace.selection.recommendedCanonicalPlanId && finalIdentity !== trace.selection.recommendedCanonicalPlanId);
  trace.selection.finalAcceptance = {
    passed: input.passed,
    checks: input.checks.map(projectCheck),
    failureCodes: [...input.failureCodes].sort(),
  };
  trace.explanation = input.selectedPlan && input.explanation
    ? { canonicalPlanId: finalIdentity!, evidence: structuredClone(input.explanation) }
    : undefined;
  trace.status = trace.termination ? "complete" : "partial";
}

export function finalizeDecisionTrace(trace: DecisionTrace, termination?: DecisionTrace["termination"], failure?: DecisionTrace["failure"]): void {
  trace.termination = termination ? structuredClone(termination) : undefined;
  trace.failure = failure;
  trace.status = termination ? "complete" : trace.revisions.length ? "partial" : "not_reached";
}

export type SemanticDecisionTrace = Omit<DecisionTrace, "revisions"> & {
  revisions: Array<Omit<DecisionTraceRevision, "candidates" | "scoredPlans"> & {
    candidates: Array<Omit<DecisionTraceCandidate, "runtimePlanId">>;
    scoredPlans: Array<Omit<DecisionTraceRevision["scoredPlans"][number], "runtimePlanId">>;
  }>;
};

export function semanticDecisionTrace(trace: DecisionTrace): SemanticDecisionTrace {
  return {
    ...structuredClone(trace),
    revisions: trace.revisions.map(revision => ({
      ...structuredClone(revision),
      candidates: revision.candidates.map(({ runtimePlanId: _runtimePlanId, ...candidate }) => candidate),
      scoredPlans: revision.scoredPlans.map(({ runtimePlanId: _runtimePlanId, ...scored }) => scored),
    })),
  };
}

export function decisionTraceInvariantViolations(trace: DecisionTrace): string[] {
  const violations: string[] = [];
  for (const revision of trace.revisions) {
    const candidateIds = revision.candidates.map(item => item.canonicalPlanId);
    const candidateSet = new Set(candidateIds);
    if (candidateSet.size !== candidateIds.length) violations.push(`revision_${revision.revision}:duplicate_candidate`);
    const hardById = new Map(revision.hardFeasibility.map(item => [item.canonicalPlanId, item]));
    const scoredIds = new Set(revision.scoredPlans.map(item => item.canonicalPlanId));
    for (const item of revision.hardFeasibility) if (!candidateSet.has(item.canonicalPlanId)) violations.push("hard_result_orphan");
    for (const item of revision.scoredPlans) {
      const hard = hardById.get(item.canonicalPlanId);
      if (!candidateSet.has(item.canonicalPlanId) || hard?.passed !== true) violations.push("scored_not_hard_passed");
    }
    for (const item of revision.representatives) if (!scoredIds.has(item.canonicalPlanId)) violations.push("representative_not_scored");
    if (revision.representatives.some(item => !candidateSet.has(item.canonicalPlanId))) violations.push("representative_orphan");
    if (revision.representatives.length && trace.selection.recommendedCanonicalPlanId
      && !revision.representatives.some(item => item.canonicalPlanId === trace.selection.recommendedCanonicalPlanId)) {
      // Recommendation may belong to an earlier replan revision.
      const existsElsewhere = trace.revisions.some(other => other.representatives.some(item => item.canonicalPlanId === trace.selection.recommendedCanonicalPlanId));
      if (!existsElsewhere) violations.push("recommended_not_representative");
    }
  }
  if (trace.selection.finalSelectedCanonicalPlanId) {
    const candidate = trace.revisions.some(revision => revision.candidates.some(item => item.canonicalPlanId === trace.selection.finalSelectedCanonicalPlanId));
    const hardPassed = trace.revisions.some(revision => revision.hardFeasibility.some(item => item.canonicalPlanId === trace.selection.finalSelectedCanonicalPlanId && item.passed));
    if (!candidate) violations.push("final_selected_not_candidate");
    if (!hardPassed && trace.selection.finalAcceptance?.passed) violations.push("final_selected_not_hard_passed");
  } else if (trace.termination?.reason === "plan_selected") violations.push("selected_termination_without_selection");
  if (trace.explanation && trace.explanation.canonicalPlanId !== trace.selection.finalSelectedCanonicalPlanId) violations.push("explanation_not_final_selected");
  if (trace.termination?.reason === "no_feasible_plan" && trace.selection.finalSelectedCanonicalPlanId) violations.push("no_feasible_has_selection");
  if (trace.failure?.kind === "runtime_failure" && trace.termination?.reason === "no_feasible_plan") violations.push("runtime_failure_as_no_feasible");
  return violations;
}

export function projectExplanationEvidence(evidence: DecisionExplanationEvidence[] | undefined): DecisionExplanationEvidence[] | undefined {
  return evidence ? structuredClone(evidence) : undefined;
}
