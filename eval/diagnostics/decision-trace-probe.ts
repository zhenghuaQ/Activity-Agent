import type { DecisionTrace } from "../../spec/decision-trace.js";
import type { Plan, PlanCandidate, StructuredConstraints } from "../../spec/types.js";
import { parseIntent } from "../../src/intent/parser.js";
import { evaluatePlanHardConstraints } from "../../src/constraints/engine.js";
import { runDecision } from "../../src/decision/index.js";
import { getObjectiveRepresentativeScores } from "../../src/decision/pareto.js";
import { getCanonicalPlanIdentity } from "../../src/decision/plan-identity.js";
import { decisionTraceInvariantViolations, finalizeDecisionTrace, projectDecisionConstraints, recordFallbackAttempt, recordFinalAcceptance, recordGeneratedCandidates, recordHardFeasibilityFromCandidates, recordRecommendedPlan, recordScoring, semanticDecisionTrace } from "../../src/decision/trace.js";
import { createDecisionTrace } from "../../spec/decision-trace.js";
import { DECISION_SCENARIOS } from "../decision/scenarios/cases.js";

function privacySafe(trace: DecisionTrace): boolean {
  const serialized = JSON.stringify(trace);
  return !/(rawText|userInput|transcript|latitude|longitude|"lat"|"lng"|api[_-]?key|authorization|stack|extraHints)/i.test(serialized)
    && !serialized.includes("周末和朋友")
    && !serialized.includes("31.2304");
}

