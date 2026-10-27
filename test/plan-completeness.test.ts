import { describe, expect, it } from "vitest";
import { createAgentState } from "../spec/agent.js";
import type { Plan, PlanCandidate, StructuredConstraints } from "../spec/types.js";
import type { PlanTemplate } from "../src/planner/plan-composition.js";
import { ACTIVITY_PLAN_TEMPLATE } from "../src/planner/plan-composition.js";
import { buildEffectivePlanCompletenessRequirements, evaluatePlanCompleteness } from "../src/constraints/plan-completeness.js";
import { evaluatePlanHardConstraints } from "../src/constraints/engine.js";
import { acceptSelectedPlan } from "../src/runtime/evaluator.js";
import { applyReplanPatch } from "../src/runtime/replanner.js";
import { stage4_feasibilityCheck, stage5_selectBest } from "../src/planner/stages.js";
import { createBeijingFixture } from "../eval/decision/scenarios/fixtures/beijing.js";

const fixture = createBeijingFixture();
const constraints = (leadRole: StructuredConstraints["group"]["leadRole"] = "partner"): StructuredConstraints => {
  const result = {
    destination: { city: "北京" },
    timeWindow: { start: "10:00", end: "20:00", durationHours: 10 },
    group: { scenario: "friends", leadRole, totalPeople: 2, maleCount: 1, femaleCount: 1, ageGroup: { adults: 2, youngChildren: 0, teens: 0, seniors: 0 }, preferences: { preferredCuisine: [], dietaryRestrictions: [], inferredDietary: { lowCalorie: false, lightDiet: false, kidsFriendly: false, softFood: false, restrictions: [] }, budget: "medium", dieting: false } },
    distance: { preferredMaxKm: 10 },
    extraHints: [],
  } as StructuredConstraints;
  return result;
};

const plan = (places: Array<{ place: Plan["activities"][number]["place"] }>, leadRole: Plan["leadRole"] = "partner"): Plan => ({
  id: "completeness-plan", scenario: "friends", leadRole,
  activities: places.map(({ place }, index) => ({ order: index + 1, place, scheduledStart: `${10 + index}:00`, scheduledEnd: `${11 + index}:00`, status: "scheduled" })),
  totalDurationHours: places.length, totalTransitMinutes: 0, feasibilityScore: 90, summary: "test plan",
});
const candidate = (value: Plan): PlanCandidate => ({ plan: value, feasibilityScore: value.feasibilityScore, reason: "test" });
const activity = fixture.attractions[0]!;
const meal = fixture.restaurants[0]!;
const walking = { ...fixture.attractions[1]!, type: "walking" } as unknown as Plan["activities"][number]["place"];

