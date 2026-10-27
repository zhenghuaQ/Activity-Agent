import { describe, expect, it } from "vitest";
import type { Plan, PlanCandidate, StructuredConstraints } from "../spec/types.js";
import type { Restaurant } from "../spec/types.js";
import { evaluatePlanHardConstraints } from "../src/constraints/engine.js";
import { stage4_feasibilityCheck, stage5_selectBest } from "../src/planner/stages.js";
import { getCanonicalPlanIdentity } from "../src/decision/plan-identity.js";
import { createAgentState } from "../spec/agent.js";
import { acceptSelectedPlan } from "../src/runtime/evaluator.js";
import { computePlanElapsedMinutes, minutesToTime } from "../spec/constraints.js";
import { parseIntent } from "../src/intent/parser.js";
import { mergeTurnConstraints } from "../src/conversation/memory.js";

const constraints: StructuredConstraints = {
  destination: { city: "北京" },
  group: {
    scenario: "friends",
    totalPeople: 2,
    maleCount: 1,
    femaleCount: 1,
    ageGroup: { youngChildren: 0, teens: 0, adults: 2, seniors: 0 },
    leadRole: "friends_group",
    preferences: {
      dieting: false,
      dietaryRestrictions: [],
      inferredDietary: { lowCalorie: false, lightDiet: false, softFood: false, kidsFriendly: false, restrictions: [] },
    },
  },
  timeWindow: { start: "14:00", end: "20:00", durationHours: 5 },
  distance: { hardMaxKm: 5 },
  extraHints: [],
};

function plan(id: string, city: string, distanceKm: number, rating: number): Plan {
  const base = {
    crowdTags: ["friends" as const],
    localFeatures: ["scenic_spot" as const],
    address: `${city}测试地址`,
    distanceKm,
    location: { lat: 39.9, lng: 116.4, address: `${city}测试地址`, city },
    rating,
    pricePerPerson: 80,
  };
  const attraction = {
    ...base, id: `${id}-attraction`, name: `${id}景点`, type: "attraction" as const,
    durationMinutes: 90, indoor: true, availableSlots: [{ start: "12:00", end: "21:00" }],
  };
  const restaurant = {
    ...base, id: `${id}-restaurant`, name: `${id}餐厅`, type: "restaurant" as const,
    cuisine: "中餐", tags: [], avgDurationMinutes: 60, hasQueue: false, queueCount: 0, dietaryOptions: true,
  };
  return {
    id, scenario: "friends", leadRole: "friends_group",
    activities: [
      { order: 1, place: attraction, scheduledStart: "14:00", scheduledEnd: "15:30", status: "scheduled" },
      { order: 2, place: restaurant, scheduledStart: "16:00", scheduledEnd: "17:00", status: "scheduled" },
    ],
    totalDurationHours: 3, totalTransitMinutes: 10, feasibilityScore: 90, summary: id,
  };
}

function candidate(value: Plan): PlanCandidate {
  return { plan: value, feasibilityScore: value.feasibilityScore, reason: value.summary };
}

function withElapsedMinutes(value: Plan, elapsedMinutes: number): Plan {
  const cloned = structuredClone(value);
  cloned.activities[cloned.activities.length - 1]!.scheduledEnd = minutesToTime(
    Number(cloned.activities[0]!.scheduledStart.slice(0, 2)) * 60
      + Number(cloned.activities[0]!.scheduledStart.slice(3)) + elapsedMinutes,
  );
  return cloned;
}

