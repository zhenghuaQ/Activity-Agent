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
  inboundFollowUpAnswer,
  outboundFollowUpQuestion,
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
import { throwIfAborted } from "../runtime/abort.js";
import { AgentRun } from "../runtime/agent-run.js";
import { constraintEngine } from "../constraints/engine.js";
import {
  stage1_parseIntent,
  stage2_followUp,
  stage3_generateCandidates,
  stage4_feasibilityCheck,
  stage5_selectBest,
} from "./stages.js";
import type { PipelineOptions, PlanResult } from "./engine.js";
import { interpretFollowUpAnswers } from "./follow-up.js";
import { mergeTurnConstraints } from "../conversation/memory.js";

export interface ActivityPlannerOptions {
  maxReplans?: number;
}

function applyPersonalization(
  state: PlanningState,
  opts: PipelineOptions,
  run: AgentRun,
): Partial<import("../../spec/decision.js").ScoringWeights> | undefined {
  if (opts.profile) {
    state.constraints = applyProfileToConstraints(state.constraints!, opts.profile);
    run.emit({
      type: "profile_resolved",
      payload: {
        source: "explicit",
        profileId: opts.profile.id,
        segment: opts.profile.segment,
      },
    });
    return resolveWeights(opts.profile);
  }
  if (opts.autoSegment) {
    const segment = inferSegment(state.constraints!);
    run.emit({
      type: "profile_resolved",
      payload: { source: "inferred", segment },
    });
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
        constraints: planning.constraints ? structuredClone(planning.constraints) : undefined,
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
  run: AgentRun,
  status: Extract<AgentRunStatus, "completed" | "failed" | "cancelled">,
  message: string,
  data?: unknown,
  metadata: Record<string, unknown> = {},
): PlanResult {
  const agentState = run.state;
  const success = status === "completed";
  const result = {
    success,
    message,
    ...(data !== undefined ? { data } : {}),
  };

  if (!agentState.messages.some((item) =>
    item.runId === agentState.runId && item.kind === "decision")) {
    agentState.messages.push(outboundDecision(success, message, agentState.runId));
  }
  run.finish(
    status,
    result,
    { reason: "planner_finished", source: "planner", details: { success } },
    metadata,
  );

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
    runOrState: AgentRun | AgentState,
    opts: PipelineOptions = {},
  ): Promise<PlanResult> {
    const run = runOrState instanceof AgentRun
      ? runOrState
      : AgentRun.fromState(runOrState);
    const agentState = run.state;
    const rawText = agentState.input.rawText;
    const parseFn = opts.parseFn as ((text: string) => StructuredConstraints) | undefined;
    let state: PlanningState = agentState.planning;

    run.transition("running", {
      reason: "planner_started",
      source: "planner",
    });
    agentState.maxReplans ??= this.maxReplans;
    if (!agentState.messages.some((message) =>
      message.runId === agentState.runId && message.kind === "user_input")) {
      agentState.messages.push(inboundUserInput(rawText, agentState.runId));
    }

    try {
      let weightOverride: ReturnType<typeof applyPersonalization> = undefined;
      const plan = createActivityRuntimePlan();
      agentState.runtimePlan = plan;
      run.emit({
        type: "plan_created",
        payload: { planId: plan.id, steps: plan.steps.map((step) => step.id) },
      });

      const toolExecutor = new ToolExecutor(run, {
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
          planning.constraints = mergeTurnConstraints(opts.baseConstraints, planning.constraints!, rawText);
          weightOverride = applyPersonalization(planning, opts, run);
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
          let planning = await stage2_followUp(
            current.planning,
            undefined,
            toolExecutor,
          );
          current.planning = planning;
          const questions = planning.followUpQuestions ?? [];
          if (questions.length && opts.requestFollowUp && planning.constraints) {
            current.messages.push(outboundFollowUpQuestion(questions, current.runId));
            const selections = await opts.requestFollowUp(questions);
            throwIfAborted(opts.signal);
            const answers = interpretFollowUpAnswers(planning.constraints, questions, selections);
            current.messages.push(inboundFollowUpAnswer(answers, current.runId));
            planning = await stage2_followUp(planning, answers, toolExecutor);
          }
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

      let executedState = await executePlan(plan, run, {
        handlers,
        onStep: async (step, current) => {
          const index = plan.steps.findIndex((item) => item.id === step.id) + 1;
          const data = stepData(step, current);
          run.emit({
            type: "stage_update",
            stepId: step.id,
            payload: {
              stage: step.type,
              index,
              total: plan.steps.length,
              data,
            },
          });
        },
      });

      run.transition(executedState.status, {
        reason: "plan_execution_status",
        source: "planner",
      });
      agentState.currentStep = executedState.currentStep;
      agentState.planning = executedState.planning;
      state = executedState.planning;

      for (let attempt = 0; attempt < (agentState.maxReplans ?? 0); attempt += 1) {
        throwIfAborted(opts.signal);
        const evaluation = evaluateAgentState(agentState);
        agentState.constraintEvaluations = evaluation.evaluation ? [evaluation.evaluation] : [];
        run.emit({
          type: "evaluation",
          payload: {
            passed: evaluation.passed,
            failureRules: evaluation.failures.map((failure) => failure.rule),
          },
        });

        if (evaluation.passed) break;

        const decision = decideReplan(agentState, evaluation.failures);
        if (!decision.shouldReplan || !decision.nextPlan) break;

        agentState.replanCount = (agentState.replanCount ?? 0) + 1;
        run.emit({
          type: "replan",
          payload: {
            count: agentState.replanCount,
            reason: decision.reason,
            strategy: decision.strategy,
          },
        });

        const replannedState = applyReplanPatch(agentState, decision.patch);
        replannedState.runtimePlan = decision.nextPlan;
        run.transition("running", {
          reason: "replan_started",
          source: "planner",
        });

        executedState = await executePlan(decision.nextPlan, run, {
          handlers,
          onStep: async (step, current) => {
            const index = decision.nextPlan!.steps.findIndex((item) => item.id === step.id) + 1;
            const data = stepData(step, current);
            run.emit({
              type: "stage_update",
              stepId: step.id,
              payload: {
                stage: step.type,
                index,
                total: decision.nextPlan!.steps.length,
                data,
                replan: true,
              },
            });
          },
        });

        run.transition(executedState.status, {
          reason: "replan_execution_status",
          source: "planner",
        });
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
          run,
          "completed",
          message,
          state.decision,
          { replanCount: agentState.replanCount ?? 0 },
        );
      }

      const detail = state.errors.find(error => error.startsWith("目的地不可用")) ?? state.errors.at(-1);
      const message = detail
        ? `未能生成满足运行约束的可行方案：${detail}`
        : "未能生成满足运行约束的可行方案";
      return finishRun(run, "failed", message, state.decision, {
        reason: message,
      });
    } catch (err) {
      const cancelled = opts.signal?.aborted === true;
      const message = cancelled
        ? `运行已取消: ${opts.signal?.reason instanceof Error ? opts.signal.reason.message : String(opts.signal?.reason ?? "user_cancelled")}`
        : `规划异常: ${err instanceof Error ? err.message : String(err)}`;
      agentState.errors.push(message);
      run.emit({ type: "error", payload: { message } });
      return finishRun(
        run,
        cancelled ? "cancelled" : "failed",
        message,
        undefined,
        { error: true },
      );
    }
  }
}

export const defaultActivityPlanner = new ActivityPlanner();
