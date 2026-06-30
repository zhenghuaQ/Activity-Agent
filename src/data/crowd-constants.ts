// ============================================================
// src/data/crowd-constants.ts — 拥挤度预测启发式参数
//
// 由于实时客流数据通常不可得，使用时段×周末×热度×类型
// 的启发式估计。所有阈值和权重集中于此便于校准。
// ============================================================

// ─── 评分归一化参数 ────────────────────────────────

/** 基础热度计算：评分最低参考 */
export const HEAT_RATING_MIN = 3.5;

/** 基础热度计算：评分范围 */
export const HEAT_RATING_RANGE = 1.5;

/** 基础热度在总分中的权重 */
export const HEAT_BASE_WEIGHT = 0.35;

// ─── 特征加成 ─────────────────────────────────────

/** 网红打卡地加成 */
export const CHECKIN_BONUS = 0.15;

/** 用餐高峰时段加成 */
export const MEAL_PEAK_BONUS = 0.3;

/** 周末午后客流高峰加成 */
export const LEISURE_PEAK_BONUS = 0.25;

/** 周末整体加成 */
export const WEEKEND_BONUS = 0.1;

// ─── 拥挤等级阈值 ─────────────────────────────────

/** 拥挤等级阈值（由高到低） */
export const CROWD_LEVEL_THRESHOLDS: { level: "packed" | "high" | "medium"; min: number }[] = [
  { level: "packed", min: 0.8 },
  { level: "high", min: 0.55 },
  { level: "medium", min: 0.3 },
];

// ─── 等待时长估计 ─────────────────────────────────

/** 无实时数据时：餐厅等待 = 拥挤分 × 此值（分钟） */
export const EST_WAIT_RESTAURANT_FACTOR = 30;

/** 无实时数据时：非餐厅等待 = 拥挤分 × 此值（分钟） */
export const EST_WAIT_NON_RESTAURANT_FACTOR = 25;

/** 有排队数据时：每桌 ≈ 等待分钟数 */
export const QUEUE_MINUTES_PER_TABLE = 5;

/** 有排队数据时：用餐高峰时段等待倍数 */
export const QUEUE_PEAK_MULTIPLIER = 1.4;

/** 排队数映射到拥挤分的上限除数 */
export const QUEUE_TO_SCORE_DIVISOR = 40;

/** 排队数映射到拥挤分的上限 */
export const QUEUE_TO_SCORE_CAP = 0.3;

// ─── 置信度 ───────────────────────────────────────

/** 纯启发式（无实时数据）置信度 */
export const CONFIDENCE_HEURISTIC = 0.55;

/** 有真实排队数据时置信度 */
export const CONFIDENCE_WITH_QUEUE = 0.78;

/** 高人气场所评分阈值 */
export const HIGH_RATING_THRESHOLD = 4.6;
