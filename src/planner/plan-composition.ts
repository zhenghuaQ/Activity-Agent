import type { Place, ResolvedPlanSpecification } from "../../spec/types.js";

/** Planner-internal semantic roles; these are not POI categories. */
export type PlanSlotRole = "activity" | "meal" | "rest";

/** Single Plan Place → semantic slot role mapping shared by identity and completeness. */
export function getPlanSlotRole(place: Place): PlanSlotRole | undefined {
  switch (place.type) {
    case "attraction":
    case "walking": return "activity";
    case "restaurant": return "meal";
    case "break": return "rest";
    default: return undefined;
  }
}

export interface PlanSlotSpec {
  slotId: string;
  role: PlanSlotRole;
  min: number;
  max: number;
}

export interface PlanTemplate {
  id: string;
  slots: PlanSlotSpec[];
}

export interface SlotAssignment {
  slotId: string;
  role: PlanSlotRole;
  places: Place[];
}

export type RoleCandidatePools = ReadonlyMap<PlanSlotRole, readonly Place[]>;

export const ACTIVITY_PLAN_TEMPLATE: PlanTemplate = {
  id: "activity-default",
  slots: [
    { slotId: "primary_activity", role: "activity", min: 1, max: 1 },
    { slotId: "rest", role: "rest", min: 0, max: 1 },
    { slotId: "meal", role: "meal", min: 1, max: 1 },
  ],
};

/** Converts typed, planner-resolved user structure into the sole active domain template. */
export function buildActivityPlanTemplate(specification: ResolvedPlanSpecification): PlanTemplate {
  if (specification.activityCount.value === 1 && specification.mealPolicy.value === "required"
    && specification.activityCount.source === "domain_default" && specification.mealPolicy.source === "domain_default") {
    return ACTIVITY_PLAN_TEMPLATE;
  }
  return {
    id: `activity-${specification.activityCount.value}-meal-${specification.mealPolicy.value}`,
    slots: [
      { slotId: "primary_activity", role: "activity", min: specification.activityCount.value, max: specification.activityCount.value },
      { slotId: "rest", role: "rest", min: 0, max: 1 },
      ...(specification.mealPolicy.value === "none" ? [] : [{
        slotId: "meal", role: "meal" as const,
        min: specification.mealPolicy.value === "required" ? 1 : 0, max: 1,
      }]),
    ],
  };
}

export function resolvePlanSpecification(requested: import("../../spec/types.js").PlanSpecification | undefined): ResolvedPlanSpecification {
  return {
    requested: { ...(requested ?? {}) },
    activityCount: requested?.activityCount === undefined
      ? { value: 1, source: "domain_default" }
      : { value: requested.activityCount, source: "user" },
    mealPolicy: requested?.mealPolicy === undefined
      ? { value: "required", source: "domain_default" }
      : { value: requested.mealPolicy, source: "user" },
  };
}

/** The sole boundary translating search task vocabulary into Plan slot roles. */
export function searchRoleToPlanSlotRole(role: string): PlanSlotRole | undefined {
  switch (role) {
    case "primary_activity": return "activity";
    case "meal": return "meal";
    case "rest": return "rest";
    default: return undefined;
  }
}

/**
 * Enumerates complete template assignments only. It deliberately knows nothing
 * about quality, scores, schedules, or hard constraints.
 */
export function composePlanAssignments(
  template: PlanTemplate,
  pools: RoleCandidatePools,
  options: { enabledSlotIds?: ReadonlySet<string>; requiredSlotIds?: ReadonlySet<string> } = {},
): SlotAssignment[][] {
  let partial: SlotAssignment[][] = [[]];
  for (const slot of template.slots) {
    if (options.enabledSlotIds && !options.enabledSlotIds.has(slot.slotId)) {
      if (slot.min > 0 || options.requiredSlotIds?.has(slot.slotId)) return [];
      continue;
    }
    const pool = [...(pools.get(slot.role) ?? [])].sort(comparePlaceIds);
    const min = options.requiredSlotIds?.has(slot.slotId) ? Math.max(1, slot.min) : slot.min;
    const max = Math.min(slot.max, pool.length);
    if (pool.length < min || slot.min < 0 || slot.max < slot.min) return [];
    const choices = combinations(pool, min, max);
    if (choices.length === 0) return [];
    partial = partial.flatMap(assignments => choices
      .filter(places => {
        if (new Set(places.map(place => place.id)).size !== places.length) return false;
        const existingIds = new Set(assignments.flatMap(item => item.places.map(place => place.id)));
        return places.every(place => !existingIds.has(place.id));
      })
      .map(places => [
        ...assignments,
        { slotId: slot.slotId, role: slot.role, places },
      ]));
  }
  return partial;
}

/** Ordered legacy scheduling input derived from a single generic assignment. */
export function getAssignedPlaces(assignment: SlotAssignment[]): Place[] {
  return assignment.flatMap(slot => slot.places);
}

function combinations(pool: Place[], min: number, max: number): Place[][] {
  const output: Place[][] = [];
  for (let size = min; size <= max; size++) {
    const visit = (start: number, current: Place[]) => {
      if (current.length === size) {
        output.push(current);
        return;
      }
      for (let index = start; index <= pool.length - (size - current.length); index++) {
        visit(index + 1, [...current, pool[index]]);
      }
    };
    visit(0, []);
  }
  return output;
}

function comparePlaceIds(left: Place, right: Place): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
