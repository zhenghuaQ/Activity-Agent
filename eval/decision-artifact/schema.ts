import type { DecisionOutcome } from "../decision/outcome.js";
import type { JudgeDecisionContext, JudgeReferenceContext } from "../judge/context.js";
import type { DecisionTrace } from "../../spec/decision-trace.js";

export const DECISION_ARTIFACT_SCHEMA_VERSION = "decision-evaluation-artifact-v1.0" as const;

export interface DecisionEvaluationArtifactScenario {
  scenarioId: string;
  scenarioHash: string;
  reference: JudgeReferenceContext;
  conversation: {
    userTurns: string[];
    assistantMessages: string[];
  };
  decision: JudgeDecisionContext;
  /** Optional eval-safe internal provenance; older v1.0 artifacts omit it. */
  decisionTrace?: DecisionTrace;
  deterministic: {
    outcome: DecisionOutcome;
    taskSuccess: boolean;
    runtimeCompleted: boolean;
    planGenerated: boolean;
    hardConstraintResult: { checks: number; violations: number; passed: boolean };
    adaptationResult: { checks: number; errors: number; passed: boolean };
    /** Backward-compatible alias; from evaluator v1.0 onward this is recommendation-scoped. */
    preferenceResult: { checks: number; matches: number; passed: boolean };
    recommendationPreferenceResult?: {
      applicable: boolean;
      satisfied: number;
      total: number;
      coverage: number | null;
      details: Array<{ preference: string; satisfied: boolean }>;
      notApplicableReason?: string;
    };
  };
}

export interface DecisionEvaluationArtifact {
  schemaVersion: typeof DECISION_ARTIFACT_SCHEMA_VERSION;
  benchmarkVersion: string;
  evaluatorVersion?: typeof import("../decision/evaluator-version.js").DECISION_EVALUATOR_VERSION;
  provenance: {
    artifactId: string;
    gitCommit?: string;
    gitDirty: boolean;
    createdAt: string;
    runner: "openevals-scripted";
    nodeVersion: string;
    variantLabel?: string;
  };
  scenarios: DecisionEvaluationArtifactScenario[];
}
