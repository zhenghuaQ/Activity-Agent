// ============================================================
// spec/decision.ts — 决策引擎契约（SDD，M2）
//
// 把竞赛版「扣分式可行性单分」升级为可解释的多维加权评分：
//   - 6 个维度归一到 0-100，按权重加权求总分；
//   - 每个方案带 confidence（置信度）与 explanation（为何选/取舍）；
//   - 帕累托多方案：同一候选池产出 均衡/省时/省钱/体验 多个目标解。
// 决策逻辑与数据层（M1）解耦，权重可被画像（M3）/情境（context）覆盖。
// ============================================================

import type {
  Plan,
  PlanCandidate,
  StructuredConstraints,
} from "./types.js";

// ─── 评分维度 ──────────────────────────────────────────

export type ScoreDimension =
  | "time" // 时间契合：窗口利用充分且不超时
  | "transit" // 通勤效率：总通勤越短越好
  | "preference" // 偏好契合：菜系/忌口/当地特色
  | "crowd" // 人群适配：标签匹配 + 拥挤度可接受
  | "budget" // 预算契合：人均花费贴合预算档
  | "popularity"; // 热度：评分/口碑

export const ALL_DIMENSIONS: ScoreDimension[] = [
  "time",
  "transit",
  "preference",
  "crowd",
  "budget",
  "popularity",
];

export const DimensionLabel: Record<ScoreDimension, string> = {
  time: "时间契合",
  transit: "通勤效率",
  preference: "偏好契合",
  crowd: "人群适配",
  budget: "预算契合",
  popularity: "口碑热度",
};

/** 各维度权重（建议和为 1，引擎内部会归一化，不强制） */
export type ScoringWeights = Record<ScoreDimension, number>;

/** 默认权重先验（M3 画像 / context 情境会在此基础上调整） */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  time: 0.18,
  transit: 0.18,
  preference: 0.22,
  crowd: 0.14,
  budget: 0.13,
  popularity: 0.15,
};

// ─── 单维度评分 ────────────────────────────────────────

export interface DimensionScore {
  dimension: ScoreDimension;
  /** 归一化 0-100 */
  score: number;
  /** 当前生效权重（归一化后） */
  weight: number;
  /** score * weight，便于直接展示贡献 */
  weighted: number;
  /** 该维度的一句话解释（可解释性） */
  reason: string;
}

// ─── 方案得分 ──────────────────────────────────────────

/** 决策目标：帕累托多方案的语义标签 */
export type PlanObjective =
  | "balanced" // 均衡最优
  | "time_saver" // 省时优先（通勤+时间）
  | "budget_saver" // 省钱优先
  | "experience"; // 体验优先（偏好+口碑）

export const ObjectiveLabel: Record<PlanObjective, string> = {
  balanced: "均衡推荐",
  time_saver: "省时之选",
  budget_saver: "经济之选",
  experience: "体验之选",
};

/** 多维评分汇总 */
export interface PlanScore {
  /** 0-100 加权总分 */
  total: number;
  dimensions: DimensionScore[];
  /** 0-1 综合置信度（数据完整度 + 拥挤度置信度等） */
  confidence: number;
}

// ─── 可解释 ────────────────────────────────────────────

export interface PlanExplanation {
  /** 亮点：高分维度的理由 */
  highlights: string[];
  /** 取舍：低分维度的提示 */
  tradeoffs: string[];
  /** 为何不选其它候选（多方案对比时填充） */
  whyNotOthers?: string[];
  /** Structured facts supporting user-facing explanation; absent on legacy payloads. */
  evidence?: DecisionExplanationEvidence[];
}

export type DecisionExplanationEvidenceCode =
  | "requested_local_feature_matched"
  | "preferred_cuisine_matched"
  | "preferred_distance_satisfied"
  | "group_suitability_matched"
  | "dietary_requirement_verified"
  | "hard_distance_satisfied"
  | "hard_duration_satisfied"
  | "plan_local_feature_present"
  | "selected_plan_feasible";

export type DecisionExplanationEvidenceSource = "preference" | "hard_constraint" | "plan_attribute";

export interface DecisionExplanationEvidence {
  code: DecisionExplanationEvidenceCode;
  source: DecisionExplanationEvidenceSource;
  data: Record<string, string | number | boolean | string[]>;
}

// ─── 情境（context）──────────────────────────────────────

export type WeatherCondition = "clear" | "rain" | "snow" | "hot" | "cold" | "unknown";

/** 决策情境：影响权重与硬偏好（如雨天偏室内） */
export interface DecisionContext {
  /** 是否周末/节假日 */
  isWeekend: boolean;
  /** 天气（高德天气 API，无 Key → unknown） */
  weather: WeatherCondition;
  /** 出发小时（用于时段调权） */
  departureHour: number;
}

// ─── 评分输入 / 输出 ───────────────────────────────────

export interface ScoringInput {
  plan: Plan;
  constraints: StructuredConstraints;
  context: DecisionContext;
  weights: ScoringWeights;
}

/** 帕累托方案集（最终决策产出） */
export interface DecisionResult {
  /** 首推（balanced），即 selectedPlan */
  recommended: PlanCandidate;
  /** 帕累托多目标方案（含 recommended，去重后 2-4 个） */
  pareto: PlanCandidate[];
  /** 整体决策置信度 0-1 */
  confidence: number;
  /** 决策过程中的降级/兜底说明 */
  notes: string[];
}

// ─── 对既有契约的扩展（可选字段，向后兼容） ──────────────
// 见 spec/types.ts：Plan.score / Plan.explanation / PlanCandidate.objective

export type ScoredPlan = Plan & { score: PlanScore };
