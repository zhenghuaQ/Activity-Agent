import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDecisionScenario } from "../decision/evaluators/conversation.js";
import { runScenarioOpenEvals } from "../openevals/scripted-runner.js";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";
import { DECISION_SCENARIOS } from "../decision/scenarios/cases.js";
import { validateDecisionScenarios } from "../decision/scenarios/validate.js";
import type { DecisionScenario } from "../decision/scenarios/schema.js";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import type { ConversationEvalResult } from "../decision/types.js";
import { evaluateDecisionSemantics, type JudgeFactory } from "./evaluators.js";
import { DecisionJudgeConfigError, loadDecisionJudgeConfig, missingDecisionJudgeCredential, type DecisionJudgeConfig } from "./config.js";
import { DECISION_JUDGE_VERSION, JUDGE_DIMENSIONS, type DimensionScore, type JudgeArtifact, type JudgeScores, type JudgeRunResult } from "./schema.js";
import { printJudgeSummary } from "./summary.js";

export interface DecisionJudgeDependencies {
  runAgent?: (scenario: DecisionScenario) => Promise<{
    execution: DecisionScenarioRunOutput;
    deterministic: ConversationEvalResult;
  }>;
  judgeFactory?: JudgeFactory;
  onJudgeCall?: () => Promise<void>;
  persist?: (artifact: JudgeArtifact) => Promise<void>;
  printSummary?: (artifact: JudgeArtifact) => void;
}

function deterministicMetrics(result: ConversationEvalResult) {
  return {
    taskSuccess: result.taskSuccess,
    runtimeCompleted: result.runtimeCompleted,
    planGenerated: result.planGenerated,
    hardConstraintChecks: result.hardConstraintChecks,
    hardConstraintViolations: result.hardConstraintViolations,
    adaptationChecks: result.adaptationChecks,
    adaptationErrors: result.adaptationErrors,
    preferenceChecks: result.preferenceChecks,
    preferenceMatches: result.preferenceMatches,
  };
}

export async function runAgentForJudge(scenario: DecisionScenario): Promise<{
  execution: DecisionScenarioRunOutput;
  deterministic: ConversationEvalResult;
}> {
  const executionInput = { ...scenario };
  const { execution } = await runScenarioOpenEvals(executionInput, true, randomUUID());
  const deterministic = evaluateDecisionScenario(scenario, execution, true);
  return { execution, deterministic };
}

async function runWithConcurrency<T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  }));
  return output;
}

async function repeatScenarioJudge(input: {
  scenario: DecisionScenario;
  execution: DecisionScenarioRunOutput;
  deterministic: ConversationEvalResult;
  config: DecisionJudgeConfig;
  factory?: JudgeFactory;
  onCall?: () => void;
  beforeCall?: () => Promise<void>;
}): Promise<{ scores: JudgeScores[]; calls: number; errors: string[] }> {
  const scores: JudgeScores[] = [];
  const errors: string[] = [];
  let calls = 0;
  for (let repetition = 0; repetition < input.config.judgeRunsPerScenario; repetition += 1) {
    const result = await evaluateDecisionSemantics({
      scenario: input.scenario,
      execution: input.execution,
      deterministic: input.deterministic,
      model: input.config.judgeModel,
      factory: input.factory,
      beforeCall: input.beforeCall ? async () => input.beforeCall!() : undefined,
      onCall: input.onCall,
    });
    calls += result.calls;
    errors.push(...result.errors);
    if (result.scores) scores.push(result.scores);
  }
  return { scores, calls, errors };
}

function averageScores(repetitions: JudgeScores[]): JudgeScores | undefined {
  if (repetitions.length === 0) return undefined;
  return Object.fromEntries(JUDGE_DIMENSIONS.map(dimension => {
    const values = repetitions.map(repeat => repeat[dimension]);
    const score = Math.round(values.reduce((sum, value) => sum + value.score, 0) / values.length) as DimensionScore["score"];
    return [dimension, {
      score,
      comment: values.length === 1
        ? values[0]!.comment
        : `Aggregated from ${values.length} independent judge runs; see repetitions for individual scores.`,
    }];
  })) as JudgeScores;
}

