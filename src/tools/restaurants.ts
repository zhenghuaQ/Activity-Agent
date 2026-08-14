// ============================================================
// src/tools/restaurants.ts — 餐厅搜索 / 查位（决策输入，非下单）
//
// 数据来源统一走 DataSource；distanceKm 动态重算。本工具负责忌口/
// 偏好/人群等业务过滤与排序，等待时长用拥挤度启发式预测。
// ============================================================

import type { Restaurant } from "../../spec/types.js";
import type * as T from "../../spec/tools.js";
import {
  SEARCH_RESTAURANTS_TOOL,
  CHECK_RESTAURANT_AVAILABILITY_TOOL,
} from "../../spec/tools.js";
import { BaseTool } from "./base.js";
import { ToolError } from "./errors.js";
import { getDataSource } from "../data/index.js";
import { predictCrowd } from "../data/crowd.js";

// ─── Tool 2: search_restaurants ────────────────────────

export class SearchRestaurantsTool extends BaseTool<
  T.SearchRestaurantsInput,
  T.SearchRestaurantsOutput
> {
  name = "search_restaurants";
  description = SEARCH_RESTAURANTS_TOOL.description;
  inputSchema = SEARCH_RESTAURANTS_TOOL.inputSchema;

  async run(input: T.SearchRestaurantsInput): Promise<Restaurant[]> {
    const ds = getDataSource();
    let results = await ds.searchRestaurants({
      origin: input.distance.homeLocation,
      radiusKm: input.distance.maxKm,
      localFeatures: input.localFeatures,
    });

    // 忌口匹配
    const restrictions = input.dietaryRestrictions ?? [];
    if (restrictions.length > 0) {
      results = results.filter((r) => r.dietaryOptions);
    }

    // 偏好标签匹配
    const tags = input.preferenceTags ?? [];
    if (tags.length > 0) {
      results = results.filter((r) => tags.some((t) => r.tags.includes(t)));
    }

    // 人群匹配 — 有老人的优先老年友好
    if (input.group.ageGroup.seniors > 0) {
      results.sort((a, b) => {
        const aOk = a.tags.includes("老年餐") || a.tags.includes("清淡") ? 1 : 0;
        const bOk = b.tags.includes("老年餐") || b.tags.includes("清淡") ? 1 : 0;
        return bOk - aOk;
      });
    }

    // 有幼年的优先儿童友好
    if (input.group.ageGroup.youngChildren > 0) {
      results.sort((a, b) => {
        const aOk = a.tags.includes("儿童友好") ? 1 : 0;
        const bOk = b.tags.includes("儿童友好") ? 1 : 0;
        return bOk - aOk || b.rating - a.rating;
      });
    }

    // 否则按评分降序
    if (input.group.ageGroup.youngChildren === 0 && input.group.ageGroup.seniors === 0) {
      results.sort((a, b) => b.rating - a.rating);
    }

    return results;
  }
}

// ─── Tool 5: check_restaurant_availability ─────────────

export class CheckRestaurantAvailabilityTool extends BaseTool<
  T.CheckRestaurantAvailabilityInput,
  T.CheckRestaurantAvailabilityOutput
> {
  name = "check_restaurant_availability";
  description = CHECK_RESTAURANT_AVAILABILITY_TOOL.description;
  inputSchema = CHECK_RESTAURANT_AVAILABILITY_TOOL.inputSchema;

  async run(
    input: T.CheckRestaurantAvailabilityInput
  ): Promise<T.RestaurantAvailability> {
    const rest = await getDataSource().getRestaurantById(input.restaurantId);
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
