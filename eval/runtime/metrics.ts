// ============================================================
// eval/runtime/metrics.ts — Runtime Regression 方案质量指标
// ============================================================

import type { Plan } from "../../spec/types.js";
import type { CongestionLevel } from "../../spec/transit.js";

/** 单方案的 metrics */
export interface PlanMetrics {
  planId: string;
  summary: string;

  // 时间维度
  totalDurationHours: number;
  transitMinutes: number;
  activityMinutes: number;

  // 通勤质量
  maxCongestion: CongestionLevel;
  totalTransitPenalty: number;

  // 完整性
  hasAttraction: boolean;
  hasRestaurant: boolean;
  hasBreak: boolean;

  // 综合
  feasibilityScore: number;

  // 活动明细
  activities: { name: string; type: string; start: string; end: string; }[];

  // 各环节 Trace
  toolTraces: { toolName: string; latencyMs: number }[];
}

/** 计算方案 metrics */
export function calcPlanMetrics(plan: Plan): PlanMetrics {
  const types = plan.activities.map((a) => a.place.type);
  const transitMinutes = plan.totalTransitMinutes;
  const activityMinutes = Math.round(plan.totalDurationHours * 60) - transitMinutes;

  let maxCongestion: CongestionLevel = "smooth";
  for (const act of plan.activities) {
    if (act.transitTo?.best.congestionLevel) {
      const level = act.transitTo.best.congestionLevel;
      const order: CongestionLevel[] = ["smooth", "slow", "congested", "blocked"];
      if (order.indexOf(level) > order.indexOf(maxCongestion)) {
        maxCongestion = level;
      }
    }
  }

  return {
    planId: plan.id,
    summary: plan.summary,
    totalDurationHours: plan.totalDurationHours,
    transitMinutes,
    activityMinutes,
    maxCongestion,
    totalTransitPenalty: plan.activities.reduce(
      (sum, a) => sum + (a.transitTo ? transitScorePenaltySimple(a.transitTo.totalMinutes) : 0),
      0
    ),
    hasAttraction: types.includes("attraction") || types.includes("walking"),
    hasRestaurant: types.includes("restaurant"),
    hasBreak: types.includes("break"),
    feasibilityScore: plan.feasibilityScore,
    activities: plan.activities.map(a => ({
      name: a.place.name,
      type: a.place.type,
      start: a.scheduledStart,
      end: a.scheduledEnd,
    })),
    toolTraces: [],
  };
}

function transitScorePenaltySimple(totalMinutes: number): number {
  if (totalMinutes <= 15) return 0;
  if (totalMinutes <= 30) return 5;
  if (totalMinutes <= 45) return 10;
  return 20;
}

/** 评估结果 */
export interface EvalResult {
  caseName: string;
  passed: boolean;
  planMetrics: PlanMetrics | null;
  errors: string[];
  durationMs: number;
}
