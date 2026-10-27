// ============================================================
// src/decision/feasibility.ts — 可行性评分与候选排序
//
// 从 spec/constraints.ts 迁出，保持 spec 层只有类型和契约。
// ============================================================

import type { Plan, PlanCandidate } from "../../spec/types.js";
import { checkTimeConflict, timeToMinutes } from "../../spec/constraints.js";
import { transitScorePenalty, checkTransitFeasible } from "../../spec/transit.js";
import { buildDefaultActivityPlanCompletenessRequirements, evaluatePlanCompleteness } from "../constraints/plan-completeness.js";

/** 可行性总评分 (0-100)，综合时间冲突、方案完整性、通勤耗时 */
export function calcFeasibilityScore(plan: Plan): number {
  let score = 100;

  // 1. 时间冲突扣分
  for (let i = 0; i < plan.activities.length - 1; i++) {
    if (!checkTimeConflict(plan.activities[i], plan.activities[i + 1]).passed) {
      score -= 30;
    }
  }

  // 2. 方案完整性扣分
  for (const c of evaluatePlanCompleteness(plan, buildDefaultActivityPlanCompletenessRequirements(plan.leadRole)).failures) {
    if (!c.passed) score -= 20;
  }

  // 3. 通勤耗时惩罚（逐段累加）
  let totalTransitPenalty = 0;
  for (const act of plan.activities) {
    if (act.transitTo) {
      totalTransitPenalty += transitScorePenalty(act.transitTo.totalMinutes);
      if (act.transitTo.totalMinutes > 90) {
        score -= 40;
      }
      const prevEnd = plan.activities[act.order - 2]?.scheduledEnd ?? "00:00";
      const available = timeToMinutes(act.scheduledStart) - timeToMinutes(prevEnd);
      if (available > 0) {
        if (!checkTransitFeasible(act.transitTo, available).passed) {
          score -= 30;
        }
      }
    }
  }
  score -= totalTransitPenalty;

  return Math.max(0, Math.min(100, score));
}

/** 按可行性分降序排列候选方案 */
export function rankCandidates(candidates: PlanCandidate[]): PlanCandidate[] {
  return [...candidates].sort((a, b) => b.feasibilityScore - a.feasibilityScore);
}

/** 从候选池中选出最佳方案（可行性分 > 60） */
export function selectBestPlan(candidates: PlanCandidate[]): PlanCandidate | null {
  const ranked = rankCandidates(candidates);
  if (ranked.length === 0) return null;
  return ranked[0].feasibilityScore > 60 ? ranked[0] : null;
}
