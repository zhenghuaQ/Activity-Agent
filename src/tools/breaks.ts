// ============================================================
// src/tools/breaks.ts — Tool 3: search_break_places
//
// 数据来源统一走 DataSource；distanceKm 动态重算。子类型过滤下推到
// 数据层，本工具负责无障碍/儿童友好等业务过滤与排序。
// ============================================================

import type { BreakPlace } from "../../spec/types.js";
import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import type * as T from "../../spec/tools.js";
import { SEARCH_BREAK_PLACES_TOOL } from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { createDefaultDataProvider } from "../data/index.js";
import { rethrowProviderError } from "./provider-errors.js";
import { DEFAULT_SEARCH_RADIUS_KM } from "../planner/search-policy.js";

export class SearchBreakPlacesTool extends BaseTool<
  T.SearchBreakPlacesInput,
  T.SearchBreakPlacesOutput
> {
  constructor(private readonly provider: ActivityDataProviderV1 = createDefaultDataProvider()) {
    super();
  }

  /** @deprecated Use search_places. */
  name = "search_break_places";
  description = SEARCH_BREAK_PLACES_TOOL.description;
  inputSchema = SEARCH_BREAK_PLACES_TOOL.inputSchema;

  async run(input: T.SearchBreakPlacesInput, context?: ToolExecutionContext): Promise<BreakPlace[]> {
    let results: BreakPlace[];
    try {
      const result = await this.provider.searchPlaces({
        spatial: { origin: input.origin, maxKm: input.distance.hardMaxKm ?? input.distance.preferredMaxKm ?? DEFAULT_SEARCH_RADIUS_KM },
        intent: { categories: ["break", input.breakSubtype] },
      }, { signal: context?.signal });
      results = result.places.map((candidate) => candidate.detail).filter((place): place is BreakPlace => place.type === "break");
    } catch (error) { rethrowProviderError(error); }

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
