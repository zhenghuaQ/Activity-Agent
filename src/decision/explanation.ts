import type { CandidateHardConstraintEvaluation } from "../../spec/constraints.js";
import type { PlanCompletenessRequirements } from "../../spec/constraints.js";
import type { DecisionExplanationEvidence, PlanExplanation } from "../../spec/decision.js";
import type { LocalFeatureTag, Plan, Restaurant, StructuredConstraints } from "../../spec/types.js";
import { evaluateRestaurantDietaryCompatibility } from "../constraints/dietary.js";
import { evaluatePlanHardConstraints } from "../constraints/engine.js";
import { evaluatePlanDistancePreference } from "./distance-preference.js";
import { evaluatePlanGroupSuitability } from "./group-suitability.js";

const LOCAL_FEATURES: readonly LocalFeatureTag[] = [
  "local_cuisine", "historical_site", "local_craft", "scenic_spot", "night_market", "local_tea", "popular_checkin",
];
const FEATURE_LABEL: Record<LocalFeatureTag, string> = {
  local_cuisine: "本地风味美食", historical_site: "历史古迹", local_craft: "本地手工艺",
  scenic_spot: "特色景观", night_market: "夜市", local_tea: "本地茶文化", popular_checkin: "热门打卡点",
};

const PRIORITY: Record<DecisionExplanationEvidence["code"], number> = {
  dietary_requirement_verified: 10,
  hard_duration_satisfied: 20,
  hard_distance_satisfied: 30,
  requested_local_feature_matched: 40,
  preferred_cuisine_matched: 50,
  preferred_distance_satisfied: 60,
  group_suitability_matched: 70,
  plan_local_feature_present: 80,
  selected_plan_feasible: 90,
};

function formatEvidence(evidence: DecisionExplanationEvidence): string {
  const data = evidence.data;
  switch (evidence.code) {
    case "requested_local_feature_matched":
      return `方案包含你提到的${(data.features as string[]).map(feature => FEATURE_LABEL[feature as LocalFeatureTag] ?? feature).join("、")}特色。`;
    case "preferred_cuisine_matched":
      return `方案中的餐厅提供${String(data.cuisines)}，符合你提到的菜系偏好。`;
    case "preferred_distance_satisfied":
      return `方案中最远地点约 ${data.actualKm} 公里，在你希望的 ${data.preferredMaxKm} 公里范围内。`;
    case "group_suitability_matched":
      return "方案地点带有与你所述同行人群相匹配的适配标签。";
    case "dietary_requirement_verified":
      return `方案中的餐厅有明确资料支持“${String(data.requirement)}”要求。`;
    case "hard_distance_satisfied":
      return `方案地点均在你设定的 ${data.limitKm} 公里距离上限内。`;
    case "hard_duration_satisfied":
      return `完整行程约 ${data.actualMinutes} 分钟，在你设定的 ${data.limitMinutes} 分钟上限内。`;
    case "plan_local_feature_present":
      return `方案包含${(data.features as string[]).map(feature => FEATURE_LABEL[feature as LocalFeatureTag] ?? feature).join("、")}。`;
    case "selected_plan_feasible":
      return "这份方案通过了本轮约束核验。";
  }
}