export async function runDecisionTraceProbe(): Promise<Record<string, unknown>> {
  const scenario = DECISION_SCENARIOS.find(item => item.id === "solo_nearby");
  if (!scenario) throw new Error("decision_trace_probe_scenario_missing");
  const constraints = structuredClone(parseIntent("周末和朋友出去玩")) as StructuredConstraints;
  constraints.destination = { city: scenario.environment.location.location.city };
  constraints.distance.hardMaxKm = 5;
  const template = scenario.environment.data.attractions[0];
  const restaurantTemplate = scenario.environment.data.restaurants[0];
  if (!template || !restaurantTemplate) throw new Error("decision_trace_probe_fixture_incomplete");
  const createPlan = (id: string, distanceKm: number, rating: number): Plan => {
    const attraction = { ...structuredClone(template), id: `${id}-attraction`, distanceKm, rating };
    const restaurant = { ...structuredClone(restaurantTemplate), id: `${id}-restaurant`, distanceKm, rating };
    return {
      id,
      scenario: constraints.group.scenario,
      leadRole: constraints.group.leadRole,
      activities: [
        { order: 1, place: attraction, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" },
        { order: 2, place: restaurant, scheduledStart: "16:00", scheduledEnd: "18:00", status: "scheduled" },
      ],
      totalDurationHours: 4,
      totalTransitMinutes: 10,
      feasibilityScore: 90,
      summary: id,
    };
  };
  const plans = [createPlan("A", 50, 5), createPlan("B", 2, 2), createPlan("C", 2, 5)];
  const candidates: PlanCandidate[] = plans.map(plan => ({ plan, feasibilityScore: 90, reason: "diagnostic" }));
  const checks = candidates.map(candidate => ({
    candidateId: candidate.plan.id,
    planId: candidate.plan.id,
    ...evaluatePlanHardConstraints(candidate.plan, constraints),
  }));
  const trace = createDecisionTrace();
  trace.constraints = projectDecisionConstraints(constraints);
  trace.environment = { locationResolved: true, locationSource: scenario.environment.location.source };
  recordGeneratedCandidates(trace, 0, candidates);
  recordHardFeasibilityFromCandidates(trace, 0, candidates, checks);
  const hardValid = candidates.filter(candidate => checks.find(item => item.planId === candidate.plan.id)?.passed);
  const decision = await runDecision(hardValid, constraints, { date: new Date("2026-09-26T12:00:00.000Z"), weather: "clear" });
  if (!decision) throw new Error("decision_trace_probe_expected_decision");
  const representatives = getObjectiveRepresentativeScores(decision);
  recordScoring(trace, 0, hardValid, representatives.map(item => ({ objective: item.objective, candidate: item.plan, objectiveScore: item.score })));
  recordRecommendedPlan(trace, decision.recommended.plan);
  const acceptance = evaluatePlanHardConstraints(decision.recommended.plan, constraints);
  recordFinalAcceptance(trace, {
    selectedPlan: acceptance.passed ? decision.recommended.plan : undefined,
    passed: acceptance.passed,
    checks: acceptance.checks,
    failureCodes: acceptance.hardFailures.map(item => item.rule),
    explanation: decision.recommended.plan.explanation?.evidence,
  });
  finalizeDecisionTrace(trace, { reason: "plan_selected", code: "PLAN_SELECTED" });

  const fallbackTrace = structuredClone(trace);
  const alternateIdentity = revisionsForFallback(trace).find(item => item.canonicalPlanId !== trace.selection.recommendedCanonicalPlanId)?.canonicalPlanId;
  const fallbackPlan = candidates.find(candidate => getCanonicalPlanIdentity(candidate.plan) === alternateIdentity)?.plan;
  if (!fallbackPlan) throw new Error("decision_trace_probe_requires_pareto_alternative");
  recordFallbackAttempt(fallbackTrace, ["controlled_initial_guard_failure"]);
  const fallbackEvaluation = evaluatePlanHardConstraints(fallbackPlan, constraints);
  recordFinalAcceptance(fallbackTrace, {
    selectedPlan: fallbackPlan,
    passed: fallbackEvaluation.passed,
    checks: fallbackEvaluation.checks,
    failureCodes: fallbackEvaluation.hardFailures.map(item => item.rule),
    explanation: fallbackPlan.explanation?.evidence,
  });
  finalizeDecisionTrace(fallbackTrace, { reason: "plan_selected", code: "PLAN_SELECTED" });

  const noFeasibleTrace = createDecisionTrace();
  const invalidPlans = [createPlan("NF-A", 50, 4), createPlan("NF-B", 60, 4)];
  const invalidCandidates = invalidPlans.map(plan => ({ plan, feasibilityScore: 90, reason: "diagnostic" }));
  const invalidChecks = invalidCandidates.map(candidate => ({ candidateId: candidate.plan.id, planId: candidate.plan.id, ...evaluatePlanHardConstraints(candidate.plan, constraints) }));
  recordGeneratedCandidates(noFeasibleTrace, 0, invalidCandidates);
  recordHardFeasibilityFromCandidates(noFeasibleTrace, 0, invalidCandidates, invalidChecks);
  finalizeDecisionTrace(noFeasibleTrace, { reason: "no_feasible_plan", code: "NO_SELECTABLE_PLAN" });

  const failureTrace = createDecisionTrace();
  finalizeDecisionTrace(failureTrace, undefined, { kind: "runtime_failure" });

  const reversedCandidates = [...candidates].reverse();
  const reverseTrace = createDecisionTrace();
  reverseTrace.constraints = projectDecisionConstraints(constraints);
  reverseTrace.environment = structuredClone(trace.environment);
  recordGeneratedCandidates(reverseTrace, 0, reversedCandidates);
  recordHardFeasibilityFromCandidates(reverseTrace, 0, reversedCandidates, [...checks].reverse());
  // Semantic capture excludes temporary plan_N-style runtime IDs by design.
  const candidateOrderStable = JSON.stringify(semanticDecisionTrace({ ...trace, revisions: [{ ...trace.revisions[0]!, scoredPlans: [], representatives: [], hardFeasibility: [], candidates: trace.revisions[0]!.candidates }] }).revisions[0]?.candidates)
    === JSON.stringify(semanticDecisionTrace(reverseTrace).revisions[0]?.candidates);
  const revisions = trace.revisions[0]!;
  const noFeasibleRevision = noFeasibleTrace.revisions[0]!;
  const result = {
    version: trace.version,
    candidateCount: revisions.candidates.length,
    hardRejectedCount: revisions.hardFeasibility.filter(item => !item.passed).length,
    rejectedCodes: revisions.hardFeasibility.find(item => item.canonicalPlanId === getCanonicalPlanIdentity(plans[0]!))?.hardFailures.map(item => item.code) ?? [],
    scoredCount: revisions.scoredPlans.length,
    rejectedNotScored: !revisions.scoredPlans.some(item => item.canonicalPlanId === getCanonicalPlanIdentity(plans[0]!)),
    recommendedIsC: trace.selection.recommendedCanonicalPlanId === getCanonicalPlanIdentity(plans[2]!),
    recommendedScoreHigherThanB: Number(plans[2]!.score?.total) > Number(plans[1]!.score?.total),
    objectives: revisions.representatives.map(item => ({ objective: item.objective, canonicalPlanId: item.canonicalPlanId, score: item.objectiveScore })),
    finalAcceptancePassed: trace.selection.finalAcceptance?.passed,
    selectedIsRecommended: trace.selection.finalSelectedCanonicalPlanId === trace.selection.recommendedCanonicalPlanId,
    termination: trace.termination,
    explanationBelongsToSelected: trace.explanation?.canonicalPlanId === trace.selection.finalSelectedCanonicalPlanId,
    invariantViolations: decisionTraceInvariantViolations(trace),
    candidateOrderStable,
    privacySafe: privacySafe(trace),
    noFeasible: {
      candidateCount: noFeasibleRevision.candidates.length,
      rejectedCount: noFeasibleRevision.hardFeasibility.filter(item => !item.passed).length,
      scoredCount: noFeasibleRevision.scoredPlans.length,
      selected: noFeasibleTrace.selection.finalSelectedCanonicalPlanId ?? null,
      termination: noFeasibleTrace.termination,
    },
    runtimeFailure: { status: failureTrace.status, failure: failureTrace.failure, termination: failureTrace.termination ?? null },
    objectiveCount: revisions.representatives.length,
    fallback: {
      recommendedIsC: fallbackTrace.selection.recommendedCanonicalPlanId === getCanonicalPlanIdentity(plans[2]!),
      finalSelectedIsAlternate: fallbackTrace.selection.finalSelectedCanonicalPlanId === alternateIdentity,
      fallbackUsed: fallbackTrace.selection.fallbackUsed,
      failureCodes: fallbackTrace.selection.fallbackFailureCodes,
    },
  };
  return result;
}

function revisionsForFallback(trace: DecisionTrace) {
  return trace.revisions.flatMap(revision => revision.representatives);
}
