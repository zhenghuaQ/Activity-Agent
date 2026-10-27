import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";

export interface LangSmithEvalConfig {
  apiKey: string;
  endpoint?: string;
  project?: string;
  workspaceId?: string;
  datasetName: string;
  experimentPrefix: string;
  maxConcurrency: number;
  decisionRunner: "manual" | "openevals-scripted";
}

export class LangSmithConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LangSmithConfigurationError";
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function defaultDatasetName(version = DECISION_BENCHMARK_VERSION): string {
  return `activity-agent-${version}`;
}

export function loadLangSmithConfig(
  env: NodeJS.ProcessEnv = process.env,
): LangSmithEvalConfig {
  const apiKey = optional(env.LANGSMITH_API_KEY);
  if (!apiKey) throw new LangSmithConfigurationError("LangSmith evaluation requires LANGSMITH_API_KEY");

  const configuredConcurrency = optional(env.LANGSMITH_EVAL_MAX_CONCURRENCY);
  const maxConcurrency = configuredConcurrency === undefined ? 2 : Number(configuredConcurrency);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 16) {
    throw new LangSmithConfigurationError("LANGSMITH_EVAL_MAX_CONCURRENCY must be an integer from 1 to 16");
  }
  const decisionRunner = optional(env.LANGSMITH_DECISION_RUNNER) ?? "manual";
  if (decisionRunner !== "manual" && decisionRunner !== "openevals-scripted") {
    throw new LangSmithConfigurationError("LANGSMITH_DECISION_RUNNER must be manual or openevals-scripted");
  }

  return {
    apiKey,
    endpoint: optional(env.LANGSMITH_ENDPOINT),
    project: optional(env.LANGSMITH_PROJECT),
    workspaceId: optional(env.LANGSMITH_WORKSPACE_ID),
    datasetName: optional(env.LANGSMITH_DATASET_NAME) ?? defaultDatasetName(),
    experimentPrefix: optional(env.LANGSMITH_EXPERIMENT_PREFIX) ?? defaultDatasetName(),
    maxConcurrency,
    decisionRunner,
  };
}
