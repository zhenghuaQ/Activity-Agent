import { describe, expect, it } from "vitest";
import type { Activity, Plan, PlanCandidate } from "../spec/types.js";
import { DEFAULT_WEIGHTS } from "../spec/decision.js";
import { evaluatePlanHardConstraints } from "../src/constraints/engine.js";
import { ATTRACTIONS, HOME, RESTAURANTS } from "../src/data/mock.js";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { haversineKm } from "../src/core/geo.js";
import { mergeTurnConstraints } from "../src/conversation/memory.js";
import { parseIntent } from "../src/intent/parser.js";
import { evaluatePlanDistancePreference, getPlanPreferenceDistanceKm } from "../src/decision/distance-preference.js";
import { scorePlan } from "../src/decision/score.js";
import { runDecision } from "../src/decision/index.js";
import { createInitialSearchPolicy } from "../src/planner/search-policy.js";

const context = { isWeekend: true, weather: "clear" as const, departureHour: 14 };

function makePlan(id: string, maxDistanceKm: number, restaurantPrice: number): Plan {
  const attraction = { ...structuredClone(ATTRACTIONS[0]!), id: `${id}-attraction`, distanceKm: maxDistanceKm, pricePerPerson: 80 };
  const restaurant = { ...structuredClone(RESTAURANTS[0]!), id: `${id}-restaurant`, distanceKm: maxDistanceKm, pricePerPerson: restaurantPrice,
    supportedDietaryRestrictions: ["免海鲜" as const], unsupportedDietaryRestrictions: [] };
  const activities: Activity[] = [
    { order: 1, place: attraction, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" },
    { order: 2, place: restaurant, scheduledStart: "16:00", scheduledEnd: "18:00", status: "scheduled" },
  ];
  return {
    id, scenario: "friends", leadRole: "friends_group", activities,
    totalDurationHours: 4, totalTransitMinutes: 10, feasibilityScore: 90, summary: id,
  };
}

function candidate(plan: Plan): PlanCandidate { return { plan, feasibilityScore: 90, reason: plan.summary }; }
function preferenceScore(plan: Plan, constraints: ReturnType<typeof parseIntent>): number {
  return scorePlan({ plan: structuredClone(plan), constraints, context, weights: DEFAULT_WEIGHTS })
    .dimensions.find(dimension => dimension.dimension === "preference")!.score;
}

describe("preferred distance is a continuous soft decision preference", () => {
  it("uses the farthest scheduled place and follows the normalized boundary curve", () => {
    const plan = makePlan("distance", 2, 130);
    plan.activities[1]!.place.distanceKm = 4;
    expect(getPlanPreferenceDistanceKm(plan)).toBe(4);

    const constraints = parseIntent("周末和朋友出去玩");
    constraints.distance.preferredMaxKm = 3;
    for (const [distance, expected] of [[2, 1], [3, 1], [6, 0.5], [30, 0.1]] as const) {
      const value = structuredClone(plan);
      value.activities.forEach(activity => { activity.place.distanceKm = distance; });
      expect(evaluatePlanDistancePreference(value, constraints)).toMatchObject({
        status: distance <= 3 ? "satisfied" : "outside_preference",
        distanceKm: distance,
        normalizedScore: expected,
      });
    }
  });

  it("leaves preference scoring unchanged without a preferred distance", () => {
    const plan = makePlan("no-preference", 2, 130);
    const constraints = parseIntent("周末和朋友出去玩");
    // The explicitly stated friends context now contributes its separate soft
    // suitability signal; the distance behavior itself remains inactive here.
    expect(preferenceScore(plan, constraints)).toBe(60);
    constraints.distance.hardMaxKm = 10;
    expect(preferenceScore(plan, constraints)).toBe(60);
    expect(evaluatePlanDistancePreference(plan, constraints).status).toBe("inactive");
  });

  it("prefers near places with the same complete candidate IDs, then allows far plans to win when the preference widens", async () => {
    const base = parseIntent("周末和朋友出去玩");
    base.destination = { city: "北京" };
    base.distance = { preferredMaxKm: 3, hardMaxKm: 10 };
    base.hardMaxDurationMinutes = 240;
    base.group.preferences.dietaryRestrictions = ["免海鲜"];
    const near = makePlan("near-plan", 2, 130);
    const far = makePlan("far-plan", 8, 100);
    const ids = [near, far].flatMap(plan => plan.activities.map(activity => activity.place.id)).sort();
    expect(evaluatePlanHardConstraints(near, base).passed).toBe(true);
    expect(evaluatePlanHardConstraints(far, base).passed).toBe(true);
    expect(evaluatePlanDistancePreference(near, base).normalizedScore).toBe(1);
    expect(evaluatePlanDistancePreference(far, base).normalizedScore).toBe(3 / 8);

    const narrowResult = await runDecision([candidate(structuredClone(near)), candidate(structuredClone(far))], structuredClone(base), { date: new Date("2026-09-26T12:00:00.000Z"), weather: "clear" });
    const wide = structuredClone(base);
    wide.distance.preferredMaxKm = 10;
    const wideResult = await runDecision([candidate(structuredClone(near)), candidate(structuredClone(far))], wide, { date: new Date("2026-09-26T12:00:00.000Z"), weather: "clear" });

    expect(ids).toEqual([near, far].flatMap(plan => plan.activities.map(activity => activity.place.id)).sort());
    expect(narrowResult?.recommended.plan.id).toBe("near-plan");
    expect(wideResult?.recommended.plan.id).toBe("far-plan");
    expect(preferenceScore(near, base)).toBeGreaterThan(preferenceScore(far, base));
    expect(preferenceScore(near, wide)).toBe(preferenceScore(far, wide));
  });

  it("does not treat missing distances as a perfect match or hard-reject the plan", () => {
    const plan = makePlan("unknown-distance", 2, 130);
    plan.activities[1]!.place.distanceKm = Number.NaN;
    const constraints = parseIntent("周末和朋友出去玩");
    constraints.distance.preferredMaxKm = 3;
    const evaluation = evaluatePlanDistancePreference(plan, constraints);
    expect(evaluation).toEqual({ status: "unknown" });
    expect(evaluatePlanHardConstraints(plan, constraints).passed).toBe(true);
    expect(preferenceScore(plan, constraints)).toBe(60);
  });

  it("keeps preferred and hard distance independent, including duration and dietary hard gates", () => {
    const constraints = parseIntent("周末和朋友出去玩");
    constraints.distance = { preferredMaxKm: 3, hardMaxKm: 10 };
    constraints.hardMaxDurationMinutes = 240;
    constraints.group.preferences.dietaryRestrictions = ["免海鲜"];
    const far = makePlan("far-soft-only", 8, 130);
    expect(evaluatePlanHardConstraints(far, constraints).passed).toBe(true);

    const tooFarHard = structuredClone(constraints);
    tooFarHard.distance = { preferredMaxKm: 10, hardMaxKm: 5 };
    expect(evaluatePlanHardConstraints(far, tooFarHard).hardFailures.map(failure => failure.rule)).toContain("within_distance");

    const tooLong = structuredClone(far);
    tooLong.activities[1]!.scheduledEnd = "18:01";
    expect(evaluatePlanHardConstraints(tooLong, constraints).hardFailures.map(failure => failure.rule)).toContain("within_requested_duration");

    const incompatible = structuredClone(far);
    const restaurant = incompatible.activities.find(activity => activity.place.type === "restaurant")!.place as typeof RESTAURANTS[number];
    restaurant.supportedDietaryRestrictions = [];
    expect(evaluatePlanHardConstraints(incompatible, constraints).hardFailures.map(failure => failure.rule)).toContain("dietary_requirements_satisfied");
  });

  it("keeps provider distances centered on destination when present, otherwise on environment location", async () => {
    const place = structuredClone(ATTRACTIONS[0]!);
    const destinationCenter = { lat: 39.9, lng: 116.4, address: "北京中心", city: "北京" };
    const provider = new MockProvider({ attractions: [place], restaurants: [], breakPlaces: [], destinationCenters: { 北京: destinationCenter } });
    const search = async (origin: typeof HOME) => provider.searchPlaces({
      spatial: { origin, maxKm: 50 }, intent: { categories: ["attraction"] },
    });
    const envResult = await search(HOME);
    const destinationResult = await search(destinationCenter);
    const envDistance = envResult.places[0]!.distanceKm;
    const destinationDistance = destinationResult.places[0]!.distanceKm;
    expect(envDistance).toBeCloseTo(haversineKm(HOME, place.location), 1);
    expect(destinationDistance).toBeCloseTo(haversineKm(destinationCenter, place.location), 1);
    expect(envDistance).not.toBe(destinationDistance);
  });

  it("keeps search radius separate and replaces a remembered preferred distance", () => {
    const threeKm = parseIntent("周末和朋友出去玩，最好3公里左右");
    const tenKm = mergeTurnConstraints(threeKm, parseIntent("距离可以放宽一点，10公里左右也行"), "距离可以放宽一点，10公里左右也行");
    expect(threeKm.distance.preferredMaxKm).toBe(3);
    expect(tenKm.distance.preferredMaxKm).toBe(10);
    expect(createInitialSearchPolicy(threeKm)).toMatchObject({ radiusKm: 3, maxRadiusKm: 30 });
    expect(createInitialSearchPolicy(tenKm)).toMatchObject({ radiusKm: 10, maxRadiusKm: 30 });
    expect(evaluatePlanDistancePreference(makePlan("remembered-far", 8, 130), tenKm).normalizedScore).toBe(1);
  });
});
