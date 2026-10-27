import type { EvaluatorT, EvaluationResult } from "langsmith/evaluation";
import type { Example, Run } from "langsmith/schemas";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import { evaluateDecisionScenario } from "../decision/evaluators/conversation.js";
import type { DecisionScenario } from "../decision/scenarios/schema.js";
import { scenarioFromExample } from "./schema.js";
import { DECISION_EVALUATOR_VERSION } from "../decision/evaluator-version.js";

export const LANGSMITH_DECISION_METRIC_KEYS = [
  "decision_task_success",
  "runtime_completed",
  "plan_generated",
  "hard_constraint_pass_rate",
  "adaptation_pass_rate",
  "recommendation_preference_coverage",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDecisionScenarioRunOutput(value: unknown, scenarioId: string): DecisionScenarioRunOutput {
  if (!isRecord(value) || value.scenarioId !== scenarioId || !Array.isArray(value.turnSnapshots)
    || !isRecord(value.runtime) || typeof value.runtime.completed !== "boolean"
    || typeof value.runtime.durationMs !== "number" || typeof value.runtime.toolCalls !== "number"
    || typeof value.runtime.replans !== "number" || !Array.isArray(value.runtime.errors)) {
    throw new Error("invalid_langsmith_decision_target_output");
  }
  return value as unknown as DecisionScenarioRunOutput;
}

export function evaluateLangSmithRun(input: {
  inputs: unknown;
  outputs: unknown;
  referenceOutputs: unknown;
}) {
  const scenario: DecisionScenario = scenarioFromExample(input.inputs, input.referenceOutputs);
  const output = parseDecisionScenarioRunOutput(input.outputs, scenario.id);
  return evaluateDecisionScenario(scenario, output, true);
}

type MetricKey = typeof LANGSMITH_DECISION_METRIC_KEYS[number];

interface LangSmithEvaluatorArgs {
  run: Run;
  example: Example;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  referenceOutputs?: Record<string, unknown>;
}

function evaluator(key: MetricKey, scoreFor: (result: ReturnType<typeof evaluateLangSmithRun>) => number, commentFor?: (result: ReturnType<typeof evaluateLangSmithRun>) => string): EvaluatorT {
  const evaluateOne = ({ inputs, outputs, referenceOutputs }: LangSmithEvaluatorArgs): EvaluationResult => {
    const result = evaluateLangSmithRun({ inputs, outputs, referenceOutputs });
    const score = scoreFor(result);
    const feedback: EvaluationResult = {
      key,
      score,
      evaluatorInfo: { evaluatorVersion: DECISION_EVALUATOR_VERSION },
      ...(commentFor ? { comment: commentFor(result) } : {}),
    };
    return feedback;
  };
  return evaluateOne;
}

function passRate(checks: number, errors: number): number {
  return checks === 0 ? 1 : (checks - errors) / checks;
}

export const langSmithDecisionEvaluators: EvaluatorT[] = [
  evaluator("decision_task_success", result => Number(result.taskSuccess), result => `actual_outcome=${result.outcome}`),
  evaluator("runtime_completed", result => Number(result.runtimeCompleted)),
  evaluator("plan_generated", result => Number(result.planGenerated)),
  evaluator("hard_constraint_pass_rate", result => passRate(result.hardConstraintChecks, result.hardConstraintViolations)),
  evaluator("adaptation_pass_rate", result => passRate(result.adaptationChecks, result.adaptationErrors)),
  (({ inputs, outputs, referenceOutputs }: LangSmithEvaluatorArgs): EvaluationResult | EvaluationResult[] => {
    const result = evaluateLangSmithRun({ inputs, outputs, referenceOutputs });
    if (!result.preferenceApplicable || result.preferenceCoverage === null) return [];
    return {
      key: "recommendation_preference_coverage",
      score: result.preferenceCoverage,
      comment: `satisfied=${result.preferenceMatches}/${result.preferenceChecks}; evaluatorVersion=${result.evaluatorVersion}`,
      evaluatorInfo: { evaluatorVersion: result.evaluatorVersion, scope: "selectedPlan" },
    };
  }) as EvaluatorT,
];
