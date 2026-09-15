// ============================================================
// src/tools/transit.ts — Tool 11: estimate_transit
// ============================================================

import type * as T from "../../spec/tools.js";
import { ESTIMATE_TRANSIT_TOOL } from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { estimateTransitWithAmap } from "../transit/amap.js";

export class EstimateTransitTool extends BaseTool<
  T.EstimateTransitInput,
  T.EstimateTransitOutput
> {
  name = "estimate_transit";
  description = ESTIMATE_TRANSIT_TOOL.description;
  inputSchema = ESTIMATE_TRANSIT_TOOL.inputSchema;

  async run(input: T.EstimateTransitInput, context?: ToolExecutionContext): Promise<T.EstimateTransitOutput> {
    // 有高德 Key 走真实路径规划，否则自动降级 Mock 通勤
    return estimateTransitWithAmap(input.from, input.to, input.departureTime, context?.signal);
  }
}
