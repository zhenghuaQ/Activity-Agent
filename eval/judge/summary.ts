import type { JudgeArtifact, JudgeDimension, JudgeRunResult } from "./schema.js";
import { JUDGE_DIMENSIONS } from "./schema.js";

export interface JudgeDimensionSummary {
  count: number;
  mean?: number;
  min?: number;
  max?: number;
  standardDeviation?: number;
}

export function summarizeJudgeRuns(artifact: JudgeArtifact): Record<JudgeDimension, JudgeDimensionSummary> {
  return Object.fromEntries(JUDGE_DIMENSIONS.map(dimension => {
    const scores: number[] = [];
    for (const scenario of artifact.scenarios) {
      if (scenario.judge?.[dimension]) scores.push(scenario.judge[dimension].score);
      else for (const repeat of scenario.repetitions ?? []) scores.push(repeat[dimension].score);
    }
    if (scores.length === 0) return [dimension, { count: 0 }];
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    const variance = scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / scores.length;
    return [dimension, {
      count: scores.length,
      mean: Number(mean.toFixed(3)),
      min: Math.min(...scores),
      max: Math.max(...scores),
      standardDeviation: Number(Math.sqrt(variance).toFixed(3)),
    }];
  })) as Record<JudgeDimension, JudgeDimensionSummary>;
}

export function printJudgeSummary(artifact: JudgeArtifact): void {
  const summary = summarizeJudgeRuns(artifact);
  const judged = artifact.scenarios.filter(scenario => scenario.judge || scenario.repetitions?.length).length;
  const skipped = artifact.scenarios.filter(scenario => scenario.judgeSkippedReason).length;
  console.log("Decision Semantic Judge");
  console.log(`Benchmark: ${artifact.benchmarkVersion}`);
  console.log(`Judge: ${artifact.judgeVersion}`);
  console.log(`Model: ${artifact.judgeModel}`);
  console.log(`Scenarios judged: ${judged}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Judge dimensions: ${JUDGE_DIMENSIONS.join(", ")}`);
  console.log(`Judge repetitions: ${artifact.judgeRunsPerScenario}`);
  console.log(`Judge calls: ${artifact.judgeCalls}`);
  for (const dimension of JUDGE_DIMENSIONS) {
    const value = summary[dimension];
    console.log(`${dimension}: mean=${value.mean ?? "n/a"} min=${value.min ?? "n/a"} max=${value.max ?? "n/a"} sd=${value.standardDeviation ?? "n/a"} n=${value.count}`);
  }
}

export function asJudgeRunResult(value: JudgeRunResult): JudgeRunResult {
  return value;
}
