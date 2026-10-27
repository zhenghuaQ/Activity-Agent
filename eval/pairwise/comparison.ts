import type { DecisionEvaluationArtifact, DecisionEvaluationArtifactScenario } from "../decision-artifact/schema.js";
import type { PairwiseJudgeFactory } from "./evaluator.js";
import { buildPairwiseCandidateContext, comparePairwiseCandidates } from "./evaluator.js";
import type { PairwiseArtifact, PairwiseComparisonStatus, PairwiseOrientationResult, PairwisePreference, PairwiseScenarioResult, PairwiseSummary } from "./schema.js";

function clearlyValid(row: DecisionEvaluationArtifactScenario): boolean {
  return row.deterministic.runtimeCompleted && row.deterministic.taskSuccess
    && row.deterministic.hardConstraintResult.violations === 0
    && ["feasible_plan", "no_feasible_plan"].includes(row.deterministic.outcome);
}

function deterministicGate(a: DecisionEvaluationArtifactScenario, b: DecisionEvaluationArtifactScenario) {
  const ar = a.deterministic.runtimeCompleted;
  const br = b.deterministic.runtimeCompleted;
  if (ar !== br) return { winner: ar ? "artifact_a" as const : "artifact_b" as const, reason: "runtime_failure" };
  const ah = a.deterministic.hardConstraintResult.violations === 0;
  const bh = b.deterministic.hardConstraintResult.violations === 0;
  if (ah !== bh) return { winner: ah ? "artifact_a" as const : "artifact_b" as const, reason: "hard_constraint_pass" };
  const av = clearlyValid(a);
  const bv = clearlyValid(b);
  if (av !== bv) return { winner: av ? "artifact_a" as const : "artifact_b" as const, reason: "task_success_and_valid_outcome" };
  if (a.deterministic.taskSuccess !== b.deterministic.taskSuccess) {
    return { winner: a.deterministic.taskSuccess ? "artifact_a" as const : "artifact_b" as const, reason: "task_success" };
  }
  return undefined;
}

function normalize(preference: PairwisePreference, orientation: "original" | "swapped"): "artifact_a" | "artifact_b" | "tie" {
  if (preference === "TIE") return "tie";
  return orientation === "original"
    ? preference === "A" ? "artifact_a" : "artifact_b"
    : preference === "A" ? "artifact_b" : "artifact_a";
}

function aggregateOrientations(original: PairwiseOrientationResult, swapped: PairwiseOrientationResult): {
  status: PairwiseComparisonStatus;
  winner: PairwiseScenarioResult["winner"];
} {
  if (!original.stable || !swapped.stable) return { status: "judge_unstable", winner: null };
  const a = original.normalizedWinners[0];
  const b = swapped.normalizedWinners[0];
  if (a === "tie" && b === "tie") return { status: "tie", winner: "tie" };
  if (a === b && a !== "tie") return { status: "semantic_winner", winner: a };
  return { status: "position_inconsistent", winner: null };
}

async function runOrientation(input: {
  a: DecisionEvaluationArtifactScenario;
  b: DecisionEvaluationArtifactScenario;
  orientation: "original" | "swapped";
  model: string;
  repetitions: number;
  factory?: PairwiseJudgeFactory;
  beforeCall?: () => Promise<void>;
  onCall: () => void;
}): Promise<PairwiseOrientationResult> {
  const preferences: PairwisePreference[] = [];
  const comments: string[] = [];
  for (let i = 0; i < input.repetitions; i += 1) {
    await input.beforeCall?.();
    const result = await comparePairwiseCandidates({
      userTurns: input.a.conversation.userTurns,
      reference: input.a.reference,
      candidateA: buildPairwiseCandidateContext(input.a),
      candidateB: buildPairwiseCandidateContext(input.b),
      model: input.model,
      factory: input.factory,
      onCall: input.onCall,
    });
    preferences.push(result.preference);
    comments.push(result.comment);
  }
  return {
    orientation: input.orientation,
    preferences,
    comments,
    normalizedWinners: preferences.map(value => normalize(value, input.orientation)),
    stable: preferences.length > 0 && preferences.every(value => value === preferences[0]),
  };
}