describe("hard feasibility before plan selection", () => {
  it("filters a higher-rated distance violator before Stage 5 and Pareto while retaining evidence", async () => {
    const invalid = candidate(plan("invalid-high-score", "北京", 6, 5));
    const valid = candidate(plan("valid-lower-score", "北京", 4, 3.5));
    expect(getCanonicalPlanIdentity(invalid.plan) < getCanonicalPlanIdentity(valid.plan)).toBe(true);
    const state = {
      stage: "candidate_generation" as const,
      constraints,
      candidates: [invalid, valid],
      errors: [],
    };

    const stage4 = await stage4_feasibilityCheck(state);
    expect(stage4.candidates?.map(item => item.plan.id)).toEqual(["valid-lower-score"]);
    expect(stage4.rejectedCandidates).toHaveLength(1);
    expect(stage4.rejectedCandidates?.[0]).toMatchObject({
      candidateId: "invalid-high-score", planId: "invalid-high-score", passed: false,
    });
    expect(stage4.rejectedCandidates?.[0]?.hardFailures.map(failure => failure.rule)).toContain("within_distance");

    const stage5 = await stage5_selectBest(stage4);
    expect(stage5.decision?.pareto.map(item => item.plan.id)).toEqual(["valid-lower-score"]);
    expect(stage5.selectedPlan?.id).toBe("valid-lower-score");

    const guardedStage5 = await stage5_selectBest({ ...state, candidates: [invalid, valid] });
    expect(guardedStage5.decision?.pareto.some(item => item.plan.id === "invalid-high-score")).toBe(false);
    expect(guardedStage5.selectedPlan?.id).toBe("valid-lower-score");
  });

  it("filters a high-score wrong-destination plan and keeps the correct-destination alternative", async () => {
    const invalid = candidate(plan("wrong-city-high-score", "上海", 2, 5));
    const valid = candidate(plan("beijing-lower-score", "北京", 3, 3.5));
    const stage4 = await stage4_feasibilityCheck({
      stage: "candidate_generation", constraints, candidates: [invalid, valid], errors: [],
    });
    expect(stage4.candidates?.map(item => item.plan.id)).toEqual(["beijing-lower-score"]);
    expect(stage4.rejectedCandidates?.[0]?.hardFailures.map(failure => failure.rule)).toContain("within_destination");
    const stage5 = await stage5_selectBest(stage4);
    expect(stage5.decision?.pareto.every(item => item.plan.id !== "wrong-city-high-score")).toBe(true);
    expect(stage5.selectedPlan?.id).toBe("beijing-lower-score");
  });

  it("does not treat generic dietaryOptions as proof of a specific dietary requirement", () => {
    const withDietary = structuredClone(constraints);
    withDietary.group.preferences.dietaryRestrictions = ["免海鲜"];
    const genericOnly = plan("dietary", "北京", 3, 4);
    const evaluation = evaluatePlanHardConstraints(genericOnly, withDietary);
    expect(evaluation.checks.find(check => check.rule === "dietary_requirements_satisfied")?.passed).toBe(false);
    expect(evaluation.checks.find(check => check.rule === "dietary_requirements_satisfied")?.dietaryEvidence)
      .toContainEqual({ restaurantId: "dietary-restaurant", requirement: "免海鲜", status: "unknown" });
    expect(evaluation.passed).toBe(false);
  });

  it("ANDs specific dietary requirements and filters the higher-score incompatible plan before Stage 5", async () => {
    const requirements = structuredClone(constraints);
    requirements.group.preferences.dietaryRestrictions = ["免海鲜", "免辣"];
    const invalid = candidate(plan("generic-high-score", "北京", 3, 5));
    invalid.plan.activities[1]!.place = ({
      ...(invalid.plan.activities[1]!.place as Restaurant),
      dietaryOptions: true,
      supportedDietaryRestrictions: ["免海鲜"],
    } as Restaurant);
    const valid = candidate(plan("both-lower-score", "北京", 3, 3));
    valid.plan.activities[1]!.place = ({
      ...(valid.plan.activities[1]!.place as Restaurant),
      supportedDietaryRestrictions: ["免海鲜", "免辣"],
    } as Restaurant);
    const stage4 = await stage4_feasibilityCheck({ stage: "candidate_generation", constraints: requirements, candidates: [invalid, valid], errors: [] });
    expect(stage4.candidates?.map(item => item.plan.id)).toEqual(["both-lower-score"]);
    expect(stage4.rejectedCandidates?.[0]?.hardFailures[0]?.dietaryEvidence).toEqual([
      { restaurantId: "generic-high-score-restaurant", requirement: "免海鲜", status: "supported" },
      { restaurantId: "generic-high-score-restaurant", requirement: "免辣", status: "unknown" },
    ]);
    const selected = await stage5_selectBest(stage4);
    expect(selected.selectedPlan?.id).toBe("both-lower-score");
  });

  it("leaves restaurant feasibility unchanged when no specific dietary requirement exists", () => {
    const noDietary = structuredClone(constraints);
    const genericOnly = plan("no-dietary", "北京", 3, 4);
    const evaluation = evaluatePlanHardConstraints(genericOnly, noDietary);
    expect(evaluation.checks.some(check => check.rule === "dietary_requirements_satisfied")).toBe(false);
    expect(evaluation.passed).toBe(true);
  });

  it("does not treat preferredMaxKm or budget score preference as a hard failure", () => {
    const softOnly = structuredClone(constraints);
    softOnly.distance = { preferredMaxKm: 1 };
    softOnly.group.preferences.budget = "low";
    expect(evaluatePlanHardConstraints(plan("soft-miss", "北京", 4, 4), softOnly).passed).toBe(true);
  });

  it("final acceptance guard rejects an injected invalid selected plan", () => {
    const invalid = plan("injected-final-invalid", "上海", 6, 5);
    const state = createAgentState({ rawText: "test" });
    state.planning = { stage: "fine_scheduling", constraints, selectedPlan: invalid, candidates: [], errors: [] };
    const acceptance = acceptSelectedPlan(state);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures.map(failure => failure.rule)).toEqual(expect.arrayContaining(["within_distance", "within_destination"]));
  });

  it("final acceptance rejects a plan whose generic dietary flag lacks specific evidence", () => {
    const hardDietary = structuredClone(constraints);
    hardDietary.group.preferences.dietaryRestrictions = ["免海鲜"];
    const selected = plan("injected-dietary-invalid", "北京", 3, 5);
    const state = createAgentState({ rawText: "不能吃海鲜" });
    state.planning = { stage: "fine_scheduling", constraints: hardDietary, selectedPlan: selected, candidates: [], errors: [] };
    const acceptance = acceptSelectedPlan(state);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.failures).toContainEqual(expect.objectContaining({
      rule: "dietary_requirements_satisfied",
      dietaryEvidence: [{ restaurantId: "injected-dietary-invalid-restaurant", requirement: "免海鲜", status: "unknown" }],
    }));
  });

  it("rejects an explicit 2-hour hard limit against a 4.3-hour scheduled plan before Stage 5", async () => {
    const hardTimed = structuredClone(constraints);
    hardTimed.hardMaxDurationMinutes = 120;
    const overtime = candidate(withElapsedMinutes(plan("overtime-high-score", "北京", 3, 5), 258));
    const within = candidate(withElapsedMinutes(plan("within-lower-score", "北京", 3, 3), 110));
    const stage4 = await stage4_feasibilityCheck({ stage: "candidate_generation", constraints: hardTimed, candidates: [overtime, within], errors: [] });
    expect(stage4.candidates?.map(item => item.plan.id)).toEqual(["within-lower-score"]);
    expect(stage4.rejectedCandidates?.[0]?.hardFailures).toContainEqual(expect.objectContaining({
      rule: "within_requested_duration", actualMinutes: 258, limitMinutes: 120,
    }));
    const stage5 = await stage5_selectBest(stage4);
    expect(stage5.decision?.pareto.map(item => item.plan.id)).toEqual(["within-lower-score"]);
    expect(stage5.selectedPlan?.id).toBe("within-lower-score");
    const guardedStage5 = await stage5_selectBest({
      stage: "candidate_generation", constraints: hardTimed, candidates: [overtime, within], errors: [],
    });
    expect(guardedStage5.decision?.pareto.some(item => item.plan.id === "overtime-high-score")).toBe(false);
    const finalState = createAgentState({ rawText: "我只有2小时" });
    finalState.planning = { stage: "fine_scheduling", constraints: hardTimed, selectedPlan: overtime.plan, candidates: [], errors: [] };
    expect(acceptSelectedPlan(finalState).failures.map(check => check.rule)).toContain("within_requested_duration");
  });

  it("accepts exact duration boundary and rejects one minute over", () => {
    const hardTimed = structuredClone(constraints);
    hardTimed.hardMaxDurationMinutes = 120;
    const exact = evaluatePlanHardConstraints(withElapsedMinutes(plan("exact", "北京", 3, 4), 120), hardTimed);
    const over = evaluatePlanHardConstraints(withElapsedMinutes(plan("over", "北京", 3, 4), 121), hardTimed);
    expect(exact.checks.find(check => check.rule === "within_requested_duration")?.passed).toBe(true);
    expect(over.hardFailures.find(check => check.rule === "within_requested_duration")).toMatchObject({ actualMinutes: 121, limitMinutes: 120 });
  });

  it("does not promote runtime defaults, approximate duration, or pace to hard duration", () => {
    for (const text of ["周末和朋友出去玩", "周末和朋友出去玩2小时左右", "周末和朋友出去玩，不要太赶"]) {
      const parsed = parseIntent(text);
      expect(parsed.hardMaxDurationMinutes).toBeUndefined();
      expect(evaluatePlanHardConstraints(withElapsedMinutes(plan("default-or-soft", "北京", 3, 4), 258), parsed).hardFailures)
        .not.toContainEqual(expect.objectContaining({ rule: "within_requested_duration" }));
    }
    expect(parseIntent("周末和朋友出去玩，我只有2小时").hardMaxDurationMinutes).toBe(120);
    expect(parseIntent("周末和朋友出去玩，最多2小时").hardMaxDurationMinutes).toBe(120);
  });

  it("retains an explicit hard duration through follow-up memory and accepts explicit relaxation", () => {
    const first = parseIntent("周末和朋友出去玩，我只有2小时");
    const afterCuisine = mergeTurnConstraints(first, parseIntent("我想吃火锅"), "我想吃火锅");
    expect(afterCuisine.hardMaxDurationMinutes).toBe(120);
    const relaxed = mergeTurnConstraints(afterCuisine, parseIntent("时间可以放宽到4小时"), "时间可以放宽到4小时");
    expect(relaxed.hardMaxDurationMinutes).toBe(240);
  });

  it("measures scheduled bounds once and does not double-count transit", () => {
    const timeline = withElapsedMinutes(plan("timeline", "北京", 3, 4), 120);
    timeline.totalTransitMinutes = 40;
    expect(computePlanElapsedMinutes(timeline)).toBe(120);
  });

  it("ANDs duration with existing distance and destination hard checks", () => {
    const hardTimed = structuredClone(constraints);
    hardTimed.hardMaxDurationMinutes = 120;
    hardTimed.group.preferences.dietaryRestrictions = ["免海鲜"];
    const validPlan = withElapsedMinutes(plan("all-valid", "北京", 3, 4), 120);
    (validPlan.activities[1]!.place as Restaurant).supportedDietaryRestrictions = ["免海鲜"];
    const allValid = evaluatePlanHardConstraints(validPlan, hardTimed);
    expect(allValid.passed).toBe(true);
    const allInvalid = evaluatePlanHardConstraints(withElapsedMinutes(plan("all-invalid", "上海", 6, 4), 121), hardTimed);
    expect(allInvalid.hardFailures.map(check => check.rule)).toEqual(expect.arrayContaining([
      "within_distance", "within_destination", "within_requested_duration",
      "dietary_requirements_satisfied",
    ]));
  });
});
