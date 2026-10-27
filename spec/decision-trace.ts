import type { DecisionExplanationEvidence, PlanObjective, PlanScore } from "./decision.js";
import type { LocationSource } from "./location.js";
import type { PlanningTermination, ResolvedPlanSpecification, StructuredConstraints } from "./types.js";

export const DECISION_TRACE_VERSION = "decision-trace-v1" as const;

export interface DecisionTraceCheck {
  code: string;
  passed: boolean;
  actualMinutes?: number;
  limitMinutes?: number;
  dietaryEvidence?: Array<{ restaurantId: string; requirement: string; status: string }>;
}

export interface DecisionTraceCandidate {
  canonicalPlanId: string;
  runtimePlanId: string;
  placeIds: string[];
  roleComposition: Record<string, number>;
  count: number;
}

export interface DecisionTraceRevision {
  revision: number;
  candidates: DecisionTraceCandidate[];
  hardFeasibility: Array<{ canonicalPlanId: string; passed: boolean; checks: DecisionTraceCheck[]; hardFailures: DecisionTraceCheck[] }>;
  scoredPlans: Array<{ canonicalPlanId: string; runtimePlanId: string; score: PlanScore }>;
  representatives: Array<{ objective: PlanObjective; canonicalPlanId: string; objectiveScore: number }>;
}

export interface DecisionTrace {
  version: typeof DECISION_TRACE_VERSION;
  status: "not_reached" | "partial" | "complete";
  constraints?: {
    destination?: StructuredConstraints["destination"];
    group: Pick<StructuredConstraints["group"], "scenario" | "totalPeople" | "maleCount" | "femaleCount" | "ageGroup" | "leadRole"> & {
      preferences: Pick<StructuredConstraints["group"]["preferences"], "dieting" | "budget" | "dietaryRestrictions" | "preferredCuisine">;
    };
    timeWindow: StructuredConstraints["timeWindow"];
    hardMaxDurationMinutes?: number;
    distance: StructuredConstraints["distance"];
  };
  /** Additive, eval-safe plan shape projection; does not contain raw user text. */
  planStructure?: { requested: StructuredConstraints["planSpecification"]; resolved: ResolvedPlanSpecification; templateId: string };
  environment?: { locationResolved: boolean; locationSource?: LocationSource };
  revisions: DecisionTraceRevision[];
  selection: {
    recommendedCanonicalPlanId?: string | null;
    finalSelectedCanonicalPlanId?: string | null;
    fallbackUsed: boolean;
    fallbackFailureCodes?: string[];
    finalAcceptance?: { passed: boolean; checks: DecisionTraceCheck[]; failureCodes: string[] };
  };
  termination?: PlanningTermination;
  failure?: { kind: "runtime_failure" | "cancelled" };
  explanation?: { canonicalPlanId: string; evidence: DecisionExplanationEvidence[] };
}

export function createDecisionTrace(): DecisionTrace {
  return {
    version: DECISION_TRACE_VERSION,
    status: "not_reached",
    revisions: [],
    selection: { fallbackUsed: false },
  };
}
