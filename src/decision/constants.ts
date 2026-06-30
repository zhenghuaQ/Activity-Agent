// ============================================================
// src/decision/constants.ts — 多维评分引擎配置常量
//
// 所有魔法数字集中管理，带命名和校准依据。
// ============================================================

// ─── 时间维度（窗口利用率）───────────────────────────

/** 时间利用率的理想比例（85% 窗口占用即满分附近） */
export const TIME_IDEAL_RATIO = 0.85;

/** 超出窗口时每 1% 的惩罚分 */
export const TIME_OVERFLOW_PENALTY_PER_PCT = 1.5;

/** 低于理想比例时的基础分 */
export const TIME_UNDER_BASE_SCORE = 40;

/** 低于理想比例时每 1% 的加分（乘数） */
export const TIME_UNDER_SCORE_MULTIPLIER = 60;

// ─── 通勤维度 ───────────────────────────────────────

/** 通勤基准时长（分钟），≤ 此值满分 */
export const TRANSIT_BASELINE_MINUTES = 90;

// ─── 偏好维度（增量分）─────────────────────────────

export const PREF_BASE_SCORE = 60;
export const PREF_CUISINE_HIT_BONUS = 15;
export const PREF_DIET_HIT_BONUS = 12;
export const PREF_RESTRICTION_BONUS = 8;
export const PREF_LOCAL_FEATURE_BONUS = 10;

// ─── 拥挤度维度 ─────────────────────────────────────

/** 各拥挤等级的扣分 */
export const CROWD_PENALTY: Record<string, number> = {
  low: 0,
  medium: 15,
  high: 35,
  packed: 55,
};

/** 未知拥挤等级默认扣分 */
export const CROWD_UNKNOWN_PENALTY = 20;

/** 无数据时默认拥挤分 */
export const CROWD_NO_DATA_SCORE = 70;

// ─── 预算维度 ───────────────────────────────────────

/** 预算档位对应人均参考上限（元） */
export const BUDGET_TARGET: Record<"low" | "medium" | "high", number> = {
  low: 120,
  medium: 280,
  high: 600,
};

/** 预算低于目标时每 1% 的扣分（留弹性空间） */
export const BUDGET_UNDER_PENALTY_PER_PCT = 0.18;

/** 预算超出目标时每 1% 的扣分 */
export const BUDGET_OVER_PENALTY_PER_PCT = 1.2;

// ─── 口碑维度 ───────────────────────────────────────

/** 口碑归一化：最低参考评分 */
export const POPULARITY_MIN_RATING = 3;

/** 口碑归一化：评分范围（5-3=2） */
export const POPULARITY_RATING_RANGE = 2;

// ─── 置信度权重 ─────────────────────────────────────

export const CONFIDENCE_BASE = 0.5;
export const CONFIDENCE_CROWD_WEIGHT = 0.25;
export const CONFIDENCE_AMAP_BONUS = 0.15;
export const CONFIDENCE_MOCK_BONUS = 0.05;
export const CONFIDENCE_COMPLETE_BONUS = 0.1;

// ─── 通用 ──────────────────────────────────────────

export const SCORE_MIN = 0;
export const SCORE_MAX = 100;
