import type { DecisionOutcome } from "../decision/outcome.js";

export const DECISION_JUDGE_VERSION = "decision-judge-v1.0" as const;

export const JUDGE_DIMENSIONS = [
  "semantic_goal_alignment",
  "plan_coherence",
  "tradeoff_quality",
  "interaction_quality",
] as const;

export type JudgeDimension = typeof JUDGE_DIMENSIONS[number];

export interface DimensionScore {
  score: 1 | 2 | 3 | 4 | 5;
  comment: string;
}

export type JudgeScores = Record<JudgeDimension, DimensionScore>;

export interface JudgeRunResult {
  scenarioId: string;
  benchmarkVersion: string;
  judgeVersion: typeof DECISION_JUDGE_VERSION;
  judgeModel: string;
  deterministicOutcome: DecisionOutcome;
  deterministicMetrics: {
    taskSuccess: boolean;
    runtimeCompleted: boolean;
    planGenerated: boolean;
    hardConstraintChecks: number;
    hardConstraintViolations: number;
    adaptationChecks: number;
    adaptationErrors: number;
    preferenceChecks: number;
    preferenceMatches: number;
  };
  judge?: JudgeScores;
  judgeSkippedReason?: "runtime_failure" | "invalid_execution_artifact";
  judgeCalls: number;
  judgeErrors?: string[];
  repetitions?: JudgeScores[];
}

export interface JudgeArtifact {
  benchmarkVersion: string;
  judgeVersion: typeof DECISION_JUDGE_VERSION;
  judgeModel: string;
  timestamp: string;
  judgeRunsPerScenario: number;
  judgeMaxConcurrency: number;
  judgeCalls: number;
  scenarios: JudgeRunResult[];
}

export function isJudgeScore(value: unknown): value is 1 | 2 | 3 | 4 | 5 {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}
