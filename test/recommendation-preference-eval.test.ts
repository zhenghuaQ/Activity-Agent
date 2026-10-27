import { describe, expect, it } from "vitest";
import type { Activity, Plan, Restaurant, StructuredConstraints } from "../spec/types.js";
import { DEFAULT_WEIGHTS } from "../spec/decision.js";
import { ATTRACTIONS, RESTAURANTS } from "../src/data/mock.js";
import { parseIntent } from "../src/intent/parser.js";
import { scorePlan } from "../src/decision/score.js";
import { evaluateRecommendedPlanPreferences } from "../eval/decision/evaluators/conversation.js";

const constraints = (): StructuredConstraints => {
  const value = parseIntent("周末和朋友出去玩");
  value.group.leadRole = "partner";
  value.group.preferences.dietaryRestrictions = ["免海鲜"];
  value.distance.preferredMaxKm = 3;
  return value;
};

function makePlan(id: string, cuisine: string, distanceKm: number, tags: ("local_tea")[] = []): Plan {
  const attraction = { ...structuredClone(ATTRACTIONS[0]!), id: `${id}-attraction`, distanceKm, localFeatures: tags };
  const restaurant = { ...structuredClone(RESTAURANTS[0]!), id: `${id}-restaurant`, cuisine, distanceKm } as Restaurant;
  const activities: Activity[] = [
    { order: 1, place: attraction, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" },
    { order: 2, place: restaurant, scheduledStart: "16:00", scheduledEnd: "18:00", status: "scheduled" },
  ];
  return { id, scenario: "friends", leadRole: "partner", activities, totalDurationHours: 4, totalTransitMinutes: 10, feasibilityScore: 90, summary: id };
}

function evaluate(input: {
  preferences?: Parameters<typeof evaluateRecommendedPlanPreferences>[0]["expected"];
  finalConstraints?: StructuredConstraints;
  selectedPlan?: Plan;
  outcome?: Parameters<typeof evaluateRecommendedPlanPreferences>[0]["outcome"];
}) {
  return evaluateRecommendedPlanPreferences({
    expected: input.preferences ?? {},
    finalConstraints: input.finalConstraints ?? constraints(),
    selectedPlan: input.selectedPlan,
    outcome: input.outcome ?? "feasible_plan",
  });
}

describe("recommendation-scoped preference evaluator", () => {
  const japanese = makePlan("japanese", "日料", 2, ["local_tea"]);
  const hotpot = makePlan("hotpot", "火锅", 6);

  it("reports a selected cuisine miss even when an alternative Pareto plan covers it", () => {
    const result = evaluate({ preferences: { preferredCuisine: ["日料"] }, selectedPlan: hotpot });
    expect(result).toMatchObject({ applicable: true, satisfied: 0, total: 1, coverage: 0 });
    expect([japanese].some(plan => plan.activities.some(activity => activity.place.type === "restaurant" && (activity.place as Restaurant).cuisine.includes("日料")))).toBe(true);
  });

  it("passes when the selected plan matches even if an alternative does not", () => {
    const result = evaluate({ preferences: { preferredCuisine: ["日料"] }, selectedPlan: japanese });
    expect(result).toMatchObject({ applicable: true, satisfied: 1, total: 1, coverage: 1 });
  });

  it("keeps partial coverage at 2/3 when a different plan covers the missing tag", () => {
    const selected = makePlan("japanese-no-tag", "日料", 2);
    const result = evaluate({
      preferences: { preferredCuisine: ["日料"], preferredMaxKm: 3, desiredTags: ["local_tea"] },
      selectedPlan: selected,
    });
    expect(result).toMatchObject({ applicable: true, satisfied: 2, total: 3, coverage: 2 / 3 });
    expect(result.details).toEqual([
      { preference: "preferredCuisine", satisfied: true },
      { preference: "preferredMaxKm", satisfied: true },
      { preference: "desiredTags", satisfied: false },
    ]);
    expect(japanese.activities.some(activity => activity.place.localFeatures.includes("local_tea"))).toBe(true);
  });

  it("uses existing cuisine and tag matchers and checks preferred distance against the selected plan", () => {
    expect(evaluate({ preferences: { preferredCuisine: ["日"] }, selectedPlan: japanese }).coverage).toBe(1);
    expect(evaluate({ preferences: { preferredMaxKm: 3 }, selectedPlan: hotpot }).coverage).toBe(0);
    expect(evaluate({ preferences: { desiredTags: ["local_tea"] }, selectedPlan: japanese }).coverage).toBe(1);
  });

  it("returns not-applicable for no preferences and no-plan outcomes", () => {
    expect(evaluate({ selectedPlan: japanese })).toMatchObject({ applicable: false, coverage: null, notApplicableReason: "no_preferences" });
    expect(evaluate({ preferences: { preferredCuisine: ["日料"] }, outcome: "no_feasible_plan" }))
      .toMatchObject({ applicable: false, coverage: null, notApplicableReason: "no_feasible_plan" });
    expect(evaluate({ preferences: { preferredCuisine: ["日料"] }, outcome: "runtime_failure" }))
      .toMatchObject({ applicable: false, coverage: null, notApplicableReason: "runtime_failure" });
    expect(evaluate({ preferences: { preferredCuisine: ["日料"] }, outcome: "missed_feasible_plan" }))
      .toMatchObject({ applicable: false, coverage: null, notApplicableReason: "missed_feasible_plan" });
  });

  it("does not fall back to a previous candidate when the accepted selected plan is absent", () => {
    const acceptedSelectedPlan: Plan | undefined = undefined;
    expect(evaluate({ preferences: { preferredCuisine: ["日料"] }, selectedPlan: acceptedSelectedPlan, outcome: "missed_feasible_plan" }))
      .toMatchObject({ applicable: false, coverage: null, notApplicableReason: "missed_feasible_plan" });
  });

  it("does not change production scores or decision success/outcome semantics", () => {
    const constraintsValue = constraints();
    const before = scorePlan({ plan: structuredClone(japanese), constraints: constraintsValue, context: { isWeekend: true, weather: "clear", departureHour: 14 }, weights: DEFAULT_WEIGHTS });
    const evaluation = evaluate({ preferences: { preferredCuisine: ["火锅"] }, selectedPlan: japanese });
    const after = scorePlan({ plan: structuredClone(japanese), constraints: constraintsValue, context: { isWeekend: true, weather: "clear", departureHour: 14 }, weights: DEFAULT_WEIGHTS });
    expect(evaluation.coverage).toBe(0);
    expect(after).toEqual(before);
    expect("taskSuccess" in evaluation).toBe(false);
    expect("outcome" in evaluation).toBe(false);
  });
});
