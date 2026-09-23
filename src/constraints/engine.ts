// ============================================================
// src/constraints/engine.ts — Constraint Engine
//
// 将“方案是否满足约束”的判断从 Planner / Decision Engine 中抽离。
// 第一版只做确定性领域校验，不改变既有 Stage 4 的过滤策略。
// ============================================================

import type { Plan, StructuredConstraints } from "../../spec/types.js";
import {
  checkPlanCompleteness,
  checkTimeConflict,
  type ConstraintCheck,
  timeToMinutes,
} from "../../spec/constraints.js";
import { checkTransitFeasible } from "../../spec/transit.js";

export interface ConstraintEvaluation {
  passed: boolean;
  checks: ConstraintCheck[];
}

/**
 * 约束引擎：给定一个完整方案，返回可解释的约束检查结果。
 *
 * 注意：本阶段只负责“判断”，不负责决定候选是否被淘汰。
 * 候选过滤仍由现有 stage4_feasibilityCheck 控制，以保证重构零行为回归。
 */
export class ConstraintEngine {
  evaluatePlan(
    plan: Plan,
    constraints: StructuredConstraints
  ): ConstraintEvaluation {
    const checks: ConstraintCheck[] = [];

    // 1. 时间顺序 / 冲突
    for (let i = 0; i < plan.activities.length - 1; i += 1) {
      checks.push(checkTimeConflict(plan.activities[i], plan.activities[i + 1]));
    }

    // 2. 方案完整性
    checks.push(...checkPlanCompleteness(plan));

    // 3. 通勤可行性
    for (const act of plan.activities) {
      if (!act.transitTo) continue;

      const prevEnd = plan.activities[act.order - 2]?.scheduledEnd;
      if (!prevEnd) continue;

      const available = timeToMinutes(act.scheduledStart) - timeToMinutes(prevEnd);
      if (available < 0) {
        checks.push({
          passed: false,
          rule: "transit_time_window",
          detail: `${act.place.name}前的可用通勤窗口为${available}min，时间窗口无效`,
        });
        continue;
      }

      checks.push(checkTransitFeasible(act.transitTo, available));
    }

    // 4. 出发点距离：只有用户明确给出的 hardMaxKm 才构成硬约束。
    if (constraints.distance.hardMaxKm !== undefined) {
      for (const act of plan.activities) {
        const maxKm = constraints.distance.hardMaxKm;
        checks.push({
          passed: act.place.distanceKm <= maxKm,
          rule: "within_distance",
          detail: act.place.distanceKm <= maxKm
            ? `${act.place.name} ${act.place.distanceKm}km ≤ ${maxKm}km`
            : `${act.place.name} ${act.place.distanceKm}km > ${maxKm}km`,
        });
      }
    }

    // 5. 目的地是硬约束：任何活动跨城都不能被视为成功方案。
    if (constraints.destination?.city) {
      const expected = constraints.destination.city;
      for (const act of plan.activities) {
        const actual = act.place.location.city;
        checks.push({ passed: actual.includes(expected) || expected.includes(actual), rule: "within_destination",
          detail: actual.includes(expected) || expected.includes(actual)
            ? `${act.place.name} 位于目的地 ${expected}` : `${act.place.name} 位于 ${actual}，不属于目的地 ${expected}` });
      }
    }

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  }
}

export const constraintEngine = new ConstraintEngine();
