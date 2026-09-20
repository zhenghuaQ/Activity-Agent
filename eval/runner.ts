import "dotenv/config";
import { parseIntent } from "../src/intent/parser.js";
// ============================================================
// eval/runner.ts — Harness V2 对照实验 Runner
//
// Baseline：直接执行既有 5-stage Pipeline
// Runtime ：AgentState + Plan + Executor + ToolExecutor +
//            Evaluator + Replanner + Trace
// ============================================================

import { ALL_CASES, type EvalCase } from "./cases.js";
import { runBaseline } from "./baseline.js";
import { runRuntime } from "./runtime.js";
import type { EvalCaseResult, EvalComparison } from "./types.js";
import { CONVERSATION_CASES } from "./conversation-cases.js";
import { runConversationCase } from "./conversation.js";
import { bootstrapMean, pairedBootstrapDifference, wilsonInterval } from "./statistics.js";

function compare(
  baseline: EvalCaseResult,
  runtime: EvalCaseResult,
): EvalComparison {
  return {
    caseName: baseline.caseName,
    baseline,
    runtime,
    delta: {
      taskSuccess: Number(runtime.taskSuccess) - Number(baseline.taskSuccess),
      constraintPassRate: runtime.constraintPassRate - baseline.constraintPassRate,
      durationMs: runtime.durationMs - baseline.durationMs,
      replanCount: runtime.replanCount - baseline.replanCount,
      toolCalls: runtime.toolCalls - baseline.toolCalls,
    },
  };
}

function printResult(label: string, result: EvalCaseResult): void {
  const success = result.taskSuccess ? "✓" : "✗";
  console.log(
    `  ${label.padEnd(8)} ${success} ` +
    `success=${result.taskSuccess ? "yes" : "no"} ` +
    `constraint=${(result.constraintPassRate * 100).toFixed(0)}% ` +
    `latency=${result.durationMs}ms ` +
    `replans=${result.replanCount} ` +
    `tools=${result.toolCalls} ` +
    `trace=${result.traceEvents}` +
    (result.runtimeEntry ? ` entry=${result.runtimeEntry} status=${result.terminalStatus}` : ""),
  );

  if (result.errors.length > 0) {
    console.log(`           errors=${result.errors.join("; ")}`);
  }
}

async function runCase(testCase: EvalCase): Promise<EvalComparison> {
  const [baseline, runtime] = await Promise.all([
    runBaseline(testCase.rawText, parseIntent, testCase.name),
    runRuntime(testCase.rawText, testCase.name),
  ]);

  return compare(baseline, runtime);
}

