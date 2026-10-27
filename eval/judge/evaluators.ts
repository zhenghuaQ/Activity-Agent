import { createLLMAsJudge } from "openevals";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import type { DecisionScenario } from "../decision/scenarios/schema.js";
import type { ConversationEvalResult } from "../decision/types.js";
import { buildJudgeDecisionContext, buildJudgeReferenceContext } from "./context.js";
import { JUDGE_OUTPUT_SCHEMA, JUDGE_RUBRIC_VERSION, JUDGE_RUBRICS, JUDGE_SYSTEM_PROMPT } from "./prompts.js";
import { isJudgeScore, JUDGE_DIMENSIONS, type DimensionScore, type JudgeDimension, type JudgeScores } from "./schema.js";

export interface JudgeFactoryConfig {
  dimension: JudgeDimension;
  model: string;
  system: string;
  prompt: string;
  outputSchema: typeof JUDGE_OUTPUT_SCHEMA;
}

export type JudgeFactory = (config: JudgeFactoryConfig) => (input: {
  scenarioId: string;
  conversation: ReturnType<typeof buildJudgeDecisionContext>;
  reference: ReturnType<typeof buildJudgeReferenceContext>;
}) => Promise<unknown>;

export const openEvalsJudgeFactory: JudgeFactory = config => {
  const evaluator = createLLMAsJudge({
    model: config.model,
    system: config.system,
    prompt: config.prompt,
    feedbackKey: config.dimension,
    choices: [1, 2, 3, 4, 5],
    useReasoning: false,
    outputSchema: config.outputSchema,
  });
  return async input => evaluator({
    inputs: { scenarioId: input.scenarioId },
    outputs: {
      conversation: input.conversation,
      reference_expectations: input.reference,
    },
  });
};

export class InvalidJudgeOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJudgeOutputError";
  }
}

export function parseDimensionScore(value: unknown): DimensionScore {
  let candidate: unknown = value;
  if (typeof value === "object" && value !== null && "score" in value) candidate = value;
  else if (typeof value === "object" && value !== null && "value" in value) candidate = (value as { value: unknown }).value;
  if (typeof candidate === "number") throw new InvalidJudgeOutputError("judge_schema_output_missing_comment");
  if (typeof candidate !== "object" || candidate === null) throw new InvalidJudgeOutputError("judge_output_not_object");
  const record = candidate as Record<string, unknown>;
  if (!isJudgeScore(record.score)) throw new InvalidJudgeOutputError("judge_score_out_of_range_or_invalid");
  if (typeof record.comment !== "string" || record.comment.trim().length === 0) {
    throw new InvalidJudgeOutputError("judge_comment_missing");
  }
  return { score: record.score, comment: record.comment.trim() };
}

export interface JudgeExecutionResult {
  scores?: JudgeScores;
  calls: number;
  errors: string[];
}

export async function evaluateDecisionSemantics(input: {
  scenario: DecisionScenario;
  execution: DecisionScenarioRunOutput;
  deterministic: ConversationEvalResult;
  model: string;
  factory?: JudgeFactory;
  beforeCall?: (dimension: JudgeDimension) => Promise<void>;
  onCall?: () => void;
}): Promise<JudgeExecutionResult> {
  if (input.deterministic.outcome === "runtime_failure") {
    return { calls: 0, errors: [] };
  }
  if (!isValidExecutionArtifact(input.execution)) return { calls: 0, errors: ["invalid_execution_artifact"] };
  const factory = input.factory ?? openEvalsJudgeFactory;
  const conversation = buildJudgeDecisionContext(input.execution);
  const reference = buildJudgeReferenceContext(input.scenario);
  const scores = {} as Partial<JudgeScores>;
  const errors: string[] = [];
  const invocationCount = { value: 0 };
  for (const dimension of JUDGE_DIMENSIONS) {
    try {
      await input.beforeCall?.(dimension);
      const judge = factory({
        dimension,
        model: input.model,
        system: JUDGE_SYSTEM_PROMPT,
        prompt: JUDGE_RUBRICS[dimension],
        outputSchema: JUDGE_OUTPUT_SCHEMA,
      });
      const raw = await judge({ scenarioId: input.scenario.id, conversation, reference });
      invocationCount.value += 1;
      input.onCall?.();
      scores[dimension] = parseDimensionScore(raw);
    } catch (error) {
      errors.push(`${dimension}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    ...(Object.keys(scores).length === JUDGE_DIMENSIONS.length ? { scores: scores as JudgeScores } : {}),
    calls: invocationCount.value,
    errors,
  };
}

function isValidExecutionArtifact(execution: DecisionScenarioRunOutput): boolean {
  if (!Array.isArray(execution.turnSnapshots) || execution.turnSnapshots.length === 0) return false;
  return execution.turnSnapshots.every(snapshot =>
    typeof snapshot.userInput === "string"
    && (snapshot.userVisibleMessage === undefined || typeof snapshot.userVisibleMessage === "string"),
  );
}

export function dimensionForKey(key: string): JudgeDimension | undefined {
  return JUDGE_DIMENSIONS.find(dimension => dimension === key);
}

export { JUDGE_RUBRIC_VERSION };
