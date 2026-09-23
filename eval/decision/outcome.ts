import type { AgentRunStatus } from "../../spec/agent.js";
import type { PlanningTermination } from "../../spec/types.js";
import type { DecisionScenario } from "./scenarios/schema.js";
import type { PlanResult } from "../../src/planner/engine.js";

export type DecisionOutcome =
  | "feasible_plan"
  | "no_feasible_plan"
  | "invalid_plan"
  | "missed_feasible_plan"
  | "runtime_failure";

export interface DecisionRuntimeEvidence {
  status: AgentRunStatus;
  finalEvent?: {
    status: AgentRunStatus;
    success: boolean;
    error?: boolean;
  };
  terminalTransitionReason?: string;
  completedSteps: string[];
  agentErrors: string[];
  toolCalls: Array<{ status: "success" | "partial" | "error" }>;
  planningTermination?: PlanningTermination;
  /** Optional presentation diagnostics; outcome classification must ignore these. */
  diagnostics?: string[];
  planGenerated: boolean;
}

const REQUIRED_PLANNING_STEPS = [
  "context_resolution",
  "intent_parsing",
  "follow_up_questions",
  "candidate_generation",
  "feasibility_check",
  "fine_scheduling",
];

export function runtimeCompletedWithoutInfrastructureFailure(
  evidence: DecisionRuntimeEvidence,
): boolean {
  if (!evidence.planningTermination || !evidence.finalEvent) return false;
  if (evidence.finalEvent.status !== evidence.status) return false;
  if (evidence.finalEvent.success !== (evidence.status === "completed")) return false;
  if (evidence.finalEvent.error || evidence.agentErrors.length > 0) return false;
  if (evidence.toolCalls.some(call => call.status === "error")) return false;

  const steps = new Set(evidence.completedSteps);
  if (!REQUIRED_PLANNING_STEPS.every(step => steps.has(step))) return false;

  if (evidence.planningTermination.reason === "plan_selected") {
    return evidence.planGenerated
      && (evidence.status === "completed"
        || (evidence.status === "failed" && evidence.terminalTransitionReason === "planner_finished"));
  }
  return !evidence.planGenerated
    && evidence.status === "failed"
    && evidence.terminalTransitionReason === "planner_finished";
}

export function runtimeEvidenceFromPlanResult(result: PlanResult | undefined): DecisionRuntimeEvidence | undefined {
  if (!result) return undefined;
  const finalEvent = result.agentState.trace
    .filter(event => event.type === "final")
    .at(-1);
  const terminalTransition = result.agentState.trace
    .filter(event => event.type === "run_status_changed" && event.payload.status === result.agentState.status)
    .at(-1);
  return {
    status: result.agentState.status,
    finalEvent: finalEvent?.type === "final"
      ? {
          status: finalEvent.payload.status,
          success: finalEvent.payload.success,
          error: finalEvent.payload.error === true,
        }
      : undefined,
    terminalTransitionReason: terminalTransition?.type === "run_status_changed"
      ? terminalTransition.payload.reason
      : undefined,
    completedSteps: result.agentState.trace
      .filter(event => event.type === "step_finished")
      .map(event => event.stepId)
      .filter((stepId): stepId is string => Boolean(stepId)),
    agentErrors: [...result.agentState.errors],
    toolCalls: result.agentState.toolCalls.map(call => ({ status: call.status })),
    planningTermination: result.state.termination,
    planGenerated: Boolean(result.state.selectedPlan),
  };
}

export function classifyDecisionOutcome(input: {
  expectedFeasibility: DecisionScenario["expectations"]["expectedFeasibility"];
  runtimeCompleted: boolean;
  planningTermination?: PlanningTermination;
  planGenerated: boolean;
  hardConstraintsPassed: boolean;
}): DecisionOutcome {
  if (!input.runtimeCompleted || !input.planningTermination) return "runtime_failure";
  if (input.planningTermination.reason === "no_feasible_plan") {
    if (input.planGenerated) return "runtime_failure";
    return input.expectedFeasibility === "infeasible"
      ? "no_feasible_plan"
      : "missed_feasible_plan";
  }
  if (!input.planGenerated) return "runtime_failure";
  return input.hardConstraintsPassed ? "feasible_plan" : "invalid_plan";
}

export function isDecisionTaskSuccess(
  expectedFeasibility: DecisionScenario["expectations"]["expectedFeasibility"],
  outcome: DecisionOutcome,
): boolean {
  return (expectedFeasibility === "feasible" && outcome === "feasible_plan")
    || (expectedFeasibility === "infeasible" && outcome === "no_feasible_plan");
}
