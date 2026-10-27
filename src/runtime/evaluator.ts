// ============================================================
// src/runtime/evaluator.ts — Agent Run 结果评估
//
// Runtime Evaluator 只回答一个问题：
//   “当前 AgentState 里的最终方案是否满足可执行要求？”
// 不修改 PlanningState，不负责生成新方案。
// ============================================================

import type { AgentState } from "../../spec/agent.js";
import type { ConstraintCheck } from "../../spec/constraints.js";
import type { Plan } from "../../spec/types.js";
import { evaluatePlanHardConstraints, type HardConstraintEvaluation } from "../constraints/engine.js";

export interface AgentEvaluation {
  passed: boolean;
  plan?: Plan;
  evaluation?: HardConstraintEvaluation;
  failures: ConstraintCheck[];
}

/**
 * 对一次 Run 的最终方案做 Runtime 层验收。
 * 这里只验收 selectedPlan，不改动领域候选过滤逻辑。
 */
export function acceptSelectedPlan(state: AgentState): AgentEvaluation {
  const { constraints, selectedPlan: plan } = state.planning;
  if (!plan || !constraints) {
    return {
      passed: false,
      plan,
      failures: [
        {
          passed: false,
          rule: "missing_final_plan",
          detail: "Run 没有产出最终方案或结构化约束",
        },
      ],
    };
  }

  // searchPolicy only broadens discovery; acceptance always uses user constraints.
  const evaluation = evaluatePlanHardConstraints(plan, constraints, state.planning.planCompletenessRequirements);

  return {
    passed: evaluation.passed,
    plan,
    evaluation,
    failures: evaluation.hardFailures,
  };
}

/** Backward-compatible name for callers that evaluate the final AgentState. */
export const evaluateAgentState = acceptSelectedPlan;
