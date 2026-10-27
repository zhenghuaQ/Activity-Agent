// ============================================================
// src/decision/pareto.ts — 帕累托多目标方案输出（M2）
//
// 同一候选池，按不同决策目标各取最优，产出 2-4 个互补方案：
//   balanced（均衡）/ time_saver（省时）/ budget_saver（省钱）/ experience（体验）
// 首推为 balanced，并为其生成「为何不选其它」的对比解释。
// ============================================================

import type { PlanCandidate, StructuredConstraints } from "../../spec/types.js";
import type { PlanCompletenessRequirements } from "../../spec/constraints.js";
import type {
  DecisionResult,
  PlanObjective,
  ScoreDimension,
} from "../../spec/decision.js";
import { buildPlanExplanation } from "./explanation.js";
import { getCanonicalPlanIdentity } from "./plan-identity.js";

function dimScore(c: PlanCandidate, d: ScoreDimension): number {
  return c.plan.score?.dimensions.find((x) => x.dimension === d)?.score ?? 0;
}

/** 各目标的打分函数（越大越优） */
const OBJECTIVE_SCORERS: Record<PlanObjective, (c: PlanCandidate) => number> = {
  balanced: (c) => c.plan.score?.total ?? 0,
  time_saver: (c) => dimScore(c, "transit") * 0.6 + dimScore(c, "time") * 0.4,
  budget_saver: (c) => dimScore(c, "budget"),
  experience: (c) => dimScore(c, "preference") * 0.55 + dimScore(c, "popularity") * 0.45,
};

const objectiveRepresentativeScores = new WeakMap<DecisionResult, Array<{ objective: PlanObjective; plan: PlanCandidate; score: number }>>();

/** Read the exact production scorer values for representatives from a completed runDecision call. */
export function getObjectiveRepresentativeScores(result: DecisionResult) {
  return (objectiveRepresentativeScores.get(result) ?? []).map(item => ({ ...item }));
}

/** Sort higher business scores first; exact ties use a non-semantic stable key. */
export function compareScoredPlans(
  a: PlanCandidate,
  b: PlanCandidate,
  scoreSelector: (candidate: PlanCandidate) => number,
): number {
  const scoreA = scoreSelector(a);
  const scoreB = scoreSelector(b);
  if (scoreA > scoreB) return -1;
  if (scoreA < scoreB) return 1;

  const identityA = getCanonicalPlanIdentity(a.plan);
  const identityB = getCanonicalPlanIdentity(b.plan);
  if (identityA < identityB) return -1;
  if (identityA > identityB) return 1;
  return 0;
}

function pickBest(
  cands: PlanCandidate[],
  scorer: (c: PlanCandidate) => number
): PlanCandidate | null {
  if (cands.length === 0) return null;
  return [...cands].sort((a, b) => compareScoredPlans(a, b, scorer))[0] ?? null;
}

/**
 * 从已评分的候选生成帕累托方案集。
 * 要求每个候选的 plan.score 已由 scorePlan 填好。
 */
export function buildPareto(
  scored: PlanCandidate[],
  notes: string[] = [],
  constraints?: StructuredConstraints,
  completenessRequirements?: PlanCompletenessRequirements,
): DecisionResult | null {
  if (scored.length === 0) return null;

  // 目标优先级：balanced 必在，其余去重补充
  const order: PlanObjective[] = ["balanced", "experience", "time_saver", "budget_saver"];
  const chosen: PlanCandidate[] = [];
  const seen = new Set<string>();
  const actualRepresentatives: Array<{ objective: PlanObjective; plan: PlanCandidate; score: number }> = [];

  for (const obj of order) {
    const winner = pickBest(scored, OBJECTIVE_SCORERS[obj]);
    if (!winner) continue;
    actualRepresentatives.push({ objective: obj, plan: winner, score: OBJECTIVE_SCORERS[obj](winner) });
    const canonicalIdentity = getCanonicalPlanIdentity(winner.plan);
    if (seen.has(canonicalIdentity)) continue;
    seen.add(canonicalIdentity);
    winner.objective = obj;
    if (constraints) winner.plan.explanation = buildPlanExplanation(winner.plan, constraints, completenessRequirements);
    chosen.push(winner);
  }

  const recommended = chosen[0];

  const result: DecisionResult = {
    recommended,
    pareto: chosen,
    confidence: recommended.plan.score?.confidence ?? 0.5,
    notes,
  };
  objectiveRepresentativeScores.set(result, actualRepresentatives);
  return result;
}
