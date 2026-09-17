// ============================================================
// src/planner/activity-planner.ts — Activity Domain Planner
//
// Domain layer only：
// - 接收已经创建好的 AgentState
// - 生成 Activity Runtime Plan
// - 绑定 Activity 五阶段 Step Handler
// - 执行 Evaluate / Re-plan
// - 不负责 Submission / Session / Channel 生命周期
//
// Runtime 层通过 ActivityPlanner.run() 调用本模块。
// ============================================================

import {
  inboundUserInput,
  outboundDecision,
  type AgentState,
  type AgentRunStatus,
} from "../../spec/agent.js";
import type {
  PlanningState,
  StructuredConstraints,
} from "../../spec/types.js";
import {
  applyProfileToConstraints,
  resolveWeights,
  inferSegment,
  createProfile,
} from "../profile/index.js";
import { ToolExecutor } from "../runtime/tool-executor.js";
import { createActivityRuntimePlan, type RuntimePlanStep } from "../runtime/plan.js";
import { executePlan } from "../runtime/executor.js";
import { evaluateAgentState } from "../runtime/evaluator.js";
import { applyReplanPatch, decideReplan } from "../runtime/replanner.js";
import { appendTraceEvent } from "../runtime/trace.js";
import { throwIfAborted } from "../runtime/abort.js";
import { constraintEngine } from "../constraints/engine.js";
import { childLogger } from "../core/logger.js";
import {
  stage1_parseIntent,
  stage2_followUp,
  stage3_generateCandidates,
  stage4_feasibilityCheck,
  stage5_selectBest,
} from "./stages.js";
import type { PipelineOptions, PlanResult } from "./engine.js";

const log = childLogger("activity-planner");

export interface ActivityPlannerOptions {
  maxReplans?: number;
}

function applyPersonalization(
  state: PlanningState,
  opts: PipelineOptions,
): Partial<import("../../spec/decision.js").ScoringWeights> | undefined {
  if (opts.profile) {
    state.constraints = applyProfileToConstraints(state.constraints!, opts.profile);
    return resolveWeights(opts.profile);
  }
  if (opts.autoSegment) {
    const segment = inferSegment(state.constraints!);
    log.info({ segment }, "自动分层");
    return resolveWeights(createProfile({ id: "_auto", segment }));
  }
  return undefined;
}

function stepData(
  step: RuntimePlanStep,
  current: AgentState,
): Record<string, unknown> | undefined {
  const planning = current.planning;
  switch (step.type) {
    case "intent_parsing":
      return {
        scenario: planning.constraints?.group.scenario,
        leadRole: planning.constraints?.group.leadRole,
        people: planning.constraints?.group.totalPeople,
      };
    case "follow_up_questions":
      return { followUps: planning.followUpQuestions?.length ?? 0 };
    case "candidate_generation":
      return { candidates: planning.candidates?.length ?? 0 };
    case "feasibility_check":
      return { feasible: planning.candidates?.length ?? 0 };
    case "fine_scheduling":
      return {
        selected: !!planning.selectedPlan,
        objectives: planning.decision?.pareto.map((c) => c.objective) ?? [],
        confidence: planning.decision?.confidence,
      };
  }
}

function finishRun(
  agentState: AgentState,
  status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled">,
  message: string,
  data?: unknown,
  metadata: Record<string, unknown> = {},
): PlanResult {
  const success = status === "completed";
  agentState.status = status;
  agentState.result = {
    success,
    message,
    ...(data !== undefined ? { data } : {}),
  };

  if (!agentState.messages.some((item) =>
    item.runId === agentState.runId && item.kind === "decision")) {
    agentState.messages.push(outboundDecision(success, message, agentState.runId));
  }
  if (!agentState.trace.some((event) => event.type === "final")) {
    appendTraceEvent(agentState, {
      type: "final",
      metadata: { success, status, ...metadata },
    });
  }

  return {
    success,
    state: agentState.planning,
    message,
    agentState,
  };
}

/**
 * ActivityPlanner 是 Activity 领域唯一的业务编排器。
 * Runtime 负责“何时运行”；这里负责“Activity 任务如何规划”。
 */
export class ActivityPlanner {
  private readonly maxReplans: number;

  constructor(options: ActivityPlannerOptions = {}) {
    this.maxReplans = Math.max(0, options.maxReplans ?? 2);
  }

