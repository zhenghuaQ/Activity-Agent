import type { DecisionScenario } from "../decision/scenarios/schema.js";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import type { ConversationEvalResult } from "../decision/types.js";
import { evaluateDecisionSemantics, type JudgeFactory } from "./evaluators.js";
import type { JudgeDimension } from "./schema.js";

/** Optional experiment-only bridge. It is never enabled by default and is not part of dataset sync. */
export function createLangSmithJudgeEvaluator(input: {
  scenario: DecisionScenario;
  model: string;
  dimension: JudgeDimension;
  factory?: JudgeFactory;
}) {
  return async (params: {
    outputs: {
      execution: DecisionScenarioRunOutput;
      deterministic: ConversationEvalResult;
    };
  }) => {
    const result = await evaluateDecisionSemantics({
      scenario: input.scenario,
      execution: params.outputs.execution,
      deterministic: params.outputs.deterministic,
      model: input.model,
      factory: input.factory,
    });
    if (!result.scores) {
      return { key: input.dimension, score: false, comment: result.errors.join("; ") || "judge_skipped" };
    }
    const dimension = result.scores[input.dimension];
    return { key: input.dimension, score: dimension.score, comment: dimension.comment };
  };
}