describe("template-derived plan completeness", () => {
  it("preserves default-template legacy failure codes and elderly condition", () => {
    const defaultRequirements = buildEffectivePlanCompletenessRequirements(ACTIVITY_PLAN_TEMPLATE, constraints());
    expect(defaultRequirements.requirements.map(requirement => [requirement.requirementId, requirement.role, requirement.minCount])).toEqual([
      ["primary_activity", "activity", 1], ["rest", "rest", 0], ["meal", "meal", 1],
    ]);
    expect(Object.isFrozen(defaultRequirements) && Object.isFrozen(defaultRequirements.requirements)).toBe(true);
    const missing = plan([{ place: meal }]);
    const evaluation = evaluatePlanCompleteness(missing, defaultRequirements);
    expect(evaluation.failures.map(check => check.rule)).toEqual(["has_attraction"]);
    expect(evaluation.failures[0]?.detail).toBe("方案缺少游玩/景点环节");
    expect(evaluatePlanCompleteness(plan([{ place: activity }]), defaultRequirements).failures.map(check => check.rule)).toEqual(["has_restaurant"]);

    const elderlyMissing = plan([{ place: activity }, { place: meal }], "elderly");
    const elderly = evaluatePlanCompleteness(elderlyMissing, buildEffectivePlanCompletenessRequirements(ACTIVITY_PLAN_TEMPLATE, constraints("elderly")));
    expect(elderly.failures.map(check => check.rule)).toEqual(["has_break_for_elderly"]);
    const elderlyWithRest = plan([{ place: activity }, { place: fixture.breakPlaces[0]! }, { place: meal }], "elderly");
    expect(evaluatePlanCompleteness(elderlyWithRest, buildEffectivePlanCompletenessRequirements(ACTIVITY_PLAN_TEMPLATE, constraints("elderly"))).passed).toBe(true);
    expect(evaluatePlanCompleteness(plan([{ place: activity }, { place: meal }]), defaultRequirements).failures).toEqual([]);
  });

  it("derives repeated-role minimums and emits structured generic evidence", () => {
    const custom: PlanTemplate = { id: "two-activities", slots: [
      { slotId: "activity_a", role: "activity", min: 1, max: 1 },
      { slotId: "activity_b", role: "activity", min: 1, max: 1 },
    ] };
    const requirements = buildEffectivePlanCompletenessRequirements(custom, constraints());
    expect(evaluatePlanCompleteness(plan([{ place: meal }]), requirements).failures[0]?.planCompleteness?.actualCount).toBe(0);
    const failed = evaluatePlanCompleteness(plan([{ place: activity }]), requirements).failures;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      rule: "plan_slot_requirement",
      planCompleteness: { requirementId: "role_activity", role: "activity", requiredMin: 2, actualCount: 1, source: "template" },
    });
    expect(evaluatePlanCompleteness(plan([{ place: activity }, { place: walking }]), requirements).passed).toBe(true);
    // Slot max limits generation only; it is not a hard acceptance maximum.
    expect(evaluatePlanCompleteness(plan([{ place: activity }, { place: walking }, { place: fixture.attractions[1]! }]), requirements).passed).toBe(true);
  });

  it("uses one run-local requirement object through Stage 4, Stage 5, final acceptance, and replan", async () => {
    const custom: PlanTemplate = { id: "two-activities", slots: [
      { slotId: "activity_a", role: "activity", min: 1, max: 1 },
      { slotId: "activity_b", role: "activity", min: 1, max: 1 },
      { slotId: "meal", role: "meal", min: 1, max: 1 },
    ] };
    const requirements = buildEffectivePlanCompletenessRequirements(custom, constraints());
    const incompletePlan = plan([{ place: activity }, { place: meal }]);
    const stage4 = await stage4_feasibilityCheck({ stage: "candidate_generation", constraints: constraints(), planCompletenessRequirements: requirements, candidates: [candidate(incompletePlan)], errors: [] });
    expect(stage4.candidates).toEqual([]);
    expect(stage4.rejectedCandidates?.[0]?.hardFailures[0]).toMatchObject({ rule: "plan_slot_requirement", planCompleteness: { requiredMin: 2, actualCount: 1 } });
    const stage5 = await stage5_selectBest(stage4);
    expect(stage5.selectedPlan).toBeUndefined();
    expect(stage5.planCompletenessRequirements).toBe(requirements);

    const finalState = createAgentState({ rawText: "test" });
    finalState.planning.constraints = constraints();
    finalState.planning.selectedPlan = incompletePlan;
    finalState.planning.planCompletenessRequirements = requirements;
    expect(acceptSelectedPlan(finalState).failures[0]).toMatchObject({ rule: "plan_slot_requirement" });
    const replanned = applyReplanPatch(finalState, { searchRadiusKm: 20 });
    expect(replanned.planning.planCompletenessRequirements).toBe(requirements);

    const completePlan = plan([{ place: activity }, { place: walking }, { place: meal }]);
    const stage4Pass = await stage4_feasibilityCheck({ stage: "candidate_generation", constraints: constraints(), planCompletenessRequirements: requirements, candidates: [candidate(completePlan)], errors: [] });
    expect(stage4Pass.candidates).toHaveLength(1);
    expect(stage4Pass.planCompletenessRequirements).toBe(requirements);
    const stage5Pass = await stage5_selectBest(stage4Pass);
    expect(stage5Pass.selectedPlan).toBeDefined();
    expect(stage5Pass.planCompletenessRequirements).toBe(requirements);
    const acceptedState = createAgentState({ rawText: "test" });
    acceptedState.planning.constraints = constraints();
    acceptedState.planning.selectedPlan = stage5Pass.selectedPlan;
    acceptedState.planning.planCompletenessRequirements = requirements;
    expect(acceptSelectedPlan(acceptedState).passed).toBe(true);
  });

  it("keeps custom template checks isolated from another concurrent evaluation", async () => {
    const custom: PlanTemplate = { id: "activity-only", slots: [{ slotId: "activity", role: "activity", min: 1, max: 1 }] };
    const customRequirements = buildEffectivePlanCompletenessRequirements(custom, constraints());
    const value = plan([{ place: activity }]);
    const [customResult, defaultResult] = await Promise.all([
      Promise.resolve(evaluatePlanHardConstraints(value, constraints(), customRequirements)),
      Promise.resolve(evaluatePlanHardConstraints(value, constraints())),
    ]);
    expect(customResult.passed).toBe(true);
    expect(defaultResult.hardFailures.map(check => check.rule)).toContain("has_restaurant");
  });
});
