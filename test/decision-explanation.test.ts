import { describe, expect, it } from "vitest";
import { runExplanationFidelityProbe } from "../eval/diagnostics/explanation-probe.js";
import { buildPlanExplanation, explainNoFeasiblePlan, explainPlanningFailure } from "../src/decision/explanation.js";
import { createBeijingFixture } from "../eval/decision/scenarios/fixtures/beijing.js";
import { parseIntent } from "../src/intent/parser.js";
import type { Plan } from "../spec/types.js";

describe("evidence-grounded decision explanations", () => {
  it("passes the targeted false-positive, provenance, and stability probes", () => {
    const probe = runExplanationFidelityProbe();
    expect(Object.values(probe).every(value => value === true)).toBe(true);
  });

  it("renders only selected-plan matched evidence and leaves the plan untouched", () => {
    const fixture = createBeijingFixture("explanation test");
    const attraction = structuredClone(fixture.attractions[0]!);
    attraction.localFeatures = ["local_craft"];
    const restaurant = structuredClone(fixture.restaurants[0]!);
    restaurant.cuisine = "火锅";
    const plan: Plan = {
      id: "selected", scenario: "friends", leadRole: "friends_group", summary: "selected",
      totalDurationHours: 3, totalTransitMinutes: 0, feasibilityScore: 100,
      activities: [
        { order: 1, place: attraction, scheduledStart: "10:00", scheduledEnd: "11:00", status: "scheduled", transitTo: null },
        { order: 2, place: restaurant, scheduledStart: "11:15", scheduledEnd: "12:00", status: "scheduled", transitTo: null },
      ],
      score: { total: 77, confidence: 0.8, dimensions: [] },
    };
    const before = structuredClone(plan);
    const constraints = parseIntent("周末出去，想吃日料");
    constraints.group.preferences.preferredCuisine = ["日料"];
    constraints.extraHints.push("local_tea");
    const explanation = buildPlanExplanation(plan, constraints);
    expect(explanation.evidence?.map(item => item.code)).not.toContain("preferred_cuisine_matched");
    expect(explanation.evidence?.map(item => item.code)).not.toContain("requested_local_feature_matched");
    expect(explanation.highlights.join(" ")).not.toContain("日料");
    expect(explanation.whyNotOthers).toBeUndefined();
    expect(plan).toEqual(before);
  });

  it("distinguishes unknown dietary support and infrastructure failure from business infeasibility", () => {
    const constraints = parseIntent("周末出去，不能吃海鲜");
    constraints.group.preferences.dietaryRestrictions = ["免海鲜"];
    const noFeasible = explainNoFeasiblePlan(constraints, [{
      candidateId: "unknown", planId: "unknown", passed: false, checks: [],
      hardFailures: [{ passed: false, rule: "dietary_requirements_satisfied", detail: "unknown", dietaryEvidence: [
        { restaurantId: "r1", requirement: "免海鲜", status: "unknown" },
      ] }],
    }]);
    expect(noFeasible).toContain("无法确认");
    expect(noFeasible).not.toContain("不支持");
    expect(explainPlanningFailure(undefined, constraints, [])).toContain("规划未能完成");
    expect(explainPlanningFailure(undefined, constraints, [])).not.toContain("没有找到");
  });
});