export async function compareDecisionArtifacts(input: {
  artifactA: DecisionEvaluationArtifact;
  artifactB: DecisionEvaluationArtifact;
  judgeModel: string;
  runsPerOrientation: number;
  maxConcurrency: number;
  factory?: PairwiseJudgeFactory;
  beforeCall?: () => Promise<void>;
}): Promise<PairwiseArtifact> {
  const aById = new Map(input.artifactA.scenarios.map(s => [s.scenarioId, s]));
  const bById = new Map(input.artifactB.scenarios.map(s => [s.scenarioId, s]));
  let judgeCalls = 0;
  const ids = [...aById.keys()];
  const scenarios = await concurrentMap(ids, input.maxConcurrency, async scenarioId => {
    const a = aById.get(scenarioId)!;
    const b = bById.get(scenarioId)!;
    const gate = deterministicGate(a, b);
    if (gate) return {
      scenarioId, comparisonSource: "deterministic" as const, status: "deterministic_winner" as const,
      winner: gate.winner, deterministicReason: gate.reason,
    };
    if (a.deterministic.outcome === "runtime_failure" && b.deterministic.outcome === "runtime_failure") {
      return { scenarioId, comparisonSource: null, status: "not_comparable" as const, winner: null, deterministicReason: "both_runtime_failure" };
    }
    try {
      const original = await runOrientation({ a, b, orientation: "original", model: input.judgeModel, repetitions: input.runsPerOrientation, factory: input.factory, beforeCall: input.beforeCall, onCall: () => { judgeCalls += 1; } });
      const swapped = await runOrientation({ a: b, b: a, orientation: "swapped", model: input.judgeModel, repetitions: input.runsPerOrientation, factory: input.factory, beforeCall: input.beforeCall, onCall: () => { judgeCalls += 1; } });
      const aggregate = aggregateOrientations(original, swapped);
      return { scenarioId, comparisonSource: "semantic" as const, ...aggregate, orientations: [original, swapped] };
    } catch (error) {
      return { scenarioId, comparisonSource: "semantic" as const, status: "judge_failure" as const, winner: null,
        comment: error instanceof Error ? error.message : String(error) };
    }
  });
  return {
    schemaVersion: "decision-pairwise-result-v1.0",
    benchmarkVersion: input.artifactA.benchmarkVersion,
    pairwiseJudgeVersion: "decision-pairwise-v1.0",
    judgeModel: input.judgeModel,
    createdAt: new Date().toISOString(),
    artifactA: structuredClone(input.artifactA.provenance),
    artifactB: structuredClone(input.artifactB.provenance),
    scenarios,
    summary: summarizePairwise(scenarios, judgeCalls),
  };
}

async function concurrentMap<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]!);
    }
  }));
  return results;
}

export function summarizePairwise(rows: readonly PairwiseScenarioResult[], judgeCalls: number): PairwiseSummary {
  return {
    scenariosCompared: rows.length,
    deterministicDecisions: rows.filter(row => row.comparisonSource === "deterministic").length,
    semanticJudgeDecisions: rows.filter(row => row.comparisonSource === "semantic").length,
    aWins: rows.filter(row => row.winner === "artifact_a").length,
    bWins: rows.filter(row => row.winner === "artifact_b").length,
    ties: rows.filter(row => row.status === "tie").length,
    positionInconsistent: rows.filter(row => row.status === "position_inconsistent").length,
    judgeUnstable: rows.filter(row => row.status === "judge_unstable").length,
    judgeFailures: rows.filter(row => row.status === "judge_failure").length,
    notComparable: rows.filter(row => row.status === "not_comparable").length,
    judgeCalls,
  };
}

export { deterministicGate, normalize, aggregateOrientations };
