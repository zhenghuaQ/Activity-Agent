import type { DistanceConstraint, StructuredConstraints } from "../../spec/types.js";

export const DEFAULT_SEARCH_RADIUS_KM = 25;
export const DEFAULT_MAX_SEARCH_RADIUS_KM = 30;

export interface SearchPolicy {
  radiusKm: number;
  maxRadiusKm: number;
}

export function createInitialSearchPolicy(
  constraints: StructuredConstraints,
  options: { defaultRadiusKm?: number; maxRadiusKm?: number } = {},
): SearchPolicy {
  const defaultRadius = options.defaultRadiusKm ?? DEFAULT_SEARCH_RADIUS_KM;
  const maxRadius = options.maxRadiusKm ?? DEFAULT_MAX_SEARCH_RADIUS_KM;
  const distance = constraints.distance;
  const preferred = distance.preferredMaxKm;
  const initial = distance.hardMaxKm !== undefined
    ? Math.min(defaultRadius, distance.hardMaxKm)
    : preferred !== undefined ? Math.min(defaultRadius, preferred) : defaultRadius;
  return {
    radiusKm: Math.max(0.1, initial),
    maxRadiusKm: distance.hardMaxKm !== undefined ? Math.min(maxRadius, distance.hardMaxKm) : maxRadius,
  };
}

export function distancePreferenceMiss(distanceKm: number, constraint: DistanceConstraint): boolean {
  return constraint.preferredMaxKm !== undefined && distanceKm > constraint.preferredMaxKm;
}
