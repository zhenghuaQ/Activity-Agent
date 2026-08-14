// ============================================================
// src/tools/attractions.ts — 景点搜索 / 查余量（决策输入，非下单）
//
// 数据来源统一走 DataSource（Mock/高德可插拔），distanceKm 已按
// 用户真实出发点动态重算；本工具只负责「业务过滤 + 排序」。
// ============================================================

import type { Attraction } from "../../spec/types.js";
import type * as T from "../../spec/tools.js";
import {
  SEARCH_ATTRACTIONS_TOOL,
  CHECK_ATTRACTION_AVAILABILITY_TOOL,
} from "../../spec/tools.js";
import { BaseTool } from "./base.js";
import { ToolError } from "./errors.js";
import { getDataSource } from "../data/index.js";
import { predictCrowd } from "../data/crowd.js";

// ─── Tool 1: search_attractions ────────────────────────

export class SearchAttractionsTool extends BaseTool<
  T.SearchAttractionsInput,
  T.SearchAttractionsOutput
> {
  name = "search_attractions";
  description = SEARCH_ATTRACTIONS_TOOL.description;
  inputSchema = SEARCH_ATTRACTIONS_TOOL.inputSchema;

  async run(input: T.SearchAttractionsInput): Promise<Attraction[]> {
    const ds = getDataSource();
    let results = await ds.searchAttractions({
      origin: input.distance.homeLocation,
      radiusKm: input.distance.maxKm,
      keywords: input.keywords,
      localFeatures: input.localFeatures,
    });

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
  name = "check_attraction_availability";
  description = CHECK_ATTRACTION_AVAILABILITY_TOOL.description;
  inputSchema = CHECK_ATTRACTION_AVAILABILITY_TOOL.inputSchema;

  async run(input: T.CheckAttractionAvailabilityInput): Promise<T.AttractionAvailability> {
    const attr = await getDataSource().getAttractionById(input.attractionId);
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
