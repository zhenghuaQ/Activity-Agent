import type { Plan } from "../../spec/types.js";
import { getPlanSlotRole } from "../planner/plan-composition.js";

/**
 * Build a deterministic, non-semantic identity from stable place IDs.
 * Plan IDs are intentionally excluded because Planner currently assigns plan_N
 * in candidate-generation order.
 */
export function getCanonicalPlanIdentity(plan: Plan): string {
  const idsByRole = new Map<string, string[]>([
    ["activity", []],
    ["meal", []],
    ["rest", []],
    ["delivery", []],
  ]);

  for (const activity of plan.activities) {
    const role = getPlanSlotRole(activity.place) ?? (activity.place.type === "delivery" ? "delivery" : "activity");
    idsByRole.get(role)!.push(activity.place.id);
  }

  return JSON.stringify([...idsByRole].map(([role, ids]) => [role, ids.sort()]));
}
