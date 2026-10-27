export interface PairwiseConfig {
  artifactAPath: string;
  artifactBPath: string;
  judgeModel: string;
  runsPerOrientation: number;
  maxConcurrency: number;
  outputPath: string;
}

export class PairwiseConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = "PairwiseConfigurationError"; }
}

function bounded(value: string | undefined, fallback: number, key: string, max: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new PairwiseConfigurationError(`${key} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

export function loadPairwiseConfig(env: NodeJS.ProcessEnv = process.env): PairwiseConfig {
  const artifactAPath = env.PAIRWISE_ARTIFACT_A?.trim();
  const artifactBPath = env.PAIRWISE_ARTIFACT_B?.trim();
  if (!artifactAPath || !artifactBPath) {
    throw new PairwiseConfigurationError("Pairwise evaluation requires PAIRWISE_ARTIFACT_A and PAIRWISE_ARTIFACT_B");
  }
  return {
    artifactAPath,
    artifactBPath,
    judgeModel: env.PAIRWISE_JUDGE_MODEL?.trim() || env.DECISION_JUDGE_MODEL?.trim() || "openai:gpt-4.1-mini",
    runsPerOrientation: bounded(env.PAIRWISE_RUNS_PER_ORIENTATION, 1, "PAIRWISE_RUNS_PER_ORIENTATION", 3),
    maxConcurrency: bounded(env.PAIRWISE_MAX_CONCURRENCY, 1, "PAIRWISE_MAX_CONCURRENCY", 4),
    outputPath: env.PAIRWISE_OUTPUT_PATH?.trim() || "eval-results/pairwise",
  };
}

export function missingPairwiseCredential(model: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return model.startsWith("openai:") && !env.OPENAI_API_KEY?.trim() ? "OPENAI_API_KEY" : undefined;
}
