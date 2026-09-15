// ============================================================
// eval/baseline.ts — 重构前风格的固定 5-stage Baseline
//
// 目的不是保留旧代码，而是提供一个可重复的对照组：
// 直接按原来的 stage1 -> stage2 -> stage3 -> stage4 -> stage5
// 执行，不经过 Runtime Plan / Agent Loop / ToolExecutor。
// ============================================================

import {
  stage1_parseIntent,
  stage2_followUp,
  stage3_generateCandidates,
  stage4_feasibilityCheck,
  stage5_selectBest,
} from "../src/planner/engine.js";
import type { PlanningState, StructuredConstraints } from "../spec/types.js";
import type { EvalCaseResult } from "./types.js";
import { calcPlanMetrics } from "./metrics.js";

export async function runBaseline(
  rawText: string,
  parseFn: (text: string) => StructuredConstraints,
  caseName: string,
): Promise<EvalCaseResult> {
  const start = performance.now();
  let state: PlanningState = {
    stage: "intent_parsing",
    errors: [],
  };

  try {
    state = await stage1_parseIntent(state, rawText, parseFn);
    state = await stage2_followUp(state);
    state = await stage3_generateCandidates(state);
    state = await stage4_feasibilityCheck(state);
    state = await stage5_selectBest(state);

    const plan = state.selectedPlan;
    const checks = plan
      ? checkPlan(plan)
      : { passed: false, passRate: 0 };

    return {
      caseName,
      runner: "baseline",
      passed: Boolean(plan && !state.errors.length && checks.passed),
      taskSuccess: Boolean(plan),
      constraintPassRate: checks.passRate,
      durationMs: Math.round(performance.now() - start),
      replanCount: 0,
      toolCalls: 0,
      traceEvents: 0,
      errors: state.errors,
      planId: plan?.id,
    };
  } catch (err) {
    return {
      caseName,
      runner: "baseline",
      passed: false,
      taskSuccess: false,
      constraintPassRate: 0,
      durationMs: Math.round(performance.now() - start),
      replanCount: 0,
      toolCalls: 0,
      traceEvents: 0,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}

function checkPlan(plan: NonNullable<PlanningState["selectedPlan"]>): { passed: boolean; passRate: number } {
  const metrics = calcPlanMetrics(plan);
  const checks = [
    metrics.hasAttraction,
    metrics.hasRestaurant,
    plan.totalDurationHours >= 3 && plan.totalDurationHours <= 7,
    plan.feasibilityScore >= 50,
  ];

  const passRate = checks.filter(Boolean).length / checks.length;
  return {
    passed: checks.every(Boolean),
    passRate,
  };
}
