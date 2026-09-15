import { describe, expect, it } from "vitest";
import { createAgentState } from "../spec/agent.js";
import { constraintEngine } from "../src/constraints/engine.js";
import { applyReplanPatch, decideReplan } from "../src/runtime/replanner.js";
import { evaluateAgentState } from "../src/runtime/evaluator.js";
import type { Place, Plan, StructuredConstraints } from "../spec/types.js";

const constraints = {
  group: {
    scenario: "family",
    totalPeople: 3,
    maleCount: 1,
    femaleCount: 2,
    ageGroup: { youngChildren: 1, teens: 0, adults: 2, seniors: 0 },
    leadRole: "kids",
    preferences: {
      dieting: true,
      dietaryRestrictions: [],
      inferredDietary: {
        lightDiet: false,
        kidsFriendly: true,
        lowCalorie: true,
        softFood: false,
        restrictions: [],
      },
    },
  },
  timeWindow: { start: "14:00", end: "18:00", durationHours: 4 },
  distance: {
    maxKm: 10,
    homeLocation: { lat: 0, lng: 0, address: "起点", city: "测试城" },
  },
  extraHints: [],
} satisfies StructuredConstraints;

function plan(distanceKm: number): Plan {
  const place: Place = {
    id: "a1", name: "景点", type: "attraction",
    crowdTags: ["kids"], localFeatures: ["scenic_spot"], address: "地址",
    distanceKm, location: { lat: 0, lng: 0, address: "地址", city: "测试城" }, rating: 4.5,
  };
  const restaurant: Place = { ...place, id: "r1", name: "餐厅", type: "restaurant" };
  return {
    id: "p1", scenario: "family", leadRole: "kids",
    activities: [
      { order: 1, place, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" },
      { order: 2, place: restaurant, scheduledStart: "16:10", scheduledEnd: "17:10", status: "scheduled" },
    ],
    totalDurationHours: 3.17, totalTransitMinutes: 0, feasibilityScore: 100, summary: "测试方案",
  };
}

describe("Runtime Evaluation / Replan", () => {
  it("evaluates the final selected plan through ConstraintEngine", () => {
    const state = createAgentState({ rawText: "test" });
    state.planning = {
      stage: "fine_scheduling",
      constraints,
      selectedPlan: plan(5),
      candidates: [],
      errors: [],
    };
    const result = evaluateAgentState(state);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.evaluation).toBeDefined();
  });

  it("turns an over-distance failure into a bounded replan decision", () => {
    const state = createAgentState({ rawText: "test" });
    state.planning = {
      stage: "fine_scheduling",
      constraints,
      selectedPlan: plan(20),
      candidates: [],
      errors: [],
    };
    const evaluation = constraintEngine.evaluatePlan(plan(20), constraints);
    const decision = decideReplan(state, evaluation.checks.filter((x) => !x.passed));
    expect(decision.shouldReplan).toBe(true);
    expect(decision.patch?.searchRadiusKm).toBeGreaterThan(10);
    expect(decision.nextPlan?.steps.map((x) => x.type)).toEqual([
      "candidate_generation", "feasibility_check", "fine_scheduling",
    ]);
  });

  it("changes search policy without changing the user distance constraint", () => {
    const state = createAgentState({ rawText: "附近十公里" });
    state.planning = {
      stage: "fine_scheduling",
      constraints,
      searchPolicy: { radiusKm: 10 },
      planRevision: 0,
      selectedPlan: plan(20),
      decision: { recommended: {} } as never,
      candidates: [{ plan: plan(20), score: 1 } as never],
      errors: [],
    };

    const decision = decideReplan(state, [
      { passed: false, rule: "within_distance", detail: "20km > 10km" },
    ]);
    const next = applyReplanPatch(state, decision.patch);

    expect(next.planning.constraints?.distance.maxKm).toBe(10);
    expect(next.planning.searchPolicy?.radiusKm).toBeGreaterThan(10);
    expect(next.planning.selectedPlan).toBeUndefined();
    expect(next.planning.decision).toBeUndefined();
    expect(next.planning.candidates).toBeUndefined();
    expect(next.planning.planRevision).toBe(1);
  });

  it("cannot accept the stale plan when a replan produces no replacement", () => {
    const state = createAgentState({ rawText: "附近十公里" });
    state.planning = {
      stage: "fine_scheduling",
      constraints,
      searchPolicy: { radiusKm: 10 },
      selectedPlan: plan(20),
      errors: [],
    };

    const next = applyReplanPatch(state, { searchRadiusKm: 16 });
    const evaluation = evaluateAgentState(next);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures[0].rule).toBe("missing_final_plan");
  });
});
