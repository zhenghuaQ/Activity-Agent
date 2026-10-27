import { describe, expect, it } from "vitest";
import type { Plan, StructuredConstraints } from "../spec/types.js";
import { evaluatePlanHardConstraints } from "../src/constraints/engine.js";
import { evaluatePlanGroupSuitability } from "../src/decision/group-suitability.js";
import { scorePlan } from "../src/decision/score.js";
import { DEFAULT_WEIGHTS } from "../spec/decision.js";
import { mergeTurnConstraints } from "../src/conversation/memory.js";
import { parseIntent } from "../src/intent/parser.js";

function constraints(text = "周末想出去玩"): StructuredConstraints {
  return structuredClone(parseIntent(text));
}

function plan(tags: Plan["activities"][number]["place"]["crowdTags"] = []): Plan {
  const attraction = {
    id: "test-place", name: "测试地点", type: "attraction" as const, address: "测试地址", distanceKm: 1, rating: 4,
    crowdTags: tags, localFeatures: [], location: { lat: 31.2, lng: 121.4, address: "测试地址", city: "上海" },
  };
  const restaurant = {
    ...attraction, id: "test-restaurant", name: "测试餐厅", type: "restaurant" as const,
    tags: ["儿童友好", "亲子", "老年餐", "清淡"], cuisine: "中餐",
  };
  return {
    id: "group-test-plan", scenario: "family", leadRole: "kids", summary: "测试方案",
    totalDurationHours: 2, totalTransitMinutes: 0, feasibilityScore: 100,
    activities: [
      { order: 1, status: "scheduled", scheduledStart: "14:00", scheduledEnd: "16:00", place: attraction },
      { order: 2, status: "scheduled", scheduledStart: "16:00", scheduledEnd: "17:00", place: restaurant },
    ],
  };
}

describe("Plan group suitability", () => {
  it("does not activate for parser defaults or invent family context", () => {
    const result = evaluatePlanGroupSuitability(plan(["family_kids"]), constraints());
    expect(result).toEqual({ applicable: false, matched: 0, total: 0, evidence: [] });
  });

  it("keeps production preference score unchanged when group context is absent", () => {
    const neutral = constraints();
    const withoutTag = plan([]);
    const withIrrelevantTag = plan(["family_kids"]);
    const scoringContext = { isWeekend: true, weather: "clear" as const, departureHour: 14 };
    const score = (candidate: Plan) => scorePlan({ plan: candidate, constraints: neutral, context: scoringContext, weights: DEFAULT_WEIGHTS })
      .dimensions.find(dimension => dimension.dimension === "preference")?.score;
    expect(score(withoutTag)).toBe(score(withIrrelevantTag));
  });

  it("uses explicit structured family, friends, child, and elderly evidence", () => {
    const family = constraints("周末带孩子出去玩");
    family.group.scenario = "family";
    family.group.leadRole = "kids";
    family.group.ageGroup.youngChildren = 1;
    expect(evaluatePlanGroupSuitability(plan(["family_kids", "kids"]), family).score).toBe(1);
    expect(evaluatePlanGroupSuitability(plan(["friends"]), family).score).toBe(0);

    const friends = constraints();
    friends.group.scenario = "friends";
    friends.group.leadRole = "friends_group";
    expect(evaluatePlanGroupSuitability(plan(["friends"]), friends).score).toBe(1);

    const elderly = constraints();
    elderly.group.ageGroup.seniors = 1;
    elderly.group.ageGroup.adults = Math.max(0, elderly.group.totalPeople - 1);
    expect(evaluatePlanGroupSuitability(plan(["family_elderly"]), elderly).score).toBe(1);
  });

  it("scores the final merged group state after an explicit multi-turn correction", () => {
    const first = parseIntent("周末和朋友出去玩");
    const final = mergeTurnConstraints(first, parseIntent("其实会带孩子"), "其实会带孩子");
    expect(final.group.leadRole).toBe("kids");
    expect(evaluatePlanGroupSuitability(plan(["family_kids", "kids"]), final).score).toBe(1);
  });

  it("treats unknown tags as zero soft reward while keeping the plan hard-valid", () => {
    const family = constraints();
    family.group.scenario = "family";
    family.group.leadRole = "kids";
    family.group.ageGroup.youngChildren = 1;
    const candidate = plan();
    const suitability = evaluatePlanGroupSuitability(candidate, family);
    expect(suitability.applicable).toBe(true);
    expect(suitability.score).toBe(0);
    const hard = evaluatePlanHardConstraints(candidate, family);
    expect(hard.passed).toBe(true);
  });

  it("keeps elderly break feasibility separate from elderly suitability evidence", () => {
    const elderly = constraints();
    elderly.group.scenario = "family";
    elderly.group.leadRole = "elderly";
    elderly.group.ageGroup.seniors = 1;
    const withBreak = plan(["family_elderly"]);
    withBreak.leadRole = "elderly";
    withBreak.activities.push({
      order: 3, status: "scheduled", scheduledStart: "17:00", scheduledEnd: "17:30", place: {
        id: "elderly-break", name: "休息点", type: "break", address: "测试地址",
        distanceKm: 1, rating: 4, crowdTags: [], localFeatures: [],
        location: { lat: 31.2, lng: 121.4, address: "测试地址", city: "上海" },
      },
    });
    const unknown = structuredClone(withBreak);
    unknown.activities[0]!.place.crowdTags = [];
    expect(evaluatePlanHardConstraints(withBreak, elderly).passed).toBe(true);
    expect(evaluatePlanHardConstraints(unknown, elderly).passed).toBe(true);
    expect(evaluatePlanGroupSuitability(withBreak, elderly).score).toBeGreaterThan(evaluatePlanGroupSuitability(unknown, elderly).score ?? 0);
  });
});
