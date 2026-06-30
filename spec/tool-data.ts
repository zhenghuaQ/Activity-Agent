// ============================================================
// spec/tool-data.ts — Tool 执行返回数据类型定义
//
// 用于替代各处 `as any` 的数据访问，提供编译时类型保障。
// ============================================================

import type { Attraction, BreakPlace, FollowUpQuestion, Restaurant } from "./types.js";
import type { TransitEstimate } from "./transit.js";
import type { CrowdPrediction } from "./datasource.js";

/** search_attractions Tool 返回数据 */
export type AttractionSearchResult = Attraction[];

/** search_restaurants Tool 返回数据 */
export type RestaurantSearchResult = Restaurant[];

/** search_break_places Tool 返回数据 */
export type BreakSearchResult = BreakPlace[];

/** check_attraction_availability Tool 返回数据 */
export interface AttractionAvailabilityResult {
  available: boolean;
}

/** check_restaurant_availability Tool 返回数据 */
export interface RestaurantAvailabilityResult {
  estimatedWaitMinutes: number;
}

/** generate_followup_questions Tool 返回数据 */
export type FollowUpResult = FollowUpQuestion[];

/** transit 预估返回数据 */
export type TransitResult = TransitEstimate;

/** 拥挤度预测返回数据 */
export type CrowdResult = CrowdPrediction[];

// ─── 高德 API 响应类型 ──────────────────────────────

export interface AmapDrivingResponse {
  status: string;
  route?: {
    paths: AmapPath[];
  };
}

export interface AmapPath {
  distance: string;
  duration: string;
  steps: AmapStep[];
}

export interface AmapStep {
  tmcs?: AmapTmc[];
}

export interface AmapTmc {
  status?: string;
}
