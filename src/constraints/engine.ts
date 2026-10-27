// ============================================================
// src/constraints/engine.ts — Constraint Engine
//
// 将“方案是否满足约束”的判断从 Planner / Decision Engine 中抽离。
// ============================================================

import type { Plan, StructuredConstraints } from "../../spec/types.js";
import type { PlanCompletenessRequirements } from "../../spec/constraints.js";
import {
  checkTimeConflict,
  type ConstraintCheck,
  computePlanElapsedMinutes,
  timeToMinutes,
} from "../../spec/constraints.js";
import { checkTransitFeasible } from "../../spec/transit.js";
import { evaluateRestaurantDietaryCompatibility } from "./dietary.js";
import { ACTIVITY_PLAN_TEMPLATE } from "../planner/plan-composition.js";
import {
  buildEffectivePlanCompletenessRequirements,
  evaluatePlanCompleteness,
} from "./plan-completeness.js";

export interface ConstraintEvaluation {
  passed: boolean;
  checks: ConstraintCheck[];
}

export interface HardConstraintEvaluation extends ConstraintEvaluation {
  hardFailures: ConstraintCheck[];
}

// This is the single classification point for checks that invalidate a plan.
// Unlisted checks remain observable but cannot silently become hard gates.
const HARD_CONSTRAINT_RULES = new Set([
  "no_time_conflict",
  "plan_slot_requirement",
  "has_attraction",
  "has_restaurant",
  "has_break_for_elderly",
  "transit_time_window",
  "transit_feasible",
  "within_distance",
  "within_destination",
  "within_requested_duration",
  "dietary_requirements_satisfied",
]);

export function isHardConstraintSatisfied(evaluation: ConstraintEvaluation): boolean {
  return evaluation.checks.every((check) => check.passed || !HARD_CONSTRAINT_RULES.has(check.rule));
}

/**
 * 约束引擎：给定一个完整方案，返回可解释的约束检查结果。
 *
 * evaluatePlan 保留完整检查结果；evaluateHardConstraints 是候选筛选与最终验收共用的硬约束契约。
 */
export class ConstraintEngine {
  evaluatePlan(
    plan: Plan,
    constraints: StructuredConstraints,
    completenessRequirements?: PlanCompletenessRequirements,
  ): ConstraintEvaluation {
    const checks: ConstraintCheck[] = [];

    // Explicit user time limits are independent from the parser's default time window.
    if (constraints.hardMaxDurationMinutes !== undefined) {
      const actualMinutes = computePlanElapsedMinutes(plan);
      if (actualMinutes !== undefined) {
        const limitMinutes = constraints.hardMaxDurationMinutes;
        const passed = actualMinutes <= limitMinutes;
        checks.push({
          passed,
          rule: "within_requested_duration",
          actualMinutes,
          limitMinutes,
          detail: passed
            ? `完整排程用时 ${actualMinutes}min ≤ 用户上限 ${limitMinutes}min`
            : `完整排程用时 ${actualMinutes}min > 用户上限 ${limitMinutes}min`,
        });
      }
    }

    // 1. 时间顺序 / 冲突
    for (let i = 0; i < plan.activities.length - 1; i += 1) {
      checks.push(checkTimeConflict(plan.activities[i], plan.activities[i + 1]));
    }

    // 2. 方案完整性
    const requirements = completenessRequirements
      ?? buildEffectivePlanCompletenessRequirements(ACTIVITY_PLAN_TEMPLATE, {
        ...constraints,
        group: { ...constraints.group, leadRole: plan.leadRole },
      });
    checks.push(...evaluatePlanCompleteness(plan, requirements).failures);

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

    // Specific dietary requirements need explicit restaurant compatibility evidence.
    const dietaryRequirements = constraints.group.preferences.dietaryRestrictions;
    if (dietaryRequirements.length > 0) {
      const restaurants = plan.activities
        .map(activity => activity.place)
        .filter((place): place is import("../../spec/types.js").Restaurant => place.type === "restaurant");
      const dietaryEvidence = restaurants.flatMap(restaurant =>
        evaluateRestaurantDietaryCompatibility(restaurant, dietaryRequirements).requirements.map(result => ({
          restaurantId: restaurant.id,
          requirement: result.requirement,
          status: result.status,
        })),
      );
      const mealRequirement = requirements.requirements.find(requirement => requirement.role === "meal");
      const mealIsStructurallyOptional = mealRequirement?.minCount === 0;
      if (restaurants.length === 0 && !mealIsStructurallyOptional) {
        dietaryEvidence.push(...dietaryRequirements.map(requirement => ({
          restaurantId: "(missing restaurant)",
          requirement,
          status: "unknown" as const,
        })));
      }
      const passed = mealIsStructurallyOptional && restaurants.length === 0 || (dietaryEvidence.length > 0
        && dietaryEvidence.every(evidence => evidence.status === "supported"));
      if (restaurants.length > 0 || !mealIsStructurallyOptional) checks.push({
        passed,
        rule: "dietary_requirements_satisfied",
        dietaryEvidence,
        detail: passed
          ? "所有餐厅均有明确饮食兼容证据: " + dietaryEvidence.map(item => item.restaurantId + ":" + item.requirement).join(", ")
          : "饮食兼容证据不足: " + dietaryEvidence.map(item => item.restaurantId + ":" + item.requirement + "=" + item.status).join(", "),
      });
    }

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  }

  evaluateHardConstraints(
    plan: Plan,
    constraints: StructuredConstraints,
    completenessRequirements?: PlanCompletenessRequirements,
  ): HardConstraintEvaluation {
    const evaluation = this.evaluatePlan(plan, constraints, completenessRequirements);
    const hardFailures = evaluation.checks.filter((check) =>
      !check.passed && HARD_CONSTRAINT_RULES.has(check.rule));
    return {
      ...evaluation,
      passed: isHardConstraintSatisfied(evaluation),
      hardFailures,
    };
  }
}

export const constraintEngine = new ConstraintEngine();

/** Shared plan-level hard-feasibility contract used before ranking and at final acceptance. */
export function evaluatePlanHardConstraints(
  plan: Plan,
  constraints: StructuredConstraints,
  completenessRequirements?: PlanCompletenessRequirements,
): HardConstraintEvaluation {
  return constraintEngine.evaluateHardConstraints(plan, constraints, completenessRequirements);
}
