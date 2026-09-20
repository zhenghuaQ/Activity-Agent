// ============================================================
// src/runtime/replanner.ts — 有边界的重新规划策略
//
// 第一版不让 LLM 自由改 Plan，而是把“失败原因”映射到
// 一个受控的重新规划策略，保证行为可解释、可测试。
// ============================================================

import type { AgentState } from "../../spec/agent.js";
import type { ConstraintCheck } from "../../spec/constraints.js";
import type { RuntimePlan } from "./plan.js";

export interface ReplanPatch {
  searchRadiusKm: number;
}

export interface ReplanDecision {
  shouldReplan: boolean;
  reason: string;
  strategy?: "expand_search_radius" | "regenerate_candidates";
  nextPlan?: RuntimePlan;
  patch?: ReplanPatch;
}

const MAX_SEARCH_RADIUS_KM = 30;
const RADIUS_FACTOR = 1.6;

/**
 * 根据确定性的失败原因决定是否以及如何重新规划。
 * 当前只允许对“距离约束”做安全的搜索半径升级。
 */
export function decideReplan(
  state: AgentState,
  failures: ConstraintCheck[]
): ReplanDecision {
  const distanceFailure = failures.find((f) => f.rule === "within_distance");
  if (distanceFailure && state.planning.constraints) {
    const current = state.planning.searchPolicy?.radiusKm
      ?? state.planning.constraints.distance.maxKm;
    const next = Math.min(MAX_SEARCH_RADIUS_KM, Math.max(current + 1, Math.round(current * RADIUS_FACTOR * 10) / 10));

    if (next > current) {
      return {
        shouldReplan: true,
        reason: distanceFailure.detail,
        strategy: "expand_search_radius",
        patch: { searchRadiusKm: next },
        nextPlan: createReplanPlan(),
      };
    }
  }

  // 其他失败暂时只做“可观察”，不擅自修改业务规则。
  return {
    shouldReplan: false,
    reason: failures.length > 0
      ? failures.map((f) => `${f.rule}: ${f.detail}`).join("; ")
      : "未发现可重规划的失败原因",
  };
}

function createReplanPlan(): RuntimePlan {
  return {
    id: "activity-replan-v1",
    steps: [
      { id: "candidate_generation", type: "candidate_generation" },
      {
        id: "feasibility_check",
        type: "feasibility_check",
        dependsOn: ["candidate_generation"],
      },
      {
        id: "fine_scheduling",
        type: "fine_scheduling",
        dependsOn: ["feasibility_check"],
      },
    ],
  };
}

export function applyReplanPatch(
  state: AgentState,
  patch?: ReplanPatch,
): AgentState {
  if (!patch) return state;

  state.constraintEvaluations = [];
  state.planning = {
    stage: "candidate_generation",
    constraints: state.planning.constraints,
    followUpQuestions: state.planning.followUpQuestions,
    planningNotes: state.planning.planningNotes,
    resolvedSearchArea: state.planning.resolvedSearchArea,
    errors: [],
    searchPolicy: { radiusKm: patch.searchRadiusKm },
    planRevision: (state.planning.planRevision ?? 0) + 1,
  };
  return state;
}
