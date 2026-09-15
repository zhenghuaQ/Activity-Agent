// ============================================================
// eval/runtime.ts — Agent Runtime Eval Runner
// ============================================================

import { parseIntent } from "../src/intent/parser.js";
import { runFullPipeline } from "../src/planner/engine.js";
import type { EvalCaseResult } from "./types.js";
import { calcPlanMetrics } from "./metrics.js";

export async function runRuntime(
  rawText: string,
  caseName: string,
): Promise<EvalCaseResult> {
  const start = performance.now();

  try {
    const result = await runFullPipeline(rawText, parseIntent, {
      sessionId: `eval_${caseName}`,
    });

    const plan = result.agentState.planning.selectedPlan;
    const evaluation = result.agentState.constraintEvaluations?.at(-1);
    const constraintChecks = evaluation?.checks ?? [];
    const constraintPassRate = constraintChecks.length === 0
      ? (result.success ? 1 : 0)
      : constraintChecks.filter((check) => check.passed).length / constraintChecks.length;

    // 保留 plan metrics，确保 Eval 仍然和原有 Harness 指标兼容。
    if (plan) calcPlanMetrics(plan);

    return {
      caseName,
      runner: "runtime",
      passed: result.success,
      taskSuccess: result.success && Boolean(plan),
      constraintPassRate,
      durationMs: Math.round(performance.now() - start),
      replanCount: result.agentState.replanCount ?? 0,
      toolCalls: result.agentState.toolCalls.length,
      traceEvents: result.agentState.trace.length,
      errors: [...result.agentState.errors],
      planId: plan?.id,
    };
  } catch (err) {
    return {
      caseName,
      runner: "runtime",
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
