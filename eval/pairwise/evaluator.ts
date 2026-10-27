import { createLLMAsJudge } from "openevals";
import type { JudgeDecisionContext, JudgeReferenceContext } from "../judge/context.js";
import type { DecisionEvaluationArtifactScenario } from "../decision-artifact/schema.js";
import { PAIRWISE_OUTPUT_SCHEMA, PAIRWISE_RUBRIC, PAIRWISE_SYSTEM_PROMPT } from "./prompts.js";
import type { PairwiseJudgeResult, PairwisePreference } from "./schema.js";

export interface PairwiseJudgeFactoryConfig {
  model: string;
  system: string;
  prompt: string;
  outputSchema: typeof PAIRWISE_OUTPUT_SCHEMA;
}

export interface PairwiseCandidateContext {
  assistantMessages: string[];
  finalConstraints?: JudgeDecisionContext["finalConstraints"];
  planningTermination?: JudgeDecisionContext["planningTermination"];
  selectedPlan?: JudgeDecisionContext["selectedPlan"];
  decisionExplanation?: string;
  finalResponse?: string;
}

export type PairwiseJudgeFactory = (config: PairwiseJudgeFactoryConfig) => (input: {
  userTurns: string[];
  reference: Omit<JudgeReferenceContext, "userGoal">;
  candidateA: PairwiseCandidateContext;
  candidateB: PairwiseCandidateContext;
}) => Promise<unknown>;

export const openEvalsPairwiseJudgeFactory: PairwiseJudgeFactory = config => {
  const judge = createLLMAsJudge({
    model: config.model,
    system: config.system,
    prompt: config.prompt,
    feedbackKey: "pairwise_preference",
    useReasoning: false,
    outputSchema: config.outputSchema,
  });
  return async input => judge({
    inputs: { user_turns: input.userTurns, reference_expectations: input.reference },
    outputs: { candidate_a: input.candidateA, candidate_b: input.candidateB },
  });
};

export function buildPairwiseCandidateContext(scenario: DecisionEvaluationArtifactScenario): PairwiseCandidateContext {
  const decision = scenario.decision;
  return {
    assistantMessages: decision.userVisibleConversation.filter(message => message.role === "assistant").map(message => message.content),
    ...(decision.finalConstraints ? { finalConstraints: structuredClone(decision.finalConstraints) } : {}),
    ...(decision.planningTermination ? { planningTermination: structuredClone(decision.planningTermination) } : {}),
    ...(decision.selectedPlan ? { selectedPlan: structuredClone(decision.selectedPlan) } : {}),
    ...(decision.decisionExplanation ? { decisionExplanation: decision.decisionExplanation } : {}),
    ...(decision.finalResponse ? { finalResponse: decision.finalResponse } : {}),
  };
}

export function parsePairwiseJudgeResult(value: unknown): PairwiseJudgeResult {
  let candidate = value;
  if (typeof value === "object" && value !== null && "value" in value) {
    candidate = (value as { value: unknown }).value;
  }
  if (typeof candidate !== "object" || candidate === null) throw new Error("pairwise_output_not_object");
  const result = candidate as Record<string, unknown>;
  if (result.preference !== "A" && result.preference !== "B" && result.preference !== "TIE") {
    throw new Error("pairwise_preference_invalid");
  }
  if (typeof result.comment !== "string" || !result.comment.trim()) throw new Error("pairwise_comment_missing");
  return { preference: result.preference as PairwisePreference, comment: result.comment.trim() };
}

export async function comparePairwiseCandidates(input: {
  userTurns: string[];
  reference: JudgeReferenceContext;
  candidateA: PairwiseCandidateContext;
  candidateB: PairwiseCandidateContext;
  model: string;
  factory?: PairwiseJudgeFactory;
  onCall?: () => void;
}): Promise<PairwiseJudgeResult> {
  const judge = (input.factory ?? openEvalsPairwiseJudgeFactory)({
    model: input.model,
    system: PAIRWISE_SYSTEM_PROMPT,
    prompt: PAIRWISE_RUBRIC,
    outputSchema: PAIRWISE_OUTPUT_SCHEMA,
  });
  const pending = judge({
    userTurns: structuredClone(input.userTurns),
    reference: blindReference(input.reference),
    candidateA: blindCandidate(input.candidateA),
    candidateB: blindCandidate(input.candidateB),
  });
  input.onCall?.();
  return parsePairwiseJudgeResult(await pending);
}

function blindReference(context: JudgeReferenceContext): Omit<JudgeReferenceContext, "userGoal"> {
  const { userGoal: _userGoal, ...reference } = context;
  return structuredClone(reference);
}

function blindCandidate(context: PairwiseCandidateContext): PairwiseCandidateContext {
  return {
    assistantMessages: [...context.assistantMessages],
    ...(context.finalConstraints ? { finalConstraints: structuredClone(context.finalConstraints) } : {}),
    ...(context.planningTermination ? { planningTermination: structuredClone(context.planningTermination) } : {}),
    ...(context.selectedPlan ? { selectedPlan: structuredClone(context.selectedPlan) } : {}),
    ...(context.decisionExplanation ? { decisionExplanation: context.decisionExplanation } : {}),
    ...(context.finalResponse ? { finalResponse: context.finalResponse } : {}),
  };
}