async function main() {
  console.log("=".repeat(78));
  console.log("  Activity-Agent Evaluation Harness V2");
  console.log("  Baseline  VS  Agent Runtime");
  console.log("=".repeat(78));
  console.log();

  const comparisons: EvalComparison[] = [];

  for (const testCase of ALL_CASES) {
    console.log(`▶ ${testCase.name} — ${testCase.description}`);
    const result = await runCase(testCase);
    comparisons.push(result);
    printResult("Baseline", result.baseline);
    printResult("Runtime", result.runtime);
    console.log(
      `  Δ        success=${result.delta.taskSuccess >= 0 ? "+" : ""}${result.delta.taskSuccess} ` +
      `constraint=${(result.delta.constraintPassRate * 100).toFixed(0)}pp ` +
      `latency=${result.delta.durationMs >= 0 ? "+" : ""}${result.delta.durationMs}ms ` +
      `replans=${result.delta.replanCount >= 0 ? "+" : ""}${result.delta.replanCount}`,
    );
    console.log();
  }

  const baselineSuccess = comparisons.filter((c) => c.baseline.taskSuccess).length;
  const runtimeSuccess = comparisons.filter((c) => c.runtime.taskSuccess).length;
  const avg = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  console.log("=".repeat(78));
  console.log("Summary");
  console.log(`  Task success       Baseline ${baselineSuccess}/${comparisons.length}  |  Runtime ${runtimeSuccess}/${comparisons.length}`);
  console.log(`  Avg constraint     Baseline ${(avg(comparisons.map(c => c.baseline.constraintPassRate)) * 100).toFixed(1)}%  |  Runtime ${(avg(comparisons.map(c => c.runtime.constraintPassRate)) * 100).toFixed(1)}%`);
  console.log(`  Avg latency        Baseline ${Math.round(avg(comparisons.map(c => c.baseline.durationMs)))}ms  |  Runtime ${Math.round(avg(comparisons.map(c => c.runtime.durationMs)))}ms`);
  console.log(`  Avg replans        Baseline 0.0  |  Runtime ${avg(comparisons.map(c => c.runtime.replanCount)).toFixed(1)}`);
  console.log(`  Avg trace events   Baseline 0.0  |  Runtime ${avg(comparisons.map(c => c.runtime.traceEvents)).toFixed(1)}`);
  console.log("=".repeat(78));

  console.log("\nMulti-turn conversation evaluation (task is the sampling unit)");
  const stateless = [];
  const memory = [];
  for (const testCase of CONVERSATION_CASES) {
    const baselineResult = await runConversationCase(testCase, false);
    const memoryResult = await runConversationCase(testCase, true);
    stateless.push(baselineResult);
    memory.push(memoryResult);
    console.log(
      `  ${testCase.name.padEnd(30)} task=${memoryResult.taskSuccess ? "yes" : "no"} `
      + `memory=${memoryResult.memoryErrors}/${memoryResult.memoryChecks} `
      + `hard=${memoryResult.hardConstraintViolations}/${memoryResult.hardConstraintChecks} `
      + `preference=${memoryResult.preferenceMatches}/${memoryResult.preferenceChecks} `
      + `latency=${memoryResult.durationMs}ms turns=${memoryResult.turns}`
      + (memoryResult.errors.length ? ` errors=${memoryResult.errors.join(",")}` : ""),
    );
  }

  const task = wilsonInterval(memory.filter((value) => value.taskSuccess).length, memory.length);
  const memoryChecks = memory.reduce((sum, value) => sum + value.memoryChecks, 0);
  const memoryErrors = memory.reduce((sum, value) => sum + value.memoryErrors, 0);
  const hardChecks = memory.reduce((sum, value) => sum + value.hardConstraintChecks, 0);
  const hardErrors = memory.reduce((sum, value) => sum + value.hardConstraintViolations, 0);
  const memoryTaskRate = wilsonInterval(
    memory.filter((value) => value.memoryErrors > 0).length,
    memory.length,
  );
  const hardTaskRate = wilsonInterval(
    memory.filter((value) => value.hardConstraintViolations > 0).length,
    memory.length,
  );
  const latency = bootstrapMean(memory.map((value) => value.durationMs));
  const preference = bootstrapMean(memory.filter((value) => value.preferenceChecks > 0)
    .map((value) => value.preferenceMatches / value.preferenceChecks));
  const latencyDelta = pairedBootstrapDifference(
    stateless.map((value) => value.durationMs),
    memory.map((value) => value.durationMs),
  );
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(`  Primary task success       ${pct(task.estimate)} (95% Wilson ${pct(task.lower)}–${pct(task.upper)}, tasks=${task.n})`);
  console.log(`  Tasks with memory error    ${pct(memoryTaskRate.estimate)} (95% Wilson ${pct(memoryTaskRate.lower)}–${pct(memoryTaskRate.upper)}, raw=${memoryErrors}/${memoryChecks} checks)`);
  console.log(`  Tasks with hard violation  ${pct(hardTaskRate.estimate)} (95% Wilson ${pct(hardTaskRate.lower)}–${pct(hardTaskRate.upper)}, raw=${hardErrors}/${hardChecks} checks)`);
  console.log(`  Auxiliary preference coverage ${pct(preference.estimate)} (task bootstrap 95% ${pct(preference.lower)}–${pct(preference.upper)})`);
  console.log(`  Auxiliary latency mean     ${latency.estimate.toFixed(0)}ms (task bootstrap 95% ${latency.lower.toFixed(0)}–${latency.upper.toFixed(0)}ms)`);
  console.log(`  Paired latency Δ           ${latencyDelta.estimate.toFixed(0)}ms (95% task bootstrap ${latencyDelta.lower.toFixed(0)}–${latencyDelta.upper.toFixed(0)}ms)`);
  console.log("  Note: turns/checks are clustered within tasks; confidence intervals therefore use tasks, not individual turns, as independent samples.");
  console.log("  Note: this fixed suite is a development signal; expand and freeze a representative holdout before release gating.");

  // 这里不以“Runtime 必须优于 Baseline”作为退出条件。
  // Eval Harness 的职责是发现回归与量化权衡，而不是人为制造漂亮结果。
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
