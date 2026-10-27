import type { DietaryCompatibilityStatus, DietaryRequirement } from "../../spec/dietary.js";
import type { Restaurant } from "../../spec/types.js";

export interface RestaurantDietaryRequirementResult {
  requirement: DietaryRequirement;
  status: DietaryCompatibilityStatus;
}

export interface RestaurantDietaryCompatibility {
  passed: boolean;
  requirements: RestaurantDietaryRequirementResult[];
}

/** Specific compatibility is evidence-based; the generic dietaryOptions flag is intentionally ignored. */
export function evaluateRestaurantDietaryCompatibility(
  restaurant: Restaurant,
  requirements: readonly DietaryRequirement[],
): RestaurantDietaryCompatibility {
  const results = requirements.map((requirement): RestaurantDietaryRequirementResult => {
    if (restaurant.unsupportedDietaryRestrictions?.includes(requirement)) {
      return { requirement, status: "unsupported" };
    }
    if (restaurant.supportedDietaryRestrictions?.includes(requirement)) {
      return { requirement, status: "supported" };
    }
    const explicitTags: Partial<Record<DietaryRequirement, string[]>> = {
      "轻油盐": ["轻油盐", "少油盐", "清淡"],
      "素食": ["素食", "vegetarian", "vegan"],
      "低卡": ["低卡", "低热量", "健康餐"],
      "轻食": ["轻食"],
      "软食": ["软食", "易消化"],
    };
    if (explicitTags[requirement]?.some(tag => restaurant.tags.includes(tag))) {
      return { requirement, status: "supported" };
    }
    return { requirement, status: "unknown" };
  });
  return {
    passed: results.every(result => result.status === "supported"),
    requirements: results,
  };
}
