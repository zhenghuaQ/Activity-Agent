import { describe, expect, it } from "vitest";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import { hashDecisionScenario } from "../eval/langsmith/dataset.js";
import { createDecisionScenarioSession } from "../eval/decision/evaluators/conversation.js";
import { evaluateDecisionScenario } from "../eval/decision/evaluators/conversation.js";
import { runDecisionTraceProbe } from "../eval/diagnostics/decision-trace-probe.js";
import { decisionTraceInvariantViolations, semanticDecisionTrace } from "../src/decision/trace.js";

function withoutProviderFetchTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProviderFetchTimes);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "fetchedAt").map(([key, item]) => [key, withoutProviderFetchTimes(item)]));
}

describe("DecisionTrace DQ-10", () => {
  it("records production candidate, feasibility, exact scores, objective representatives, selection, and evidence", async () => {
    const result = await runDecisionTraceProbe();
    expect(await runDecisionTraceProbe()).toEqual(result);
    expect(result).toMatchObject({
      version: "decision-trace-v1",
      candidateCount: 3,
      hardRejectedCount: 1,
      rejectedCodes: expect.arrayContaining(["within_distance"]),
      scoredCount: 2,
      rejectedNotScored: true,
      recommendedIsC: true,
      recommendedScoreHigherThanB: true,
      finalAcceptancePassed: true,
      selectedIsRecommended: true,
      explanationBelongsToSelected: true,
      invariantViolations: [],
      candidateOrderStable: true,
      privacySafe: true,
      objectiveCount: 4,
      noFeasible: { candidateCount: 2, rejectedCount: 2, scoredCount: 0, selected: null, termination: { reason: "no_feasible_plan" } },
      runtimeFailure: { status: "not_reached", failure: { kind: "runtime_failure" }, termination: null },
    });
    const objectives = (result.objectives as Array<{ objective: string }>).map(item => item.objective);
    expect(objectives).toEqual(["balanced", "experience", "time_saver", "budget_saver"]);
  });

  it("is opt-out and leaves the same Activity Agent decision result across all 12 scenarios", async () => {
    const hashesBefore = DECISION_SCENARIOS.map(hashDecisionScenario);
    const execute = async (scenario: (typeof DECISION_SCENARIOS)[number], enabled: boolean) => {
      const executionInput = {
        id: scenario.id,
        description: scenario.description,
        domain: scenario.domain,
        turns: structuredClone(scenario.turns),
        environment: structuredClone(scenario.environment),
        tags: [...scenario.tags],
      };
      const session = createDecisionScenarioSession(executionInput, true, `trace-${scenario.id}-${enabled}`, enabled);
      try {
        for (const turn of executionInput.turns) await session.runTurn(turn.user);
        return session.toOutput();
      } finally { session.dispose(); }
    };
    for (const [index, scenario] of DECISION_SCENARIOS.entries()) {
      const [withTrace, withoutTrace] = [await execute(scenario, true), await execute(scenario, false)];
      expect(withTrace.decisionTrace?.version, scenario.id).toBe("decision-trace-v1");
      expect(withTrace.decisionTrace && decisionTraceInvariantViolations(withTrace.decisionTrace), scenario.id).toEqual([]);
      expect(withoutTrace.decisionTrace, scenario.id).toBeUndefined();
      expect(withTrace.finalConstraints, scenario.id).toEqual(withoutTrace.finalConstraints);
      expect(withTrace.planningTermination, scenario.id).toEqual(withoutTrace.planningTermination);
      expect(withoutProviderFetchTimes(withTrace.selectedPlan), scenario.id).toEqual(withoutProviderFetchTimes(withoutTrace.selectedPlan));
      expect(withoutProviderFetchTimes(withTrace.finalDecision), scenario.id).toEqual(withoutProviderFetchTimes(withoutTrace.finalDecision));
      const withEval = evaluateDecisionScenario(scenario, withTrace, true);
      const withoutEval = evaluateDecisionScenario(scenario, withoutTrace, true);
      expect({ taskSuccess: withEval.taskSuccess, outcome: withEval.outcome, planningTermination: withEval.planningTermination }, scenario.id)
        .toEqual({ taskSuccess: withoutEval.taskSuccess, outcome: withoutEval.outcome, planningTermination: withoutEval.planningTermination });
      expect(hashDecisionScenario(scenario), scenario.id).toBe(hashesBefore[index]);
    }
  }, 120_000);

  it("semantic projection ignores temporary runtime plan IDs", () => {
    const trace = {
      version: "decision-trace-v1" as const,
      status: "complete" as const,
      revisions: [{ revision: 0, candidates: [{ canonicalPlanId: "identity", runtimePlanId: "plan_1", placeIds: ["p"], roleComposition: { attraction: 1 }, count: 1 }], hardFeasibility: [], scoredPlans: [{ canonicalPlanId: "identity", runtimePlanId: "plan_1", score: { total: 77, confidence: 0.9, dimensions: [] } }], representatives: [] }],
      selection: { fallbackUsed: false },
    };
    const second = structuredClone(trace);
    second.revisions[0]!.candidates[0]!.runtimePlanId = "plan_9";
    second.revisions[0]!.scoredPlans[0]!.runtimePlanId = "plan_9";
    expect(semanticDecisionTrace(trace)).toEqual(semanticDecisionTrace(second));
  });
});
