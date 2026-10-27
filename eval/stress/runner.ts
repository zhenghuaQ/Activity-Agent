import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMultiturnSimulation, type ChatCompletionMessage } from "openevals";
import { createStressAgentApp, StressAgentRuntimeFailure } from "./app-adapter.js";
import { loadStressEvalConfig, missingModelCredential, StressConfigurationError, type StressEvalConfig } from "./config.js";
import { evaluateStressRun } from "./evaluators.js";
import { stressScenarios } from "./scenarios.js";
import type { SimulationRunStatus, StressRunMetrics, StressOutcome, StressRunResult, StressScenario } from "./schema.js";
import { buildStressSimulatedUserArgs, createOpenEvalsSimulatedUser, type StressSimulatedUserFactory } from "./simulated-user.js";

export interface StressRunDependencies {
  simulatedUserFactory?: StressSimulatedUserFactory;
  appAdapterFactory?: typeof createStressAgentApp;
}

export async function runStressScenario(
  scenario: StressScenario,
  runIndex: number,
  config: StressEvalConfig,
  dependencies: StressRunDependencies = {},
): Promise<StressRunResult> {
  const threadId = `stress:${scenario.id}:${randomUUID()}`;
  const adapter = (dependencies.appAdapterFactory ?? createStressAgentApp)(scenario, threadId);
  const trajectory: Array<{ role: string; content: unknown }> = [];
  let status: SimulationRunStatus = "completed";
  let simulatorError: string | undefined;
  const startedAt = Date.now();

  try {
    if (dependencies.simulatedUserFactory === undefined) {
      const missing = missingModelCredential(config.simulatedUserModel);
      if (missing) throw new StressConfigurationError(`Stress evaluation requires ${missing} for ${config.simulatedUserModel}.`);
    }
    const userFactory = dependencies.simulatedUserFactory ?? createOpenEvalsSimulatedUser;
    const user = userFactory(buildStressSimulatedUserArgs(scenario.user, config.simulatedUserModel));
    const simulation = await runMultiturnSimulation({
      app: adapter.app,
      user,
      maxTurns: scenario.maxTurns,
      threadId,
    });
    for (const message of simulation.trajectory) {
      trajectory.push({ role: message.role, content: message.content });
    }
  } catch (error) {
    const execution = adapter.getExecution(threadId);
    if (error instanceof StressConfigurationError) {
      status = "simulator_failure";
      simulatorError = error.message;
    } else if (error instanceof StressAgentRuntimeFailure || (execution && !execution.runtime.completed)) {
      status = "agent_failure";
      const failedExecution = error instanceof StressAgentRuntimeFailure ? error.execution : execution!;
      trajectory.push(...(failedExecution.turnSnapshots.flatMap(snapshot => [
        { role: "user", content: snapshot.userInput },
        ...(snapshot.userVisibleMessage ? [{ role: "assistant", content: snapshot.userVisibleMessage }] : []),
      ])));
    } else {
      status = "simulator_failure";
      simulatorError = error instanceof Error ? error.message : String(error);
    }
  }

  const execution = adapter.getExecution(threadId);
  const observedTurnCount = execution?.turnSnapshots.length ?? 0;
  const metrics: StressRunMetrics = evaluateStressRun({
    scenario,
    status,
    execution,
    observedTurnCount,
    isolationFailure: adapter.isolationFailure(threadId),
  });
  try {
    adapter.disposeAll();
  } catch {
    status = "agent_failure";
  }

  return {
    stressBenchmarkVersion: "stress-v1.0",
    simulatedUserModel: config.simulatedUserModel,
    scenarioId: scenario.id,
    runIndex,
    maxTurns: scenario.maxTurns,
    threadId,
    status,
    simulationDurationMs: Date.now() - startedAt,
    trajectory,
    execution,
    metrics,
    ...(simulatorError ? { simulatorError } : {}),
  };
}

export interface StressBatchSummary {
  runCount: number;
  statusDistribution: Record<SimulationRunStatus, number>;
  outcomeDistribution: Record<StressOutcome | "unclassified_or_unterminated", number>;
  runtimeCompletionRate: number;
  planningTerminationRate: number;
  hardConstraintChecks: number;
  hardConstraintViolations: number;
  immutableFactChecks: number;
  immutableFactsRetained: number;
  sessionIsolationFailures: number;
  maxTurnExhaustions: number;
  runtimeErrors: number;
  simulatorFailures: number;
  replanCounts: number[];
  turnCounts: number[];
}