/** Evidence is derived from this Plan and these constraints only; it never changes scoring. */
export function buildPlanExplanation(plan: Plan, constraints: StructuredConstraints, completenessRequirements?: PlanCompletenessRequirements): PlanExplanation {
  const evidence: DecisionExplanationEvidence[] = [];
  const places = plan.activities.map(activity => activity.place);
  const requestedFeatures = constraints.extraHints.filter((hint): hint is LocalFeatureTag =>
    (LOCAL_FEATURES as readonly string[]).includes(hint));
  const matchedFeatures = [...new Set(places.flatMap(place => place.localFeatures)
    .filter(feature => requestedFeatures.includes(feature)))].sort();
  if (matchedFeatures.length > 0) evidence.push({
    code: "requested_local_feature_matched", source: "preference", data: { features: matchedFeatures },
  });
  else if (requestedFeatures.length === 0) {
    const planFeatures = [...new Set(places.flatMap(place => place.localFeatures))].sort();
    if (planFeatures.length > 0) evidence.push({ code: "plan_local_feature_present", source: "plan_attribute", data: { features: planFeatures } });
  }

  const restaurants = places.filter((place): place is Restaurant => place.type === "restaurant");
  const matchedCuisines = [...new Set(restaurants.filter(restaurant =>
    constraints.group.preferences.preferredCuisine?.some(cuisine => restaurant.cuisine.includes(cuisine) || cuisine.includes(restaurant.cuisine)))
    .map(restaurant => restaurant.cuisine))].sort();
  if (matchedCuisines.length > 0) evidence.push({ code: "preferred_cuisine_matched", source: "preference", data: { cuisines: matchedCuisines.join("、") } });

  const distance = evaluatePlanDistancePreference(plan, constraints);
  if (distance.status === "satisfied" && distance.distanceKm !== undefined && constraints.distance.preferredMaxKm !== undefined) {
    evidence.push({ code: "preferred_distance_satisfied", source: "preference", data: {
      actualKm: distance.distanceKm, preferredMaxKm: constraints.distance.preferredMaxKm,
    } });
  }

  const group = evaluatePlanGroupSuitability(plan, constraints);
  if (group.applicable && (group.score ?? 0) > 0) evidence.push({ code: "group_suitability_matched", source: "preference", data: {
    score: group.score ?? 0, matchedSignals: group.matched, totalSignals: group.total,
  } });

  const dietaryRequirements = constraints.group.preferences.dietaryRestrictions;
  for (const requirement of dietaryRequirements) {
    const supportedRestaurants = restaurants.filter(restaurant =>
      evaluateRestaurantDietaryCompatibility(restaurant, [requirement]).requirements[0]?.status === "supported");
    if (restaurants.length > 0 && supportedRestaurants.length === restaurants.length) evidence.push({
      code: "dietary_requirement_verified", source: "hard_constraint", data: {
        requirement, restaurantIds: supportedRestaurants.map(restaurant => restaurant.id).sort(),
      },
    });
  }

  const hard = evaluatePlanHardConstraints(plan, constraints, completenessRequirements);
  const durationCheck = hard.checks.find(check => check.rule === "within_requested_duration" && check.passed);
  if (durationCheck?.actualMinutes !== undefined && durationCheck.limitMinutes !== undefined) evidence.push({
    code: "hard_duration_satisfied", source: "hard_constraint", data: {
      actualMinutes: durationCheck.actualMinutes, limitMinutes: durationCheck.limitMinutes,
    },
  });
  const hardDistance = constraints.distance.hardMaxKm;
  const distanceChecks = hard.checks.filter(check => check.rule === "within_distance");
  if (hardDistance !== undefined && places.length > 0 && distanceChecks.length === places.length && distanceChecks.every(check => check.passed)) {
    evidence.push({ code: "hard_distance_satisfied", source: "hard_constraint", data: { limitKm: hardDistance } });
  }
  if (hard.passed) evidence.push({ code: "selected_plan_feasible", source: "hard_constraint", data: { passed: true } });

  const ordered = evidence.sort((left, right) => PRIORITY[left.code] - PRIORITY[right.code]
    || left.code.localeCompare(right.code) || JSON.stringify(left.data).localeCompare(JSON.stringify(right.data)));
  return { highlights: ordered.slice(0, 3).map(formatEvidence), tradeoffs: [], evidence: ordered };
}

/** User-facing business explanation for a genuine no-feasible-plan conclusion. */
export function explainNoFeasiblePlan(
  constraints: StructuredConstraints,
  rejected: CandidateHardConstraintEvaluation[],
): string {
  const failures = rejected.flatMap(candidate => candidate.hardFailures);
  const duration = failures.find(failure => failure.rule === "within_requested_duration");
  if (rejected.length > 0 && duration?.limitMinutes !== undefined
    && rejected.every(candidate => candidate.hardFailures.some(failure => failure.rule === "within_requested_duration"))) {
    return `当前候选方案无法满足你设定的 ${duration.limitMinutes} 分钟总时长限制。`;
  }
  const distance = failures.find(failure => failure.rule === "within_distance");
  if (rejected.length > 0 && distance && constraints.distance.hardMaxKm !== undefined
    && rejected.every(candidate => candidate.hardFailures.some(failure => failure.rule === "within_distance"))) {
    return `当前候选方案超出了你设定的 ${constraints.distance.hardMaxKm} 公里距离上限。`;
  }

  const dietary = failures.flatMap(failure => failure.dietaryEvidence ?? []);
  if (dietary.length > 0) {
    const unknownOnly = dietary.every(item => item.status === "unknown");
    const requirements = [...new Set(dietary.map(item => item.requirement))].sort();
    const names = requirements.join("、");
    return unknownOnly
      ? `当前候选餐厅缺少能够确认满足${names}要求的明确资料，暂时无法确认有符合的完整方案。`
      : `当前候选中没有已核实满足${names}要求的完整方案。`;
  }
  return "当前没有找到满足这次规划条件的完整方案；你可以补充信息或调整条件后再试。";
}

/** Keep infrastructure failure wording separate from a business no-feasible conclusion. */
export function explainPlanningFailure(
  termination: "plan_selected" | "no_feasible_plan" | undefined,
  constraints: StructuredConstraints | undefined,
  rejected: CandidateHardConstraintEvaluation[],
): string {
  if (termination === "no_feasible_plan" && constraints) return explainNoFeasiblePlan(constraints, rejected);
  return "规划未能完成，暂时无法确认方案是否满足条件。";
}