  async run(
    agentState: AgentState,
    opts: PipelineOptions = {},
  ): Promise<PlanResult> {
    const rawText = agentState.input.rawText;
    const parseFn = opts.parseFn as ((text: string) => StructuredConstraints) | undefined;
    let state: PlanningState = agentState.planning;

    agentState.status = "running";
    agentState.maxReplans ??= this.maxReplans;
    if (!agentState.messages.some((message) =>
      message.runId === agentState.runId && message.kind === "user_input")) {
      agentState.messages.push(inboundUserInput(rawText, agentState.runId));
    }

    appendTraceEvent(agentState, {
      type: "run_started",
      metadata: { inputLength: rawText.length, planner: "activity" },
    });

    try {
      let weightOverride: ReturnType<typeof applyPersonalization> = undefined;
      const plan = createActivityRuntimePlan();
      agentState.runtimePlan = plan;
      appendTraceEvent(agentState, {
        type: "plan_created",
        metadata: { planId: plan.id, steps: plan.steps.map((step) => step.id) },
      });

      const toolExecutor = new ToolExecutor(agentState, {
        timeoutMs: 10_000,
        maxRetries: 1,
        signal: opts.signal,
      });

      const handlers = {
        intent_parsing: async (current: AgentState) => {
          throwIfAborted(opts.signal);
          const planning = await stage1_parseIntent(
            current.planning,
            rawText,
            parseFn,
            opts.signal,
          );
          weightOverride = applyPersonalization(planning, opts);
          planning.searchPolicy ??= {
            radiusKm: planning.constraints!.distance.maxKm,
          };
          planning.planRevision ??= 0;
          current.planning = planning;
          agentState.planning = planning;
          return current;
        },
        follow_up_questions: async (current: AgentState) => {
          throwIfAborted(opts.signal);
          const planning = await stage2_followUp(
            current.planning,
            undefined,
            toolExecutor,
          );
          current.planning = planning;
          agentState.planning = planning;
          return current;
        },
        candidate_generation: async (current: AgentState) => {
          throwIfAborted(opts.signal);
          const planning = await stage3_generateCandidates(
            current.planning,
            toolExecutor,
          );
          current.planning = planning;
          agentState.planning = planning;
          return current;
        },
        feasibility_check: async (current: AgentState) => {
          throwIfAborted(opts.signal);
          const planning = await stage4_feasibilityCheck(current.planning, toolExecutor);
          const constraintEvaluations = (planning.candidates ?? []).map((candidate) =>
            constraintEngine.evaluatePlan(candidate.plan, planning.constraints!),
          );
          current.planning = planning;
          current.constraintEvaluations = constraintEvaluations;
          agentState.planning = planning;
          agentState.constraintEvaluations = constraintEvaluations;
          return current;
        },
        fine_scheduling: async (current: AgentState) => {
          throwIfAborted(opts.signal);
          const planning = await stage5_selectBest(current.planning, {
            weightOverride,
            weather: opts.weather,
            date: opts.date,
          });
          current.planning = planning;
          agentState.planning = planning;
          return current;
        },
      };

      let executedState = await executePlan(plan, agentState, {
        handlers,
        onStep: async (step, current) => {
          const index = plan.steps.findIndex((item) => item.id === step.id) + 1;
          const data = stepData(step, current);
          appendTraceEvent(agentState, {
            type: "stage_update",
            stepId: step.id,
            metadata: {
              stage: step.type,
              index,
              total: plan.steps.length,
              data,
            },
          });
        },
      });

      agentState.status = executedState.status;
      agentState.currentStep = executedState.currentStep;
      agentState.planning = executedState.planning;
      state = executedState.planning;

      for (let attempt = 0; attempt < (agentState.maxReplans ?? 0); attempt += 1) {
        throwIfAborted(opts.signal);
        const evaluation = evaluateAgentState(agentState);
        agentState.constraintEvaluations = evaluation.evaluation ? [evaluation.evaluation] : [];
        appendTraceEvent(agentState, {
          type: "evaluation",
          metadata: {
            passed: evaluation.passed,
            failureRules: evaluation.failures.map((failure) => failure.rule),
          },
        });

        if (evaluation.passed) break;

        const decision = decideReplan(agentState, evaluation.failures);
        if (!decision.shouldReplan || !decision.nextPlan) break;

        agentState.replanCount = (agentState.replanCount ?? 0) + 1;
        appendTraceEvent(agentState, {
          type: "replan",
          metadata: {
            count: agentState.replanCount,
            reason: decision.reason,
            strategy: decision.strategy,
          },
        });

        const replannedState = applyReplanPatch(agentState, decision.patch);
        replannedState.runtimePlan = decision.nextPlan;
        replannedState.status = "running";

        executedState = await executePlan(decision.nextPlan, replannedState, {
          handlers,
          onStep: async (step, current) => {
            const index = decision.nextPlan!.steps.findIndex((item) => item.id === step.id) + 1;
            const data = stepData(step, current);
            appendTraceEvent(agentState, {
              type: "stage_update",
              stepId: step.id,
              metadata: {
                stage: step.type,
                index,
                total: decision.nextPlan!.steps.length,
                data,
                replan: true,
              },
            });
          },
        });

        agentState.status = executedState.status;
        agentState.currentStep = executedState.currentStep;
        agentState.planning = executedState.planning;
        state = executedState.planning;
      }

      const finalEvaluation = evaluateAgentState(agentState);
      agentState.constraintEvaluations = finalEvaluation.evaluation ? [finalEvaluation.evaluation] : [];

      if (state.selectedPlan && finalEvaluation.passed) {
        const message = agentState.replanCount
          ? `方案规划完成（已重规划 ${agentState.replanCount} 次）`
          : "方案规划完成";
        return finishRun(
          agentState,
          "completed",
          message,
          state.decision,
          { replanCount: agentState.replanCount ?? 0 },
        );
      }

      const message = "未能生成满足运行约束的可行方案";
      return finishRun(agentState, "failed", message, state.decision, {
        reason: message,
      });
    } catch (err) {
      const cancelled = opts.signal?.aborted === true;
      const message = cancelled
        ? `运行已取消: ${opts.signal?.reason instanceof Error ? opts.signal.reason.message : String(opts.signal?.reason ?? "user_cancelled")}`
        : `规划异常: ${err instanceof Error ? err.message : String(err)}`;
      agentState.errors.push(message);
      appendTraceEvent(agentState, { type: "error", metadata: { message } });
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "Activity Planner 执行异常",
      );
      return finishRun(
        agentState,
        cancelled ? "cancelled" : "failed",
        message,
        undefined,
        { error: true },
      );
    }
  }
}

export const defaultActivityPlanner = new ActivityPlanner();
