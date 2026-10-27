export interface StressEvalConfig {
  runsPerScenario: number;
  maxConcurrency: number;
  simulatedUserModel: string;
  outputPath: string;
}

export class StressConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StressConfigurationError";
  }
}

function parseBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new StressConfigurationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function loadStressEvalConfig(env: NodeJS.ProcessEnv = process.env): StressEvalConfig {
  return {
    runsPerScenario: parseBoundedInteger(env.STRESS_RUNS_PER_SCENARIO, 1, "STRESS_RUNS_PER_SCENARIO", 1, 20),
    maxConcurrency: parseBoundedInteger(env.STRESS_MAX_CONCURRENCY, 1, "STRESS_MAX_CONCURRENCY", 1, 4),
    simulatedUserModel: env.OPENEVALS_SIM_USER_MODEL?.trim() || "openai:gpt-4.1-mini",
    outputPath: env.STRESS_OUTPUT_PATH?.trim() || "eval-results/stress",
  };
}

export function missingModelCredential(model: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (model.startsWith("openai:") && !env.OPENAI_API_KEY?.trim()) return "OPENAI_API_KEY";
  return undefined;
}