export function summarizeStressRuns(runs: readonly StressRunResult[]): StressBatchSummary {
  const summary: StressBatchSummary = {
    runCount: runs.length,
    statusDistribution: { completed: 0, agent_failure: 0, simulator_failure: 0 },
    outcomeDistribution: {
      feasible_plan: 0,
      no_feasible_plan: 0,
      invalid_plan: 0,
      missed_feasible_plan: 0,
      runtime_failure: 0,
      unclassified_or_unterminated: 0,
    },
    runtimeCompletionRate: 0,
    planningTerminationRate: 0,
    hardConstraintChecks: 0,
    hardConstraintViolations: 0,
    immutableFactChecks: 0,
    immutableFactsRetained: 0,
    sessionIsolationFailures: 0,
    maxTurnExhaustions: 0,
    runtimeErrors: 0,
    simulatorFailures: 0,
    replanCounts: [],
    turnCounts: [],
  };
  let agentRuns = 0;
  let completedRuns = 0;
  for (const run of runs) {
    summary.statusDistribution[run.status] += 1;
    if (run.status !== "simulator_failure") {
      agentRuns += 1;
      if (run.metrics.runtimeCompleted) completedRuns += 1;
      if (run.metrics.planningTerminated) summary.planningTerminationRate += 1;
      if (run.metrics.outcome) summary.outcomeDistribution[run.metrics.outcome] += 1;
      else summary.outcomeDistribution.unclassified_or_unterminated += 1;
      summary.hardConstraintChecks += run.metrics.hardConstraintChecks;
      summary.hardConstraintViolations += run.metrics.hardConstraintViolations;
      summary.immutableFactChecks += run.metrics.immutableFactChecks;
      summary.immutableFactsRetained += run.metrics.immutableFactsRetained;
      summary.sessionIsolationFailures += Number(run.metrics.sessionIsolationFailure);
      summary.maxTurnExhaustions += Number(run.metrics.turnExhausted);
      summary.runtimeErrors += Number(run.metrics.runtimeError);
      summary.replanCounts.push(run.metrics.replanCount);
      summary.turnCounts.push(run.metrics.turnCount);
    } else {
      summary.simulatorFailures += 1;
    }
  }
  summary.runtimeCompletionRate = agentRuns ? completedRuns / agentRuns : 0;
  summary.planningTerminationRate = agentRuns ? summary.planningTerminationRate / agentRuns : 0;
  return summary;
}

async function runBounded<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runStressBatch(
  scenarios: readonly StressScenario[],
  config: StressEvalConfig,
  dependencies: StressRunDependencies = {},
): Promise<StressRunResult[]> {
  const tasks = scenarios.flatMap(scenario =>
    Array.from({ length: config.runsPerScenario }, (_, runIndex) => ({ scenario, runIndex: runIndex + 1 })),
  );
  return runBounded(tasks, config.maxConcurrency, async task => {
    try {
      return await runStressScenario(task.scenario, task.runIndex, config, dependencies);
    } catch (error) {
      return createFailedRun(task.scenario, task.runIndex, config, error);
    }
  });
}

function createFailedRun(
  scenario: StressScenario,
  runIndex: number,
  config: StressEvalConfig,
  error: unknown,
): StressRunResult {
  const status: SimulationRunStatus = error instanceof StressConfigurationError ? "simulator_failure" : "agent_failure";
  const message = error instanceof Error ? error.message : String(error);
  return {
    stressBenchmarkVersion: "stress-v1.0",
    simulatedUserModel: config.simulatedUserModel,
    scenarioId: scenario.id,
    runIndex,
    maxTurns: scenario.maxTurns,
    threadId: `stress:${scenario.id}:setup-failure:${randomUUID()}`,
    status,
    simulationDurationMs: 0,
    trajectory: [],
    metrics: evaluateStressRun({ scenario, status, observedTurnCount: 0, isolationFailure: false }),
    ...(status === "simulator_failure" ? { simulatorError: message } : {}),
  };
}

async function persistResults(outputPath: string, runs: StressRunResult[], summary: StressBatchSummary): Promise<string> {
  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(resolvedPath, { recursive: true });
  const filename = `stress-v1.0-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`;
  const fullPath = path.join(resolvedPath, filename);
  await fs.writeFile(fullPath, JSON.stringify({ stressBenchmarkVersion: "stress-v1.0", summary, runs }, null, 2), "utf8");
  return fullPath;
}

export async function runStressEval(config = loadStressEvalConfig()): Promise<StressRunResult[]> {
  const missing = missingModelCredential(config.simulatedUserModel);
  if (missing) throw new StressConfigurationError(`Stress evaluation requires ${missing} for ${config.simulatedUserModel}.`);
  const runs = await runStressBatch(stressScenarios, config);
  const summary = summarizeStressRuns(runs);
  const artifact = await persistResults(config.outputPath, runs, summary);
  console.log(`Stress benchmark: stress-v1.0 | runs=${runs.length} | model=${config.simulatedUserModel}`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Artifact: ${artifact}`);
  return runs;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runStressEval().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Stress evaluation failed: ${message}`);
    process.exit(1);
  });
}

export type { ChatCompletionMessage };
