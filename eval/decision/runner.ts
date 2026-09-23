import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DECISION_BENCHMARK_VERSION } from "./scenarios/schema.js";
import { DECISION_SCENARIOS } from "./scenarios/cases.js";
import { validateDecisionScenarios } from "./scenarios/validate.js";
import { runConversationCase } from "./evaluators/conversation.js";
import type { ConversationEvalResult } from "./types.js";
import { bootstrapMean, pairedBootstrapDifference, wilsonInterval } from "../shared/statistics.js";

/**
 * Decision Agent Evaluation V3 主入口。
 * Scenario 自带 environment/data fixture，避免 benchmark 与运行环境错配。
 */
export async function runDecisionEval(): Promise<void> {
  console.log("=".repeat(78));
  console.log("  Decision Agent Evaluation V3");
  console.log(`  Benchmark ${DECISION_BENCHMARK_VERSION} — Scenario-based multi-turn suite`);
  console.log("=".repeat(78));
  console.log();

  const scenarios = validateDecisionScenarios(DECISION_SCENARIOS);
  const stateless: ConversationEvalResult[] = [];
  const memory: ConversationEvalResult[] = [];
  for (const scenario of scenarios) {
    const baselineResult = await runConversationCase(scenario, false);
    const memoryResult = await runConversationCase(scenario, true);
    stateless.push(baselineResult);
    memory.push(memoryResult);
    console.log(
      `  ${scenario.id.padEnd(30)} outcome=${memoryResult.outcome} `
      + `runtime=${memoryResult.runtimeCompleted ? "completed" : "failure"} `
      + `plan=${memoryResult.planGenerated ? "yes" : "no"} `
      + `task=${memoryResult.taskSuccess ? "yes" : "no"} `
      + `memory=${memoryResult.memoryErrors}/${memoryResult.memoryChecks} `
      + `hard=${memoryResult.hardConstraintViolations}/${memoryResult.hardConstraintChecks} `
      + `preference=${memoryResult.preferenceMatches}/${memoryResult.preferenceChecks} `
      + `adaptation=${memoryResult.adaptationErrors}/${memoryResult.adaptationChecks} `
      + `latency=${memoryResult.durationMs}ms turns=${memoryResult.turns}`
      + (memoryResult.errors.length ? ` errors=${memoryResult.errors.join(",")}` : ""),
    );
  }

  const task = wilsonInterval(memory.filter((value) => value.taskSuccess).length, memory.length);
  const outcomeCounts = new Map<string, number>();
  for (const value of memory) outcomeCounts.set(value.outcome, (outcomeCounts.get(value.outcome) ?? 0) + 1);
  const runtimeCompletedCount = memory.filter(value => value.runtimeCompleted).length;
  const memoryChecks = memory.reduce((sum, value) => sum + value.memoryChecks, 0);
  const memoryErrors = memory.reduce((sum, value) => sum + value.memoryErrors, 0);
  const hardChecks = memory.reduce((sum, value) => sum + value.hardConstraintChecks, 0);
  const hardErrors = memory.reduce((sum, value) => sum + value.hardConstraintViolations, 0);
  const adaptationChecks = memory.reduce((sum, value) => sum + value.adaptationChecks, 0);
  const adaptationErrors = memory.reduce((sum, value) => sum + value.adaptationErrors, 0);
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
  console.log(`  Task success               ${memory.filter(value => value.taskSuccess).length}/${memory.length} (${pct(task.estimate)}, 95% Wilson ${pct(task.lower)}–${pct(task.upper)})`);
  console.log("  Outcome distribution");
  for (const outcome of ["feasible_plan", "no_feasible_plan", "invalid_plan", "missed_feasible_plan", "runtime_failure"]) {
    console.log(`    ${outcome.padEnd(24)} ${outcomeCounts.get(outcome) ?? 0}`);
  }
  console.log(`  Runtime completion        ${runtimeCompletedCount}/${memory.length}`);
  console.log(`  Tasks with memory error    ${pct(memoryTaskRate.estimate)} (95% Wilson ${pct(memoryTaskRate.lower)}–${pct(memoryTaskRate.upper)}, raw=${memoryErrors}/${memoryChecks} checks)`);
  console.log(`  Tasks with hard violation  ${pct(hardTaskRate.estimate)} (95% Wilson ${pct(hardTaskRate.lower)}–${pct(hardTaskRate.upper)}, raw=${hardErrors}/${hardChecks} checks)`);
  console.log(`  Adaptation errors          ${adaptationErrors}/${adaptationChecks} checks`);
  console.log(`  Auxiliary preference coverage ${pct(preference.estimate)} (task bootstrap 95% ${pct(preference.lower)}–${pct(preference.upper)})`);
  console.log(`  Auxiliary latency mean     ${latency.estimate.toFixed(0)}ms (task bootstrap 95% ${latency.lower.toFixed(0)}–${latency.upper.toFixed(0)}ms)`);
  console.log(`  Paired latency Δ           ${latencyDelta.estimate.toFixed(0)}ms (95% task bootstrap ${latencyDelta.lower.toFixed(0)}–${latencyDelta.upper.toFixed(0)}ms)`);
  console.log("  Note: turns/checks are clustered within tasks; confidence intervals therefore use tasks, not individual turns, as independent samples.");
  console.log("  Note: this fixed suite is a development signal; expand and freeze a representative holdout before release gating.");
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runDecisionEval().catch((err) => {
    console.error("Decision evaluation failed:", err);
    process.exit(1);
  });
}
