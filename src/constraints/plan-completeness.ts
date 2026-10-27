import type { PlanCompletenessRequirement, PlanCompletenessRequirements, ConstraintCheck } from "../../spec/constraints.js";
import type { LeadRole, Plan } from "../../spec/types.js";
import type { StructuredConstraints } from "../../spec/types.js";
import { ACTIVITY_PLAN_TEMPLATE, getPlanSlotRole, type PlanSlotRole, type PlanTemplate } from "../planner/plan-composition.js";

export interface PlanCompletenessRequirementResult {
  requirementId: string;
  role: string;
  requiredMin: number;
  actualCount: number;
  passed: boolean;
  source: "template" | "constraint" | "user";
  requiredMax?: number;
}

export interface PlanCompletenessEvaluation {
  passed: boolean;
  requirements: PlanCompletenessRequirementResult[];
  failures: ConstraintCheck[];
}

/** Derives base shape from the template's minimums, then overlays existing conditional semantics. */
export function buildEffectivePlanCompletenessRequirements(
  template: PlanTemplate,
  constraints: StructuredConstraints,
): PlanCompletenessRequirements {
  const base = buildPlanCompletenessRequirementsForLeadRole(template, constraints.group.leadRole);
  const structural = constraints.planSpecification;
  const additions: PlanCompletenessRequirement[] = [];
  if (structural?.activityCount !== undefined) {
    const existing = base.requirements.find(requirement => requirement.role === "activity");
    if (existing) {
      additions.push({ ...existing, requirementId: "user_activity_count", minCount: structural.activityCount,
        maxCount: structural.activityCount, source: "user", legacyFailureRule: undefined });
    } else additions.push({ requirementId: "user_activity_count", role: "activity", minCount: structural.activityCount,
      maxCount: structural.activityCount, source: "user" });
  }
  if (structural?.mealPolicy === "none") additions.push({ requirementId: "user_meal_none", role: "meal", minCount: 0,
    maxCount: 0, source: "user" });
  return Object.freeze({ templateId: base.templateId,
    requirements: Object.freeze([...base.requirements.filter(requirement =>
      !(structural?.activityCount !== undefined && requirement.role === "activity")
      && !(structural?.mealPolicy === "none" && requirement.role === "meal")),
    ...additions].map(requirement => Object.freeze(requirement))) });
}

/** Used by legacy feasibility score calculation, keeping its current default-template penalty semantics. */
export function buildDefaultActivityPlanCompletenessRequirements(leadRole: LeadRole): PlanCompletenessRequirements {
  return buildPlanCompletenessRequirementsForLeadRole(ACTIVITY_PLAN_TEMPLATE, leadRole);
}

function buildPlanCompletenessRequirementsForLeadRole(template: PlanTemplate, leadRole: LeadRole): PlanCompletenessRequirements {
  const grouped = new Map<PlanSlotRole, Array<{ slotId: string; min: number }>>();
  for (const slot of template.slots) {
    const entries = grouped.get(slot.role) ?? [];
    entries.push({ slotId: slot.slotId, min: slot.min });
    grouped.set(slot.role, entries);
  }

  const requirements: PlanCompletenessRequirement[] = [...grouped].map(([role, slots]) => {
    const requirementId = slots.length === 1 ? slots[0]!.slotId : `role_${role}`;
    const minCount = slots.reduce((sum, slot) => sum + slot.min, 0);
    return {
      requirementId,
      role,
      minCount,
      source: "template",
      ...(getDefaultLegacyFailureRule(template, role, minCount) ? { legacyFailureRule: getDefaultLegacyFailureRule(template, role, minCount) } : {}),
    };
  });

  // Preserve the exact pre-existing activation semantics; this is not a default-template rest requirement.
  if (leadRole === "elderly" || leadRole === "mixed_family") {
    requirements.push({
      requirementId: "elderly_rest_required",
      role: "rest",
      minCount: 1,
      source: "constraint",
      ...(isDefaultActivityTemplate(template) ? { legacyFailureRule: "has_break_for_elderly" as const } : {}),
    });
  }

  return Object.freeze({
    templateId: template.id,
    requirements: Object.freeze(requirements.map(requirement => Object.freeze(requirement))),
  });
}

/** Generation max bounds enumerate assignments; they are deliberately not acceptance constraints. */
function getDefaultLegacyFailureRule(
  template: PlanTemplate,
  role: PlanSlotRole,
  minCount: number,
): PlanCompletenessRequirement["legacyFailureRule"] {
  if (!isDefaultActivityTemplate(template) || minCount !== 1) return undefined;
  if (role === "activity") return "has_attraction";
  if (role === "meal") return "has_restaurant";
  return undefined;
}

function isDefaultActivityTemplate(template: PlanTemplate): boolean {
  return template.id === ACTIVITY_PLAN_TEMPLATE.id
    && template.slots.length === ACTIVITY_PLAN_TEMPLATE.slots.length
    && template.slots.every((slot, index) => {
      const expected = ACTIVITY_PLAN_TEMPLATE.slots[index];
      return slot.slotId === expected?.slotId && slot.role === expected.role
        && slot.min === expected.min && slot.max === expected.max;
    });
}

export function evaluatePlanCompleteness(
  plan: Plan,
  effectiveRequirements: PlanCompletenessRequirements,
): PlanCompletenessEvaluation {
  const counts = new Map<PlanSlotRole, number>();
  for (const activity of plan.activities) {
    const role = getPlanSlotRole(activity.place);
    if (role) counts.set(role, (counts.get(role) ?? 0) + 1);
  }

  const requirements = effectiveRequirements.requirements.map(requirement => {
    const actualCount = counts.get(requirement.role as PlanSlotRole) ?? 0;
    const passed = actualCount >= requirement.minCount
      && (requirement.maxCount === undefined || actualCount <= requirement.maxCount);
    return {
      requirementId: requirement.requirementId,
      role: requirement.role,
      requiredMin: requirement.minCount,
      actualCount,
      passed,
      source: requirement.source,
      ...(requirement.maxCount !== undefined ? { requiredMax: requirement.maxCount } : {}),
    };
  });
  const failures = requirements.flatMap(result => {
    if (result.passed) return [];
    const requirement = effectiveRequirements.requirements.find(item => item.requirementId === result.requirementId)!;
    return [{
      passed: false,
      rule: requirement.legacyFailureRule ?? "plan_slot_requirement",
      detail: formatCompletenessFailure(requirement, result.actualCount),
      planCompleteness: {
        requirementId: requirement.requirementId,
        role: requirement.role,
        requiredMin: requirement.minCount,
        actualCount: result.actualCount,
        source: requirement.source,
        ...(requirement.maxCount !== undefined ? { requiredMax: requirement.maxCount } : {}),
      },
    } satisfies ConstraintCheck];
  });
  return { passed: requirements.every(requirement => requirement.passed), requirements, failures };
}

function formatCompletenessFailure(requirement: PlanCompletenessRequirement, actualCount: number): string {
  switch (requirement.legacyFailureRule) {
    case "has_attraction": return "方案缺少游玩/景点环节";
    case "has_restaurant": return "方案缺少用餐环节";
    case "has_break_for_elderly": return "有老年人但缺少茶歇休息环节";
    default: return requirement.maxCount !== undefined && requirement.maxCount === requirement.minCount
      ? `Plan slot requirement ${requirement.requirementId} (${requirement.role}) requires exactly ${requirement.minCount}; found ${actualCount}`
      : `Plan slot requirement ${requirement.requirementId} (${requirement.role}) requires at least ${requirement.minCount}; found ${actualCount}`;
  }
}
