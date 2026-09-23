// ============================================================
// src/tools/attractions.ts — 景点搜索 / 查余量（决策输入，非下单）
//
// 数据来源统一走 DataSource（Mock/高德可插拔），distanceKm 已按
// 用户真实出发点动态重算；本工具只负责「业务过滤 + 排序」。
// ============================================================

import type { Attraction } from "../../spec/types.js";
import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import type * as T from "../../spec/tools.js";
import {
  SEARCH_ATTRACTIONS_TOOL,
  CHECK_ATTRACTION_AVAILABILITY_TOOL,
} from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { ToolError } from "./errors.js";
import { createDefaultDataProvider } from "../data/index.js";
import { predictCrowd } from "../data/crowd.js";
import { rethrowProviderError } from "./provider-errors.js";
import { DEFAULT_SEARCH_RADIUS_KM } from "../planner/search-policy.js";

// ─── Tool 1: search_attractions (deprecated compatibility wrapper) ────────

export class SearchAttractionsTool extends BaseTool<
  T.SearchAttractionsInput,
  T.SearchAttractionsOutput
> {
  constructor(private readonly provider: ActivityDataProviderV1 = createDefaultDataProvider()) {
    super();
  }

  name = "search_attractions";
  description = SEARCH_ATTRACTIONS_TOOL.description;
  inputSchema = SEARCH_ATTRACTIONS_TOOL.inputSchema;

  async run(input: T.SearchAttractionsInput, context?: ToolExecutionContext): Promise<Attraction[]> {
    let results: Attraction[];
    try {
      const result = await this.provider.searchPlaces({
        spatial: { origin: input.origin, maxKm: input.distance.hardMaxKm ?? input.distance.preferredMaxKm ?? DEFAULT_SEARCH_RADIUS_KM },
        intent: { categories: ["attraction"], query: input.keywords?.[0], preferredTags: input.localFeatures },
      }, { signal: context?.signal });
      results = result.places.map((candidate) => candidate.detail).filter((place): place is Attraction => place.type === "attraction");
    } catch (error) { rethrowProviderError(error); }

    // 人群标签匹配（业务过滤）
    if (input.crowdTags.length > 0) {
      results = results.filter((a) =>
        a.crowdTags.some((t) => input.crowdTags.includes(t))
      );
    }

    // 按评分降序
    results.sort((a, b) => b.rating - a.rating);

    return results;
  }
}

// ─── Tool 4: check_attraction_availability ─────────────

export class CheckAttractionAvailabilityTool extends BaseTool<
  T.CheckAttractionAvailabilityInput,
  T.CheckAttractionAvailabilityOutput
> {
  constructor(private readonly provider: ActivityDataProviderV1 = createDefaultDataProvider()) {
    super();
  }

  name = "check_attraction_availability";
  description = CHECK_ATTRACTION_AVAILABILITY_TOOL.description;
  inputSchema = CHECK_ATTRACTION_AVAILABILITY_TOOL.inputSchema;

  async run(input: T.CheckAttractionAvailabilityInput, context?: ToolExecutionContext): Promise<T.AttractionAvailability> {
    const attr = await this.provider.getAttractionById(input.attractionId, { signal: context?.signal });
    if (!attr) {
      throw new ToolError("E_RESOURCE_NOT_FOUND", `景点 ${input.attractionId} 不存在`);
    }

    const slot = attr.availableSlots.find((s) => {
      return s.start <= input.arrivalTime && s.end >= input.arrivalTime;
    });

    // 拥挤度启发式估算排队（替代旧的固定阈值）
    const crowd = predictCrowd(attr, { arrivalTime: input.arrivalTime, isWeekend: false });

    return {
      attractionId: attr.id,
      available: slot ? slot.remaining > 0 : false,
      remainingTickets: slot?.remaining ?? 0,
      estimatedQueueMinutes: crowd.estimatedWaitMinutes,
    };
  }
}
