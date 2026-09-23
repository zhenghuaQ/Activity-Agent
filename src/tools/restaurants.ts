// ============================================================
// src/tools/restaurants.ts — 餐厅搜索 / 查位（决策输入，非下单）
//
// 数据来源统一走 DataSource；distanceKm 动态重算。本工具负责忌口/
// 偏好/人群等业务过滤与排序，等待时长用拥挤度启发式预测。
// ============================================================

import type { Restaurant } from "../../spec/types.js";
import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import type * as T from "../../spec/tools.js";
import {
  SEARCH_RESTAURANTS_TOOL,
  CHECK_RESTAURANT_AVAILABILITY_TOOL,
} from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { ToolError } from "./errors.js";
import { createDefaultDataProvider } from "../data/index.js";
import { predictCrowd } from "../data/crowd.js";
import { rethrowProviderError } from "./provider-errors.js";
import { DEFAULT_SEARCH_RADIUS_KM } from "../planner/search-policy.js";

// ─── Tool 2: search_restaurants (deprecated compatibility wrapper) ────────

export class SearchRestaurantsTool extends BaseTool<
  T.SearchRestaurantsInput,
  T.SearchRestaurantsOutput
> {
  constructor(private readonly provider: ActivityDataProviderV1 = createDefaultDataProvider()) {
    super();
  }

  name = "search_restaurants";
  description = SEARCH_RESTAURANTS_TOOL.description;
  inputSchema = SEARCH_RESTAURANTS_TOOL.inputSchema;

  async run(input: T.SearchRestaurantsInput, context?: ToolExecutionContext): Promise<Restaurant[]> {
    let results: Restaurant[];
    try {
      const result = await this.provider.searchPlaces({
        spatial: { origin: input.origin, maxKm: input.distance.hardMaxKm ?? input.distance.preferredMaxKm ?? DEFAULT_SEARCH_RADIUS_KM },
        intent: { categories: ["restaurant"], preferredTags: input.preferenceTags },
      }, { signal: context?.signal });
      results = result.places.map((candidate) => candidate.detail).filter((place): place is Restaurant => place.type === "restaurant");
    } catch (error) { rethrowProviderError(error); }

    // 忌口匹配
    const restrictions = input.dietaryRestrictions ?? [];
    if (restrictions.length > 0) {
      results = results.filter((r) => r.dietaryOptions);
    }
    if (restrictions.includes("低卡") && restrictions.includes("轻食")) {
      results = results.filter(r => r.tags.includes("低卡") && r.tags.includes("轻食"));
    }

    // 偏好标签匹配
    const tags = input.preferenceTags ?? [];
    if (tags.length > 0) {
      results = results.filter((r) => tags.some((t) => r.tags.includes(t)));
    }

    const preferredCuisine = input.preferredCuisine ?? [];
    const preferenceScore = (restaurant: Restaurant): number => {
      let score = preferredCuisine.some(cuisine => restaurant.cuisine.includes(cuisine)) ? 100 : 0;
      if (input.group.ageGroup.seniors > 0 && (restaurant.tags.includes("老年餐") || restaurant.tags.includes("清淡"))) score += 10;
      if (input.group.ageGroup.youngChildren > 0 && restaurant.tags.includes("儿童友好")) score += 10;
      return score;
    };
    results.sort((a, b) => preferenceScore(b) - preferenceScore(a) || b.rating - a.rating);

    return results;
  }
}

// ─── Tool 5: check_restaurant_availability ─────────────

export class CheckRestaurantAvailabilityTool extends BaseTool<
  T.CheckRestaurantAvailabilityInput,
  T.CheckRestaurantAvailabilityOutput
> {
  constructor(private readonly provider: ActivityDataProviderV1 = createDefaultDataProvider()) {
    super();
  }

  name = "check_restaurant_availability";
  description = CHECK_RESTAURANT_AVAILABILITY_TOOL.description;
  inputSchema = CHECK_RESTAURANT_AVAILABILITY_TOOL.inputSchema;

  async run(
    input: T.CheckRestaurantAvailabilityInput,
    context?: ToolExecutionContext
  ): Promise<T.RestaurantAvailability> {
    const rest = await this.provider.getRestaurantById(input.restaurantId, { signal: context?.signal });
    if (!rest) throw new ToolError("E_RESOURCE_NOT_FOUND", `餐厅 ${input.restaurantId} 不存在`);

    // 拥挤度启发式：综合时段/热度/真实排队数预测等待
    const crowd = predictCrowd(rest, { arrivalTime: input.diningTime, isWeekend: false });
    const hasTable = crowd.estimatedWaitMinutes <= 5;

    return {
      restaurantId: rest.id,
      available: true, // 决策参考：是否仍可纳入方案
      hasTable,
      queueCount: rest.queueCount,
      estimatedWaitMinutes: crowd.estimatedWaitMinutes,
    };
  }
}
