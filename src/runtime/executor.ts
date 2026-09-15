// ============================================================
// src/runtime/executor.ts — 通用 Runtime Plan Executor
// ============================================================

import type { AgentState } from "../../spec/agent.js";
import type { RuntimePlan, RuntimePlanStep } from "./plan.js";
import { assertValidRuntimePlan, getReadySteps } from "./plan.js";
import { appendTraceEvent } from "./trace.js";

export type RuntimeStepHandler = (
  state: AgentState,
  step: RuntimePlanStep
) => Promise<AgentState>;

export interface ExecutePlanOptions {
  handlers: Record<RuntimePlanStep["type"], RuntimeStepHandler>;
  onStep?: (step: RuntimePlanStep, state: AgentState) => void | Promise<void>;
}

/**
 * 只负责执行 Plan，不决定 Plan。
 * Planner 决定“做什么”，Executor 负责“按依赖把它做掉”。
 *
 * 当前阶段仍然一次执行一个 Ready Step；真正并发时只需要把
 * Ready Set 分批交给受限并发调度器，不需要重写 Plan 模型。
 */
export async function executePlan(
  plan: RuntimePlan,
  initialState: AgentState,
  options: ExecutePlanOptions
): Promise<AgentState> {
  assertValidRuntimePlan(plan);

  let state = initialState;
  const completedStepIds = new Set<string>();

  while (completedStepIds.size < plan.steps.length) {
    const readySteps = getReadySteps(plan, completedStepIds);
    const step = readySteps[0];

    if (!step) {
      throw new Error("Runtime Plan 无可执行 Step：可能存在未满足的依赖或执行状态不一致");
    }

    appendTraceEvent(state, {
      type: "step_started",
      stepId: step.id,
      metadata: { stepType: step.type },
    });

    const startedAt = Date.now();
    const handler = options.handlers[step.type];
    if (!handler) {
      throw new Error(`未注册 Runtime Step Handler: ${step.type}`);
    }

    state = await handler(state, step);
    state.currentStep = step.id;
    completedStepIds.add(step.id);

    appendTraceEvent(state, {
      type: "step_finished",
      stepId: step.id,
      durationMs: Date.now() - startedAt,
      metadata: { stepType: step.type, status: state.status },
    });

    if (options.onStep) {
      await options.onStep(step, state);
    }

    // waiting_input / failed / cancelled 是运行态，不应该继续盲目执行后续步骤。
    if (state.status === "waiting_input" || state.status === "failed" || state.status === "cancelled") {
      break;
    }
  }

  return state;
}
