// ============================================================
// src/tools/breaks.ts — Tool 3: search_break_places
//
// 数据来源统一走 DataSource；distanceKm 动态重算。子类型过滤下推到
// 数据层，本工具负责无障碍/儿童友好等业务过滤与排序。
// ============================================================

import type { BreakPlace } from "../../spec/types.js";
import type * as T from "../../spec/tools.js";
import { SEARCH_BREAK_PLACES_TOOL } from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { getDataSource } from "../data/index.js";

export class SearchBreakPlacesTool extends BaseTool<
  T.SearchBreakPlacesInput,
  T.SearchBreakPlacesOutput
> {
  name = "search_break_places";
  description = SEARCH_BREAK_PLACES_TOOL.description;
  inputSchema = SEARCH_BREAK_PLACES_TOOL.inputSchema;

  async run(input: T.SearchBreakPlacesInput, context?: ToolExecutionContext): Promise<BreakPlace[]> {
    const ds = getDataSource();
    let results = await ds.searchBreakPlaces({
      origin: input.distance.homeLocation,
      radiusKm: input.distance.maxKm,
      breakSubtype: input.breakSubtype,
    }, context?.signal);

    // 老年人 → 需要无障碍
    if (input.hasElderly) {
      results = results.filter((b) => b.accessible);
    }

    // 幼年 → 需要儿童友好
    if (input.hasYoungChildren) {
      results = results.filter((b) => b.kidsFriendly);
    }

    // 老年人/幼年优先距离，其他场景优先评分
    if (input.hasElderly) {
      results.sort((a, b) => a.distanceKm - b.distanceKm);
    } else {
      results.sort((a, b) => {
        const scoreA = a.rating + (a.localFeatures.length > 0 ? 0.2 : 0);
        const scoreB = b.rating + (b.localFeatures.length > 0 ? 0.2 : 0);
        return scoreB - scoreA;
      });
    }
    return results;
  }
}
