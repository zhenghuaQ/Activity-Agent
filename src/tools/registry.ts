// ============================================================
// src/tools/registry.ts — Tool 注册中心
// ============================================================

import type { ToolResponse } from "../../spec/tool-response.js";
import type { LLMToolFormat } from "../../spec/tools.js";
import { GetUserLocationTool } from "./location.js";
import { SearchAttractionsTool, CheckAttractionAvailabilityTool } from "./attractions.js";
import { SearchRestaurantsTool, CheckRestaurantAvailabilityTool } from "./restaurants.js";
import { SearchBreakPlacesTool } from "./breaks.js";
import { SearchPlacesTool } from "./places.js";
import { GenerateFollowUpTool } from "./followup.js";
import { EstimateTransitTool } from "./transit.js";
import { ResolveDestinationTool } from "./destination.js";
import type { LocationResolver } from "../../spec/location.js";
import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import { createDefaultDataProvider } from "../data/index.js";
import { ActivityDataGeocodingProvider } from "../location/providers.js";
import { createDefaultLocationResolver } from "../location/service.js";

/** 宽松的 Tool 接口 — 用于注册表统一管理 */
interface AnyTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (input: any) => Promise<ToolResponse<any>>;
  toLLMTool: () => LLMToolFormat;
}

/** Tool注册表 */
export interface ToolRegistryDependencies {
  locationResolver?: LocationResolver;
  dataProvider?: ActivityDataProviderV1;
}

/** @deprecated Use ToolRegistryDependencies. Kept for callers of the previous API. */
export type ToolRegistryOptions = ToolRegistryDependencies;

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  constructor(dependencies: ToolRegistryDependencies = {}) {
    const dataProvider = dependencies.dataProvider ?? createDefaultDataProvider();
    const locationResolver = dependencies.locationResolver ?? createDefaultLocationResolver({
      geocodingProvider: new ActivityDataGeocodingProvider(dataProvider),
    });
    const list: AnyTool[] = [
      new ResolveDestinationTool(dataProvider),
      new GetUserLocationTool(locationResolver),
      new SearchPlacesTool(dataProvider),
      new SearchAttractionsTool(dataProvider),
      new SearchRestaurantsTool(dataProvider),
      new SearchBreakPlacesTool(dataProvider),
      new CheckAttractionAvailabilityTool(dataProvider),
      new CheckRestaurantAvailabilityTool(dataProvider),
      new GenerateFollowUpTool(),
      new EstimateTransitTool(),
    ];
    for (const t of list) {
      this.tools.set(t.name, t);
    }
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  /** 所有工具的 LLM 定义（供 agent loop 组装 chat.completions 的 tools 参数） */
  llmDefinitions(): LLMToolFormat[] {
    return [...this.tools.values()].map((t) => t.toLLMTool());
  }
}

export function createToolRegistry(dependencies: ToolRegistryDependencies = {}): ToolRegistry {
  return new ToolRegistry(dependencies);
}

/** Backward-compatible default registry; custom runs should use createToolRegistry. */
export const toolRegistry = createToolRegistry();
