import { ACTIVITY_PLAN_TEMPLATE, composePlanAssignments, type PlanTemplate } from "../../src/planner/plan-composition.js";
import type { Place } from "../../spec/types.js";
import type { Plan } from "../../spec/types.js";
import { createBeijingFixture } from "../decision/scenarios/fixtures/beijing.js";
import { parseIntent } from "../../src/intent/parser.js";
import { buildEffectivePlanCompletenessRequirements, evaluatePlanCompleteness } from "../../src/constraints/plan-completeness.js";

const ids = (assignments: ReturnType<typeof composePlanAssignments>) => assignments.map(assignment =>
  assignment.map(slot => [slot.slotId, slot.places.map(place => place.id)]));

/** Targeted architecture probe; it verifies assignment semantics, not decision quality. */
export function runPlanCompositionProbe(): Record<string, unknown> {
  const activityA = { id: "probe-activity-a" } as Place;
  const activityB = { id: "probe-activity-b" } as Place;
  const mealA = { id: "probe-meal-a" } as Place;
  const mealB = { id: "probe-meal-b" } as Place;
  const pools = new Map([["activity", [activityA, activityB]], ["meal", [mealA, mealB]]] as const);
  const options = {
    enabledSlotIds: new Set(["primary_activity", "meal"]),
    requiredSlotIds: new Set(["primary_activity", "meal"]),
  };
  const assignments = composePlanAssignments(ACTIVITY_PLAN_TEMPLATE, pools, options);
  const reversed = composePlanAssignments(ACTIVITY_PLAN_TEMPLATE,
    new Map([["activity", [activityB, activityA]], ["meal", [mealB, mealA]]] as const), options);
  const legacyIds = [activityA.id, activityB.id].flatMap(activityId =>
    [mealA.id, mealB.id].map(mealId => [activityId, mealId]));
  const projectedIds = assignments.map(assignment => [
    assignment.find(slot => slot.role === "activity")!.places[0]!.id,
    assignment.find(slot => slot.role === "meal")!.places[0]!.id,
  ]);
  const customTemplate: PlanTemplate = { id: "probe-custom", slots: [
    { slotId: "activity_1", role: "activity", min: 1, max: 1 },
    { slotId: "activity_2", role: "activity", min: 1, max: 1 },
    { slotId: "meal", role: "meal", min: 1, max: 1 },
  ] };
  const custom = composePlanAssignments(customTemplate, pools);
  const fixture = createBeijingFixture();
  const actualPlan: Plan = {
    id: "probe-completeness", scenario: "friends", leadRole: "partner",
    activities: [fixture.attractions[0]!, fixture.restaurants[0]!].map((place, index) => ({
      order: index + 1, place, scheduledStart: `${10 + index}:00`, scheduledEnd: `${11 + index}:00`, status: "scheduled" as const,
    })),
    totalDurationHours: 2, totalTransitMinutes: 0, feasibilityScore: 90, summary: "completeness probe",
  };
  const customRequirements = buildEffectivePlanCompletenessRequirements(customTemplate, parseIntent("周末和朋友出去玩"));
  const customCompleteness = evaluatePlanCompleteness(actualPlan, customRequirements);
  return {
    compositionBackend: "template-role-pools-generic-assignment",
    defaultTemplateSlots: ACTIVITY_PLAN_TEMPLATE.slots,
    defaultCandidateAssignmentCount: assignments.length,
    equivalentToLegacyAttractionMealPairSet: new Set(projectedIds.map(value => JSON.stringify(value))).size === new Set(legacyIds.map(value => JSON.stringify(value))).size
      && projectedIds.every(value => legacyIds.some(old => JSON.stringify(old) === JSON.stringify(value))),
    permutationStable: JSON.stringify(ids(assignments)) === JSON.stringify(ids(reversed)),
    customTwoActivityTemplateAssignmentCount: custom.length,
    customTemplateCanAssignTwoSameRoleSlots: custom.length === 4 && custom.every(assignment =>
      assignment.filter(slot => slot.role === "activity").length === 2),
    productionPlanSupportsMultipleSameRoleActivities: false,
    multiActivitySequenceGap: "MULTI_ACTIVITY_SEQUENCE_GAP",
    phaseCImplementedShape: "single activity with required/none meal policy; optional meal remains evaluator-applicability gap",
    dq07PhaseAComplete: true,
    dq07PhaseBComplete: true,
    dq07RemainsOpen: true,
    defaultCompletenessSource: "ACTIVITY_PLAN_TEMPLATE minimum cardinality + unchanged elderly/mixed_family rest condition",
    customCompletenessEvidence: customCompleteness.failures.map(failure => failure.planCompleteness),
    customCompletenessUsesGenericRule: customCompleteness.failures.every(failure => failure.rule === "plan_slot_requirement"),
    openCapabilities: ["multi-activity route sequencing (MULTI_ACTIVITY_SEQUENCE_GAP)", "meal optional preference applicability (MEAL_PREFERENCE_APPLICABILITY_GAP)", "pace expressiveness"],
  };
}
