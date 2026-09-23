import { describe, expect, it } from "vitest";
import { constraintEngine } from "../src/constraints/engine.js";
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
    hardMaxKm: 10,
  },
  extraHints: [],
} satisfies StructuredConstraints;

function makePlan(distanceKm: number): Plan {
  const place: Place = {
    id: "p1",
    name: "测试景点",
    type: "attraction",
    crowdTags: ["kids"],
    localFeatures: ["scenic_spot"],
    address: "测试地址",
    distanceKm,
    location: { lat: 0, lng: 0, address: "测试地址", city: "测试城" },
    rating: 4.5,
  };

  const restaurant: Place = {
    ...place,
    id: "r1",
    name: "测试餐厅",
    type: "restaurant",
  };

  return {
    id: "plan-1",
    scenario: "family",
    leadRole: "kids",
    activities: [
      {
        order: 1,
        place,
        scheduledStart: "14:00",
        scheduledEnd: "16:00",
        status: "scheduled",
      },
      {
        order: 2,
        place: restaurant,
        scheduledStart: "16:10",
        scheduledEnd: "17:10",
        status: "scheduled",
      },
    ],
    totalDurationHours: 3.17,
    totalTransitMinutes: 0,
    feasibilityScore: 100,
    summary: "测试方案",
  };
}

describe("ConstraintEngine", () => {
  it("returns structured and explainable checks", () => {
    const result = constraintEngine.evaluatePlan(makePlan(5), constraints);

    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.some((check) => check.rule === "no_time_conflict")).toBe(true);
    expect(result.checks.some((check) => check.rule === "within_distance")).toBe(true);
    expect(result.checks.every((check) => typeof check.detail === "string")).toBe(true);
  });

  it("marks an over-distance plan as failed without changing the plan", () => {
    const plan = makePlan(20);
    const result = constraintEngine.evaluatePlan(plan, constraints);

    expect(result.passed).toBe(false);
    expect(result.checks.some((check) => check.rule === "within_distance" && !check.passed)).toBe(true);
    expect(plan.id).toBe("plan-1");
  });
});
