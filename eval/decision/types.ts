export type {
  ConstraintExpectationProjection,
  DecisionAdaptationExpectation,
  DecisionExpectations,
  DecisionHardConstraintExpectation,
  DecisionPreferenceExpectation,
  DecisionScenario,
  DecisionScenarioDataFixture,
  DecisionScenarioEnvironment,
  DecisionTurn,
  PreservedConstraint,
} from "./scenarios/schema.js";
import type { StructuredConstraints } from "../../spec/types.js";
import type { PlanningTermination } from "../../spec/types.js";

export interface ConversationEvalResult {
  caseName: string;
  scenarioId: string;
  tags: string[];
  memoryEnabled: boolean;
  /** Scenario-level decision objective completion, not plan generation. */
  taskSuccess: boolean;
  outcome: import("./outcome.js").DecisionOutcome;
  planningTermination?: PlanningTermination;
  /** Runtime completed its decision flow without an unexpected execution failure. */
  runtimeCompleted: boolean;
  /** Whether a selected final plan was produced. */
  planGenerated: boolean;
  memoryChecks: number;
  memoryErrors: number;
  hardConstraintChecks: number;
  hardConstraintViolations: number;
  preferenceChecks: number;
  preferenceMatches: number;
  preferenceApplicable: boolean;
  preferenceCoverage: number | null;
  preferenceDetails: Array<{ preference: string; satisfied: boolean }>;
  preferenceNotApplicableReason?: "no_preferences" | "no_feasible_plan" | "runtime_failure" | "missed_feasible_plan" | "no_recommendation";
  evaluatorVersion: typeof import("./evaluator-version.js").DECISION_EVALUATOR_VERSION;
  adaptationChecks: number;
  adaptationErrors: number;
  durationMs: number;
  toolCalls: number;
  turns: number;
  errors: string[];
  finalConstraints?: StructuredConstraints;
  candidateIds: string[];
  hardConstraintsPassed: boolean;
}