function resultRecord(
  scenario: DecisionScenario,
  deterministic: ConversationEvalResult,
  judgeModel: string,
): JudgeRunResult {
  return {
    scenarioId: scenario.id,
    benchmarkVersion: DECISION_BENCHMARK_VERSION,
    judgeVersion: DECISION_JUDGE_VERSION,
    judgeModel,
    deterministicOutcome: deterministic.outcome,
    deterministicMetrics: deterministicMetrics(deterministic),
    judgeCalls: 0,
    ...(deterministic.outcome === "runtime_failure" ? { judgeSkippedReason: "runtime_failure" as const } : {}),
  };
}

export async function runDecisionJudgeEval(
  config: DecisionJudgeConfig = loadDecisionJudgeConfig(),
  dependencies: DecisionJudgeDependencies = {},
): Promise<JudgeArtifact> {
  const missing = missingDecisionJudgeCredential(config.judgeModel);
  if (missing) throw new DecisionJudgeConfigError(`Decision Judge evaluation requires model credentials for DECISION_JUDGE_MODEL (${missing}).`);
  const scenarios = validateDecisionScenarios(DECISION_SCENARIOS);
  const runAgent = dependencies.runAgent ?? runAgentForJudge;
  const runs: JudgeRunResult[] = [];
  let judgeCalls = 0;

  const judgeQueue: Array<() => Promise<void>> = [];
  for (const scenario of scenarios) {
    const { execution, deterministic } = await runAgent(scenario);
    const record = resultRecord(scenario, deterministic, config.judgeModel);
    if (deterministic.outcome === "runtime_failure") {
      runs.push(record);
      continue;
    }
    judgeQueue.push(async () => {
      try {
        const judged = await repeatScenarioJudge({
          scenario,
          execution,
          deterministic,
          config,
          factory: dependencies.judgeFactory,
          onCall: () => { record.judgeCalls += 1; judgeCalls += 1; },
          beforeCall: dependencies.onJudgeCall,
        });
        record.judgeErrors = judged.errors;
        record.repetitions = judged.scores;
        record.judge = averageScores(judged.scores);
        if (!record.judge && judged.errors.includes("invalid_execution_artifact")) {
          record.judgeSkippedReason = "invalid_execution_artifact";
        }
      } catch (error) {
        record.judgeErrors = [error instanceof Error ? error.message : String(error)];
      }
    });
    runs.push(record);
  }

  await runWithConcurrency(judgeQueue, config.judgeMaxConcurrency, task => task());

  const artifact: JudgeArtifact = {
    benchmarkVersion: DECISION_BENCHMARK_VERSION,
    judgeVersion: DECISION_JUDGE_VERSION,
    judgeModel: config.judgeModel,
    timestamp: new Date().toISOString(),
    judgeRunsPerScenario: config.judgeRunsPerScenario,
    judgeMaxConcurrency: config.judgeMaxConcurrency,
    judgeCalls,
    scenarios: runs,
  };
  await (dependencies.persist ?? (value => persistJudgeArtifact(config.outputPath, value)))(artifact);
  (dependencies.printSummary ?? printJudgeSummary)(artifact);
  return artifact;
}

export { averageScores };

async function persistJudgeArtifact(outputPath: string, artifact: JudgeArtifact): Promise<string> {
  const absolute = path.resolve(outputPath);
  await fs.mkdir(absolute, { recursive: true });
  const filename = `decision-judge-${artifact.judgeVersion}-${artifact.timestamp.replaceAll(":", "-")}-${randomUUID()}.json`;
  const file = path.join(absolute, filename);
  await fs.writeFile(file, JSON.stringify(artifact, null, 2), "utf8");
  return file;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runDecisionJudgeEval().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("Decision Judge evaluation requires")
      ? message
      : `Decision Judge evaluation failed: ${message}`);
    process.exit(1);
  });
}
