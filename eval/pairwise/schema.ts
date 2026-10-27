import type { DecisionEvaluationArtifact } from "../decision-artifact/schema.js";

export const PAIRWISE_JUDGE_VERSION = "decision-pairwise-v1.0" as const;
export type PairwisePreference = "A" | "B" | "TIE";
export type PairwiseComparisonStatus =
  | "deterministic_winner"
  | "semantic_winner"
  | "tie"
  | "position_inconsistent"
  | "judge_unstable"
  | "not_comparable"
  | "judge_failure";
export type ArtifactWinner = "artifact_a" | "artifact_b" | "tie" | null;

export interface PairwiseJudgeResult {
  preference: PairwisePreference;
  comment: string;
}

export interface PairwiseOrientationResult {
  orientation: "original" | "swapped";
  preferences: PairwisePreference[];
  comments: string[];
  normalizedWinners: Array<"artifact_a" | "artifact_b" | "tie">;
  stable: boolean;
}

export interface PairwiseScenarioResult {
  scenarioId: string;
  comparisonSource: "deterministic" | "semantic" | null;
  status: PairwiseComparisonStatus;
  winner: ArtifactWinner;
  deterministicReason?: string;
  orientations?: PairwiseOrientationResult[];
  comment?: string;
}

export interface PairwiseSummary {
  scenariosCompared: number;
  deterministicDecisions: number;
  semanticJudgeDecisions: number;
  aWins: number;
  bWins: number;
  ties: number;
  positionInconsistent: number;
  judgeUnstable: number;
  judgeFailures: number;
  notComparable: number;
  judgeCalls: number;
}

export interface PairwiseArtifact {
  schemaVersion: "decision-pairwise-result-v1.0";
  benchmarkVersion: string;
  pairwiseJudgeVersion: typeof PAIRWISE_JUDGE_VERSION;
  judgeModel: string;
  createdAt: string;
  artifactA: DecisionEvaluationArtifact["provenance"];
  artifactB: DecisionEvaluationArtifact["provenance"];
  scenarios: PairwiseScenarioResult[];
  summary: PairwiseSummary;
}
