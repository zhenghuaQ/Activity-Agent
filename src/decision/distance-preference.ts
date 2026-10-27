import type { Plan, StructuredConstraints } from "../../spec/types.js";

export type DistancePreferenceStatus = "inactive" | "unknown" | "satisfied" | "outside_preference";

export interface DistancePreferenceEvaluation {
  status: DistancePreferenceStatus;
  distanceKm?: number;
  normalizedScore?: number;
}

/** Maximum Place.distanceKm across every scheduled place in the plan. */
export function getPlanPreferenceDistanceKm(plan: Plan): number | undefined {
  if (plan.activities.length === 0) return undefined;
  const distances = plan.activities.map(activity => activity.place.distanceKm);
  if (distances.some(distance => !Number.isFinite(distance) || distance < 0)) return undefined;
  return Math.max(...distances);
}

/**
 * Evaluate the plan's soft distance preference. Place.distanceKm is already
 * measured from the active search reference (destination center when present,
 * otherwise resolved environment location); this helper never recomputes it.
 */
export function evaluatePlanDistancePreference(
  plan: Plan,
  constraints: Pick<StructuredConstraints, "distance">,
): DistancePreferenceEvaluation {
  const preferredMaxKm = constraints.distance.preferredMaxKm;
  if (preferredMaxKm === undefined) return { status: "inactive" };

  const distanceKm = getPlanPreferenceDistanceKm(plan);
  if (distanceKm === undefined) return { status: "unknown" };

  const satisfied = distanceKm <= preferredMaxKm;
  return {
    status: satisfied ? "satisfied" : "outside_preference",
    distanceKm,
    normalizedScore: satisfied ? 1 : preferredMaxKm / distanceKm,
  };
}
