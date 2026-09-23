// ============================================================
// src/decision/index.ts — 决策引擎编排（M2）
//
// 输入候选池 → 构建情境 → 情境调权 → 多维评分 → 帕累托多方案。
// 对外只暴露 runDecision；权重可被画像（M3）/调用方覆盖。
// ============================================================

import type { PlanCandidate, StructuredConstraints } from "../../spec/types.js";
import type { ResolvedLocation } from "../../spec/location.js";
import type {
  DecisionResult,
  ScoringWeights,
  WeatherCondition,
} from "../../spec/decision.js";
import { DEFAULT_WEIGHTS } from "../../spec/decision.js";
import { buildContext, adjustWeights } from "./context.js";
import { scorePlan } from "./score.js";
import { buildPareto } from "./pareto.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("decision");

export interface RunDecisionOptions {
  /** 覆盖参考日期（判断周末） */
  date?: Date;
  /** 覆盖天气（测试/无网） */
  weather?: WeatherCondition;
  /** 权重覆盖（画像/用户自定义，叠加在默认先验上） */
  weightOverride?: Partial<ScoringWeights>;
  /** 额外的过程说明（如上游兜底） */
  notes?: string[];
  /** Runtime 已解析的环境位置，用于情境（如天气）计算。 */
  environmentLocation?: ResolvedLocation;
}

/**
 * 执行决策：对已通过可行性门槛的候选评分并产出帕累托方案集。
 * 候选为空返回 null（由上层走兜底/提示）。
 */
export async function runDecision(
  candidates: PlanCandidate[],
  constraints: StructuredConstraints,
  opts: RunDecisionOptions = {}
): Promise<DecisionResult | null> {
  if (candidates.length === 0) return null;

  const context = await buildContext(constraints, {
    date: opts.date,
    weather: opts.weather,
    environmentLocation: opts.environmentLocation,
  });

  const base: ScoringWeights = { ...DEFAULT_WEIGHTS, ...(opts.weightOverride ?? {}) };
  const { weights, notes: weightNotes } = adjustWeights(base, context, constraints);

  for (const cand of candidates) {
    cand.plan.score = scorePlan({ plan: cand.plan, constraints, context, weights });
  }

  const result = buildPareto(candidates, [...(opts.notes ?? []), ...weightNotes]);
  if (result) {
    log.info(
      {
        recommended: result.recommended.plan.id,
        objective: result.recommended.objective,
        total: result.recommended.plan.score?.total,
        confidence: result.confidence,
        weather: context.weather,
        weekend: context.isWeekend,
      },
      "决策完成"
    );
  }
  return result;
}

export { scorePlan } from "./score.js";
export { buildContext, adjustWeights } from "./context.js";
export { buildPareto } from "./pareto.js";
export { explainPlan, compareAgainst } from "./explain.js";
export { withRadiusEscalation, withSpatialRadiusEscalation } from "./fallback.js";
