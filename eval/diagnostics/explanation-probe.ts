import type { CandidateHardConstraintEvaluation } from "../../spec/constraints.js";
import type { Plan, Restaurant, StructuredConstraints } from "../../spec/types.js";
import { createBeijingFixture } from "../decision/scenarios/fixtures/beijing.js";
import { buildPlanExplanation, explainNoFeasiblePlan, explainPlanningFailure } from "../../src/decision/explanation.js";
import { parseIntent } from "../../src/intent/parser.js";
import { scorePlan } from "../../src/decision/score.js";
import { DEFAULT_WEIGHTS } from "../../spec/decision.js";

const hasCode = (plan: Plan, constraints: StructuredConstraints, code: string) =>
  buildPlanExplanation(plan, constraints).evidence?.some(item => item.code === code) === true;

export function runExplanationFidelityProbe(): Record<string, unknown> {
  const data = createBeijingFixture("DQ09 explanation probe");
  const attraction = data.attractions[0];
  const restaurant = data.restaurants[0];
  if (!attraction || !restaurant) throw new Error("explanation_probe_requires_fixture");
  const makePlan = (features: Plan["activities"][number]["place"]["localFeatures"], cuisine: string, distanceKm: number, tags: Plan["activities"][number]["place"]["crowdTags"] = []) => {
    const activity = { ...structuredClone(attraction), id: "dq09-selected-attraction", distanceKm, localFeatures: features, crowdTags: tags };
    const meal = { ...structuredClone(restaurant), id: "dq09-selected-meal", cuisine, distanceKm, localFeatures: [], crowdTags: tags,
      supportedDietaryRestrictions: [], unsupportedDietaryRestrictions: [] };
    return {
      id: "dq09-selected", scenario: "family" as const, leadRole: "kids" as const, summary: "controlled explanation probe",
      totalDurationHours: 3.25, totalTransitMinutes: 0, feasibilityScore: 100,
      activities: [
        { order: 1, place: activity, scheduledStart: "10:00", scheduledEnd: "12:00", status: "scheduled" as const, transitTo: null },
        { order: 2, place: meal, scheduledStart: "12:15", scheduledEnd: "13:15", status: "scheduled" as const, transitTo: null },
      ],
    } satisfies Plan;
  };

  const localRequested = parseIntent("周末去北京，想体验本地茶文化");
  localRequested.extraHints.push("local_tea");
  const localMismatch = makePlan(["local_craft"], "火锅", 6);
  const localMatch = makePlan(["local_tea"], "日料", 2, ["family_kids", "kids"]);
  const noRequest = parseIntent("周末去北京玩");

  const cuisine = parseIntent("周末出去，想吃日料");
  cuisine.group.preferences.preferredCuisine = ["日料"];
  const cuisineMiss = makePlan([], "火锅", 6);
  const cuisineHit = makePlan([], "日料", 2);

  const preferredDistance = parseIntent("周末出去");
  preferredDistance.distance.preferredMaxKm = 3;
  const hardDistanceOnly = parseIntent("周末出去");
  hardDistanceOnly.distance.hardMaxKm = 10;

  const dietary = parseIntent("周末出去，不能吃海鲜");
  dietary.group.preferences.dietaryRestrictions = ["免海鲜"];
  const supported = makePlan([], "日料", 2);
  (supported.activities[1]!.place as Restaurant).supportedDietaryRestrictions = ["免海鲜"];
  const unknown = makePlan([], "日料", 2);
  const genericOnly = makePlan([], "日料", 2);
  (genericOnly.activities[1]!.place as Restaurant).dietaryOptions = true;

  const child = parseIntent("周末带孩子出去玩");
  child.group.scenario = "family";
  child.group.leadRole = "kids";
  child.group.ageGroup.youngChildren = 1;
  const groupMismatch = makePlan([], "日料", 2, ["friends"]);
  const groupMatch = makePlan([], "日料", 2, ["family_kids", "kids"]);

  const hardDuration = parseIntent("周末出去，最多4小时");
  hardDuration.hardMaxDurationMinutes = 240;
  const durationPlan = makePlan([], "日料", 2);
  const priorPlan = structuredClone(localMatch);
  const scoreContext = { isWeekend: true, weather: "clear" as const, departureHour: 10 };
  const numericBefore = scorePlan({ plan: structuredClone(localMatch), constraints: localRequested, context: scoreContext, weights: DEFAULT_WEIGHTS });
  const localMatchExplain1 = buildPlanExplanation(localMatch, localRequested);
  const localMatchExplain2 = buildPlanExplanation(localMatch, localRequested);
  const numericAfter = scorePlan({ plan: structuredClone(localMatch), constraints: localRequested, context: scoreContext, weights: DEFAULT_WEIGHTS });
  const unknownNoFeasible = explainNoFeasiblePlan(dietary, [{
    candidateId: "unknown", planId: "unknown", passed: false,
    checks: [], hardFailures: [{ passed: false, rule: "dietary_requirements_satisfied", detail: "unknown", dietaryEvidence: [
      { restaurantId: "dq09-selected-meal", requirement: "免海鲜", status: "unknown" },
    ] }],
  } satisfies CandidateHardConstraintEvaluation]);
  const unsupportedNoFeasible = explainNoFeasiblePlan(dietary, [{
    candidateId: "unsupported", planId: "unsupported", passed: false,
    checks: [], hardFailures: [{ passed: false, rule: "dietary_requirements_satisfied", detail: "unsupported", dietaryEvidence: [
      { restaurantId: "dq09-selected-meal", requirement: "免海鲜", status: "unsupported" },
    ] }],
  } satisfies CandidateHardConstraintEvaluation]);
  const durationNoFeasible = explainNoFeasiblePlan(hardDuration, [{
    candidateId: "too-long", planId: "too-long", passed: false,
    checks: [], hardFailures: [{ passed: false, rule: "within_requested_duration", detail: "too long", actualMinutes: 260, limitMinutes: 240 }],
  } satisfies CandidateHardConstraintEvaluation]);

  return {
    localMismatchRejected: !hasCode(localMismatch, localRequested, "requested_local_feature_matched")
      && !buildPlanExplanation(localMismatch, localRequested).highlights.some(text => text.includes("茶文化")),
    localMatchAccepted: hasCode(localMatch, localRequested, "requested_local_feature_matched"),
    noRequestNotPreferenceClaim: !hasCode(localMatch, noRequest, "requested_local_feature_matched"),
    cuisineMissRejected: !hasCode(cuisineMiss, cuisine, "preferred_cuisine_matched"),
    cuisineHitAccepted: hasCode(cuisineHit, cuisine, "preferred_cuisine_matched"),
    distanceHitAccepted: hasCode(makePlan([], "日料", 2), preferredDistance, "preferred_distance_satisfied"),
    distanceMissRejected: !hasCode(makePlan([], "日料", 6), preferredDistance, "preferred_distance_satisfied"),
    hardDistanceNotSoft: !hasCode(makePlan([], "日料", 6), hardDistanceOnly, "preferred_distance_satisfied"),
    dietarySupportedVerified: hasCode(supported, dietary, "dietary_requirement_verified"),
    dietaryUnknownNotVerified: !hasCode(unknown, dietary, "dietary_requirement_verified"),
    genericDietaryNotVerified: !hasCode(genericOnly, dietary, "dietary_requirement_verified"),
    groupMismatchRejected: !hasCode(groupMismatch, child, "group_suitability_matched"),
    groupMatchAccepted: hasCode(groupMatch, child, "group_suitability_matched"),
    hardDurationSurfaced: hasCode(durationPlan, hardDuration, "hard_duration_satisfied"),
    dietaryUnknownUsesUncertainty: unknownNoFeasible.includes("无法确认") && !unknownNoFeasible.includes("不支持"),
    dietaryUnsupportedNotClaimedAsUnknown: unsupportedNoFeasible.includes("没有已核实") && !unsupportedNoFeasible.includes("无法确认"),
    hardDurationNoFeasibleSpecific: durationNoFeasible.includes("240 分钟总时长限制"),
    infrastructureFailureDistinct: explainPlanningFailure(undefined, dietary, []) !== unknownNoFeasible
      && explainPlanningFailure(undefined, dietary, []).includes("规划未能完成"),
    stableEvidenceOrder: JSON.stringify(localMatchExplain1) === JSON.stringify(localMatchExplain2),
    alternativeIndependent: JSON.stringify(localMatchExplain1) === JSON.stringify(buildPlanExplanation(localMatch, localRequested)),
    noMutation: JSON.stringify(priorPlan) === JSON.stringify(localMatch),
    numericScoreUnchanged: JSON.stringify(numericBefore) === JSON.stringify(numericAfter),
    maxHighlights: localMatchExplain1.highlights.length <= 3,
  };
}
