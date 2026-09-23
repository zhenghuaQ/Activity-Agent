import { describe, expect, it } from "vitest";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import { createScenarioRuntime } from "../eval/decision/scenarios/runtime.js";
import { validateDecisionScenarios } from "../eval/decision/scenarios/validate.js";
import { scenarioHasFeasibleFixturePlan } from "../eval/decision/scenarios/validate.js";
import { runConversationCase } from "../eval/decision/evaluators/conversation.js";
import {
  classifyDecisionOutcome,
  runtimeCompletedWithoutInfrastructureFailure,
  type DecisionRuntimeEvidence,
} from "../eval/decision/outcome.js";

const completedNoPlanEvidence: DecisionRuntimeEvidence = {
  status: "failed",
  finalEvent: { status: "failed", success: false },
  terminalTransitionReason: "planner_finished",
  completedSteps: ["context_resolution", "intent_parsing", "follow_up_questions", "candidate_generation", "feasibility_check", "fine_scheduling"],
  agentErrors: [],
  toolCalls: [{ status: "success" }],
  planningTermination: { reason: "no_feasible_plan", code: "NO_CANDIDATES" },
  diagnostics: ["无候选方案可校验", "无可选方案"],
  planGenerated: false,
};

describe("Decision Scenario V3 dataset", () => {
  it("validates the fixed scenario dataset", () => {
    expect(validateDecisionScenarios(DECISION_SCENARIOS)).toHaveLength(12);
    expect(DECISION_SCENARIOS.filter(scenario => scenario.expectations.expectedFeasibility === "feasible")).toHaveLength(11);
    expect(DECISION_SCENARIOS.filter(scenario => scenario.expectations.expectedFeasibility === "infeasible")).toHaveLength(1);
  });

  it("rejects duplicate scenario ids", () => {
    expect(() => validateDecisionScenarios([DECISION_SCENARIOS[0], DECISION_SCENARIOS[0]])).toThrow("duplicate_scenario_id");
  });

  it("rejects invalid fixture coordinates", () => {
    const scenario = structuredClone(DECISION_SCENARIOS[0]);
    scenario.environment.data.attractions[0].location.lat = 999;
    expect(() => validateDecisionScenarios([scenario])).toThrow("invalid_lat");
  });

  it("rejects an adaptation that points beyond the conversation", () => {
    const scenario = structuredClone(DECISION_SCENARIOS[0]);
    scenario.expectations.adaptations![0].afterTurn = 99;
    expect(() => validateDecisionScenarios([scenario])).toThrow("invalid_adaptation_turn");
  });

  it("keeps Scenario A/B runtime environments isolated concurrently", async () => {
    const [shanghai, beijing] = await Promise.all([
      runConversationCase(DECISION_SCENARIOS.find(scenario => scenario.id === "shanghai_couple_japanese")!, true),
      runConversationCase(DECISION_SCENARIOS.find(scenario => scenario.id === "friends_cuisine_update")!, true),
    ]);
    expect(shanghai.finalConstraints?.destination?.city).toBe("上海");
    expect(beijing.finalConstraints?.destination).toBeUndefined();
    expect(shanghai.candidateIds.every(id => id.startsWith("shanghai_fixture_"))).toBe(true);
    expect(beijing.candidateIds.every(id => id.startsWith("beijing_fixture_"))).toBe(true);
  });

  it("treats the explicit no-feasible scenario as a hard-constraint pass", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.id === "hard_distance_limit")!;
    const result = await runConversationCase(scenario, true);
    expect(result.outcome).toBe("no_feasible_plan");
    expect(result.runtimeCompleted).toBe(true);
    expect(result.planGenerated).toBe(false);
    expect(result.taskSuccess).toBe(true);
    expect(result.hardConstraintsPassed).toBe(true);
    expect(result.hardConstraintViolations).toBe(0);
  });

  it("proves the no-feasible fixture has no attraction/restaurant pair within its hard limit", () => {
    const scenario = DECISION_SCENARIOS.find(item => item.id === "hard_distance_limit")!;
    expect(scenarioHasFeasibleFixturePlan(scenario)).toBe(false);
    expect(() => validateDecisionScenarios([scenario])).not.toThrow();
  });

  it("classifies correct and incorrect plan outcomes against explicit feasibility", () => {
    const classify = (expectedFeasibility: "feasible" | "infeasible", planGenerated: boolean, hardConstraintsPassed = true) =>
      classifyDecisionOutcome({ expectedFeasibility, runtimeCompleted: true,
        planningTermination: planGenerated
          ? { reason: "plan_selected", code: "PLAN_SELECTED" }
          : { reason: "no_feasible_plan", code: "NO_CANDIDATES" },
        planGenerated, hardConstraintsPassed });
    expect(classify("feasible", true)).toBe("feasible_plan");
    expect(classify("feasible", false)).toBe("missed_feasible_plan");
    expect(classify("feasible", true, false)).toBe("invalid_plan");
    expect(classify("infeasible", false)).toBe("no_feasible_plan");
    expect(classify("infeasible", true, false)).toBe("invalid_plan");
    expect(classifyDecisionOutcome({ expectedFeasibility: "infeasible", runtimeCompleted: true,
      planGenerated: false, hardConstraintsPassed: true })).toBe("runtime_failure");
  });

  it("does not treat provider or location failures as completed no-feasible decisions", () => {
    expect(runtimeCompletedWithoutInfrastructureFailure(completedNoPlanEvidence)).toBe(true);
    expect(classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: false,
      planGenerated: false,
      hardConstraintsPassed: true,
    })).toBe("runtime_failure");

    expect(runtimeCompletedWithoutInfrastructureFailure({
      ...completedNoPlanEvidence,
      toolCalls: [{ status: "error" }],
    })).toBe(false);
    expect(runtimeCompletedWithoutInfrastructureFailure({
      ...completedNoPlanEvidence,
      completedSteps: ["context_resolution"],
      agentErrors: ["context_resolution 失败 [E_EXECUTION_FAILED] provider down"],
    })).toBe(false);
    expect(runtimeCompletedWithoutInfrastructureFailure({
      ...completedNoPlanEvidence,
      planningTermination: undefined,
      completedSteps: ["context_resolution"],
      agentErrors: ["provider failed"],
    })).toBe(false);
  });

  it("classifies from termination independently of human-readable diagnostics", () => {
    const result = classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: runtimeCompletedWithoutInfrastructureFailure(completedNoPlanEvidence),
      planningTermination: completedNoPlanEvidence.planningTermination,
      planGenerated: false,
      hardConstraintsPassed: true,
    });
    const changedText = {
      ...completedNoPlanEvidence,
      diagnostics: ["Search was empty for another domain reason", "Plan was not generated"],
    };
    const sameResult = classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: runtimeCompletedWithoutInfrastructureFailure(changedText),
      planningTermination: changedText.planningTermination,
      planGenerated: false,
      hardConstraintsPassed: true,
    });
    expect(sameResult).toBe(result);
    expect(result).toBe("no_feasible_plan");
  });

  it("produces deterministic constraints, candidates, and evaluator result", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.id === "preference_correction")!;
    const first = await runConversationCase(scenario, true);
    const second = await runConversationCase(scenario, true);
    expect(first.finalConstraints).toEqual(second.finalConstraints);
    expect(first.candidateIds).toEqual(second.candidateIds);
    expect(first.hardConstraintsPassed).toBe(second.hardConstraintsPassed);
    expect(first.adaptationChecks).toBe(second.adaptationChecks);
    expect(first.adaptationErrors).toBe(second.adaptationErrors);
    expect(first.outcome).toBe(second.outcome);
    expect(first.planningTermination).toEqual(second.planningTermination);
    expect(first.taskSuccess).toBe(second.taskSuccess);
    expect(first.runtimeCompleted).toBe(second.runtimeCompleted);
    expect(first.planGenerated).toBe(second.planGenerated);
  });

  it("keeps all originally feasible scenarios successful", async () => {
    const scenarios = DECISION_SCENARIOS.filter(scenario => scenario.expectations.expectedFeasibility === "feasible");
    const results = await Promise.all(scenarios.map(scenario => runConversationCase(scenario, true)));
    expect(results).toHaveLength(11);
    expect(results.every(result => result.outcome === "feasible_plan"
      && result.taskSuccess
      && result.runtimeCompleted
      && result.planGenerated)).toBe(true);
  });

  it("creates an independent provider and location resolver for each scenario", () => {
    const first = createScenarioRuntime(DECISION_SCENARIOS[0]);
    const second = createScenarioRuntime(DECISION_SCENARIOS[1]);
    expect(first.dataProvider).not.toBe(second.dataProvider);
    expect(first.locationResolver).not.toBe(second.locationResolver);
    first.runtime.shutdown();
    second.runtime.shutdown();
  });
});
