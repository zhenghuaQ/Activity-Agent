import { describe, expect, it } from "vitest";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import { createScenarioRuntime } from "../eval/decision/scenarios/runtime.js";
import { validateDecisionScenarios } from "../eval/decision/scenarios/validate.js";
import { scenarioHasFeasibleFixturePlan } from "../eval/decision/scenarios/validate.js";
import { runConversationCase } from "../eval/decision/evaluators/conversation.js";
import { runScenarioManual } from "../eval/decision/evaluators/conversation.js";
import { DECISION_BENCHMARK_VERSION } from "../eval/decision/scenarios/schema.js";
import { hashDecisionScenario } from "../eval/langsmith/dataset.js";
import { evaluateRestaurantDietaryCompatibility } from "../src/constraints/dietary.js";
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
    expect(DECISION_BENCHMARK_VERSION).toBe("decision-v3.1");
    expect(validateDecisionScenarios(DECISION_SCENARIOS)).toHaveLength(12);
    expect(DECISION_SCENARIOS.filter(scenario => scenario.expectations.expectedFeasibility === "feasible")).toHaveLength(11);
    expect(DECISION_SCENARIOS.filter(scenario => scenario.expectations.expectedFeasibility === "infeasible")).toHaveLength(1);
  });

  it("migrates only the two declared dietary fixtures without changing turns or expectations", () => {
    const elderly = DECISION_SCENARIOS.find(scenario => scenario.id === "elderly_dietary_retention")!;
    const update = DECISION_SCENARIOS.find(scenario => scenario.id === "dietary_restriction_update")!;
    expect(elderly.turns.map(turn => turn.user)).toEqual([
      "周末带爸妈出去走走，吃得清淡些", "预算省一点，附近就好", "另外不吃海鲜",
    ]);
    expect(update.turns.map(turn => turn.user)).toEqual([
      "周末带爸妈吃得清淡些", "另外不吃海鲜，也不吃辣",
    ]);
    expect(elderly.expectations).toMatchObject({
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "elderly", budget: "low", dietaryRestrictions: ["轻油盐", "免海鲜"] },
      hardConstraints: { maxDistanceKm: 15, dietaryRestrictions: ["免海鲜"] },
    });
    expect(update.expectations).toMatchObject({
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "elderly", dietaryRestrictions: ["轻油盐", "免海鲜", "免辣"] },
      hardConstraints: { dietaryRestrictions: ["免海鲜", "免辣"] },
    });
    expect(elderly.environment.data.restaurants.find(place => place.id.endsWith("rest_005")))
      .toMatchObject({ id: "beijing_fixture_elderly_rest_005", name: expect.stringContaining("Beijing Fixture Elderly"), dietaryOptions: true, supportedDietaryRestrictions: ["轻油盐", "免海鲜"] });
    expect(update.environment.data.restaurants.find(place => place.id.endsWith("rest_005")))
      .toMatchObject({ id: "beijing_fixture_dietary_rest_005", name: expect.stringContaining("Beijing Fixture Dietary"), dietaryOptions: true, supportedDietaryRestrictions: ["轻油盐", "免海鲜", "免辣"] });
  });

  it("fails fast when feasible hard dietary requirements lack one restaurant with all evidence", () => {
    const missing = structuredClone(DECISION_SCENARIOS.find(scenario => scenario.id === "elderly_dietary_retention")!);
    const supported = missing.environment.data.restaurants.find(place => place.id.endsWith("rest_005"))!;
    supported.supportedDietaryRestrictions = ["轻油盐"];
    expect(() => validateDecisionScenarios([missing])).toThrow("BENCHMARK_FIXTURE_DIETARY_GAP");

    const split = structuredClone(DECISION_SCENARIOS.find(scenario => scenario.id === "dietary_restriction_update")!);
    const seafoodOnly = split.environment.data.restaurants.find(place => place.id.endsWith("rest_005"))!;
    seafoodOnly.supportedDietaryRestrictions = ["轻油盐", "免海鲜"];
    const spicyOnly = structuredClone(split.environment.data.restaurants[0]!);
    spicyOnly.id = "synthetic-spicy-only";
    spicyOnly.supportedDietaryRestrictions = ["免辣"];
    split.environment.data.restaurants.push(spicyOnly);
    expect(() => validateDecisionScenarios([split])).toThrow("BENCHMARK_FIXTURE_DIETARY_GAP");
  });

  it("preserves ten legacy scenario hashes and changes only the two migrated fixture hashes", () => {
    const v30Hashes: Record<string, string> = {
      shanghai_couple_japanese: "13a4a1387777d1ecfc55e83111a6c13d1b3662742670407d3a1413a4d07d9290",
      elderly_dietary_retention: "ea65a2e2302a4ea4058e59e5c9a369f4d034c3416b20b1b7e2c4720484048ce1",
      preference_correction: "62086148ca07feeb56f9eb1ec2b3525725939a2552dea588c612ad57d665122f",
      family_kid_dietary: "6b5cd265348ebd24e37b5da016fcc9abde9a3014acecf4a0dea12a917b2c5aef",
      friends_cuisine_update: "ca6f221085f9c586ea175a1e08605bf0a1a3f7c6bd586c70be7604d9288e41bf",
      solo_nearby: "cfc88c62971b05f0df47427181cd65e7806d1600f5f35e87420d3f58715e5e77",
      hard_distance_limit: "e961a52236da6acdc6254e534ea3fe16803f450c6aad4ec018c9058e5a112d86",
      destination_retention_shanghai: "b457a726bc5ad8922bdbe58304c5cee458592a3cc5e24432bbd29939126ca500",
      irrelevant_information: "a4469e568a66153a6d2425c59bc7a12773f4d346f06408b3eda1ac25467aa9fb",
      dietary_restriction_update: "41a18607fdf106ee789745ed5bd4336537584c6bb30ef2e6fa78dcb1d46e3fe5",
      soft_distance_relaxation: "8acc9176707828764b1f619a53f7d8a7ee93618ae9ac7dafaf6357524b9eb748",
      cuisine_to_dietary: "59581b668aaa410182d1f6db85ab8be10ec797fd835f70634aae0da75ce11e52",
    };
    const migrated = new Set(["elderly_dietary_retention", "dietary_restriction_update"]);
    for (const scenario of DECISION_SCENARIOS) {
      if (migrated.has(scenario.id)) expect(hashDecisionScenario(scenario)).not.toBe(v30Hashes[scenario.id]);
      else expect(hashDecisionScenario(scenario)).toBe(v30Hashes[scenario.id]);
    }
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

  it("keeps all feasible benchmark scenarios successful and verifies migrated selected restaurants", async () => {
    const scenarios = DECISION_SCENARIOS.filter(scenario => scenario.expectations.expectedFeasibility === "feasible");
    const results = await Promise.all(scenarios.map(scenario => runConversationCase(scenario, true)));
    expect(results).toHaveLength(11);
    expect(results.every(result => result.outcome === "feasible_plan"
      && result.taskSuccess && result.runtimeCompleted && result.planGenerated)).toBe(true);
    for (const id of ["elderly_dietary_retention", "dietary_restriction_update"]) {
      const scenario = DECISION_SCENARIOS.find(item => item.id === id)!;
      const execution = await runScenarioManual(scenario, true);
      const restaurant = execution.selectedPlan?.activities.find(activity => activity.place.type === "restaurant")?.place;
      expect(restaurant?.type).toBe("restaurant");
      expect(restaurant?.id).toBe(id === "elderly_dietary_retention"
        ? "beijing_fixture_elderly_rest_005"
        : "beijing_fixture_dietary_rest_005");
      expect(evaluateRestaurantDietaryCompatibility(
        restaurant as import("../spec/types.js").Restaurant,
        execution.finalConstraints!.group.preferences.dietaryRestrictions,
      ).requirements.every(result => result.status === "supported")).toBe(true);
    }
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
