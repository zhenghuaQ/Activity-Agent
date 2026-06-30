// ============================================================
// src/data/crowd.ts — 拥挤度 / 排队启发式预测
//
// 实时客流数据通常拿不到，这里用「时段 × 周末 × 热度 × 场所类型」
// 启发式估计拥挤度，并显式输出 confidence 与 factors（可解释）。
// 用于替代旧版「可用性硬过滤」——不再粗暴丢弃，而是量化软信号。
// ============================================================

import type { Place, Restaurant } from "../../spec/types.js";
import type { CrowdLevel, CrowdPrediction } from "../../spec/datasource.js";
import {
  HEAT_RATING_MIN,
  HEAT_RATING_RANGE,
  HEAT_BASE_WEIGHT,
  CHECKIN_BONUS,
  MEAL_PEAK_BONUS,
  LEISURE_PEAK_BONUS,
  WEEKEND_BONUS,
  CROWD_LEVEL_THRESHOLDS,
  EST_WAIT_RESTAURANT_FACTOR,
  EST_WAIT_NON_RESTAURANT_FACTOR,
  QUEUE_MINUTES_PER_TABLE,
  QUEUE_PEAK_MULTIPLIER,
  QUEUE_TO_SCORE_DIVISOR,
  QUEUE_TO_SCORE_CAP,
  CONFIDENCE_HEURISTIC,
  CONFIDENCE_WITH_QUEUE,
  HIGH_RATING_THRESHOLD,
} from "./crowd-constants.js";

export interface CrowdContext {
  /** 到达时间 "HH:mm" */
  arrivalTime: string;
  /** 是否周末 / 节假日 */
  isWeekend: boolean;
}

function hourOf(time: string): number {
  const h = parseInt(time.split(":")[0] ?? "12", 10);
  return Number.isFinite(h) ? h : 12;
}

/** 用餐高峰：午 11:30-13:00 / 晚 17:30-19:30（按小时近似） */
function isMealPeak(hour: number): boolean {
  return (hour >= 11 && hour <= 13) || (hour >= 17 && hour <= 19);
}

/** 景点/休闲高峰：周末午后 13-17 点 */
function isLeisurePeak(hour: number, isWeekend: boolean): boolean {
  return isWeekend && hour >= 13 && hour <= 17;
}

function levelFromScore(score: number): CrowdLevel {
  for (const t of CROWD_LEVEL_THRESHOLDS) {
    if (score >= t.min) return t.level;
  }
  return "low";
}

/**
 * 预测某地点在给定到达时间的拥挤度。
 *
 * 评分思路（0-1）：基础热度（评分/网红） + 时段峰值 + 周末加成，
 * 餐厅若带真实 queueCount 则提升置信度并以其校准等待时长。
 */
export function predictCrowd(place: Place, ctx: CrowdContext): CrowdPrediction {
  const hour = hourOf(ctx.arrivalTime);
  const factors: string[] = [];

  // 基础热度：评分越高、网红打卡地越挤
  let score = Math.max(0, Math.min(1, (place.rating - HEAT_RATING_MIN) / HEAT_RATING_RANGE)) * HEAT_BASE_WEIGHT;
  if (place.rating >= HIGH_RATING_THRESHOLD) factors.push("高人气场所");
  if (place.localFeatures.includes("popular_checkin")) {
    score += CHECKIN_BONUS;
    factors.push("网红打卡地");
  }

  // 时段峰值
  if (place.type === "restaurant" && isMealPeak(hour)) {
    score += MEAL_PEAK_BONUS;
    factors.push("用餐高峰时段");
  }
  if (
    (place.type === "attraction" || place.type === "break") &&
    isLeisurePeak(hour, ctx.isWeekend)
  ) {
    score += LEISURE_PEAK_BONUS;
    factors.push("周末午后客流高峰");
  }

  // 周末整体加成
  if (ctx.isWeekend) {
    score += WEEKEND_BONUS;
    factors.push("周末");
  }

  // 置信度：纯启发式偏低，有真实排队数则提升
  let confidence = CONFIDENCE_HEURISTIC;
  let estimatedWaitMinutes: number;

  if (place.type === "restaurant") {
    const r = place as Restaurant;
    if (r.hasQueue && typeof r.queueCount === "number") {
      const peakMultiplier = isMealPeak(hour) ? QUEUE_PEAK_MULTIPLIER : 1;
      estimatedWaitMinutes = Math.round(r.queueCount * QUEUE_MINUTES_PER_TABLE * peakMultiplier);
      confidence = CONFIDENCE_WITH_QUEUE;
      factors.push(`实时排队约 ${r.queueCount} 桌`);
      score = Math.min(1, score + Math.min(QUEUE_TO_SCORE_CAP, r.queueCount / QUEUE_TO_SCORE_DIVISOR));
    } else {
      estimatedWaitMinutes = Math.round(score * EST_WAIT_RESTAURANT_FACTOR);
    }
  } else {
    estimatedWaitMinutes = Math.round(score * EST_WAIT_NON_RESTAURANT_FACTOR);
  }

  score = Math.max(0, Math.min(1, score));
  if (factors.length === 0) factors.push("常规时段，客流平稳");

  return {
    placeId: place.id,
    level: levelFromScore(score),
    estimatedWaitMinutes,
    confidence,
    factors,
  };
}
