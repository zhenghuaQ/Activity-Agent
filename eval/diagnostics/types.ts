import type { StructuredConstraints } from "../../spec/types.js";
import type { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";

export interface DiagnosticCandidate {
  id: string;
  type: string;
  name: string;
  city: string;
  distanceKm: number;
  rating: number;
  cuisine?: string;
  dietaryOptions?: boolean;
  tags: string[];
  localFeatures: string[];
}

export interface SearchObservation {
  categories: string[];
  radiusKm: number;
  requiredTags: string[];
  preferredTags: string[];
  cuisineFilter: string[];
  dietaryRequirements: string[];
  returnedIds: string[];
  candidates: DiagnosticCandidate[];
}

export interface DiagnosticRun {
  label: string;
  userTurns: string[];
  runtimeStatus?: string;
  submissionStatus?: string;
  runtimeCompleted: boolean;
  businessMessage?: string;
  constraints?: StructuredConstraints;
  hardMaxDurationMinutes?: number;
  searches: SearchObservation[];
  turnSearches: SearchObservation[][];
  turnSnapshots: Array<{
    constraints?: StructuredConstraints;
    selectedPlanIds: string[];
    pareto: Array<{ id: string; score?: number; objective?: string }>;
    scoreDimensions?: Array<{ dimension: string; score: number; weight: number; weighted: number; reason: string }>;
  }>;
  selectedPlan?: {
    id: string;
    summary: string;
    activities: DiagnosticCandidate[];
    totalTransitMinutes: number;
    totalDurationHours: number;
    score?: {
      total: number;
      confidence: number;
      dimensions: Array<{ dimension: string; score: number; weight: number; weighted: number; reason: string }>;
    };
  };
  pareto: Array<{ id: string; score?: number; objective?: string }>;
  candidateIds: string[];
  planningTermination?: string;
  hardRejectedCandidates: Array<{ candidateId: string; failures: Array<{ rule: string; actualMinutes?: number; limitMinutes?: number; dietaryEvidence?: Array<{ restaurantId: string; requirement: string; status: string }> }> }>;
  runtimeErrors: string[];
  replanCount: number;
}

export interface DiagnosticProbe {
  id: string;
  category: "preference" | "hard_constraint" | "correction" | "robustness" | "replan" | "infeasibility" | "schema";
  description: string;
  runs: DiagnosticRun[];
  observation: string;
  changed: {
    searchPool: boolean;
    candidates: boolean;
    pareto: boolean;
    selectedPlan: boolean;
    score: boolean;
  };
}

export interface DecisionQualityAudit {
  schemaVersion: "decision-quality-audit-v1.0";
  benchmarkVersion: typeof DECISION_BENCHMARK_VERSION;
  generatedAt: string;
  diagnosticOnly: true;
  productionLogicModified: false;
  pipeline: Array<{ stage: string; evidence: string }>;
  influenceMatrix: Array<{
    field: string;
    parsed: string;
    remembered: string;
    search: string;
    hardFilter: string;
    ranking: string;
    pareto: string;
    explanation: string;
    classification: string;
  }>;
  scoreFeatures: Array<{
    feature: string;
    source: string;
    normalization: string;
    direction: string;
    missingValues: string;
    usedBy: string;
  }>;
  tieBreak: { policy: string; probe: DiagnosticProbe };
  probes: DiagnosticProbe[];
  audits: Record<string, unknown>;
  defects: Array<{
    id: string;
    classification: string;
    claim: string;
    codeEvidence: string[];
    runtimeEvidence: string[];
  }>;
  recommendation: { defectId: string; target: string; rationale: string };
}
