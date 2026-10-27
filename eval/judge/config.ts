export interface DecisionJudgeConfig {
  judgeModel: string;
  judgeRunsPerScenario: number;
  judgeMaxConcurrency: number;
  outputPath: string;
}

export class DecisionJudgeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionJudgeConfigError";
  }
}

function boundedInteger(value: string | undefined, fallback: number, key: string, max: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new DecisionJudgeConfigError(`${key} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

export function loadDecisionJudgeConfig(env: NodeJS.ProcessEnv = process.env): DecisionJudgeConfig {
  return {
    judgeModel: env.DECISION_JUDGE_MODEL?.trim() || "openai:gpt-4.1-mini",
    judgeRunsPerScenario: boundedInteger(env.JUDGE_RUNS_PER_SCENARIO, 1, "JUDGE_RUNS_PER_SCENARIO", 3),
    judgeMaxConcurrency: boundedInteger(env.JUDGE_MAX_CONCURRENCY, 1, "JUDGE_MAX_CONCURRENCY", 4),
    outputPath: env.DECISION_JUDGE_OUTPUT_PATH?.trim() || "eval-results/judge",
  };
}

export function missingDecisionJudgeCredential(model: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (model.startsWith("openai:") && !env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  return undefined;
}
