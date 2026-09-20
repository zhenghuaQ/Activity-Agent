// ============================================================
// src/runtime/router.ts — Submission Router + Session Submission Loop
// ============================================================

import {
  newAgentId,
  type AgentRunStatus,
  type RunId,
} from "../../spec/agent.js";
import { randomUUID } from "node:crypto";
import { type PipelineOptions } from "../planner/engine.js";
import {
  defaultActivityPlanner,
  type ActivityPlanner,
} from "../planner/activity-planner.js";
import {
  createSubmission,
  type AgentInput,
  type Submission,
  type SubmissionResult,
  type SubmissionOp,
  type SessionRetention,
} from "./submission.js";
import {
  defaultSessionStore,
  type InMemorySessionStore,
} from "./session.js";
import {
  createSessionSubmissionLoop,
  type SessionSubmissionLoop,
  type SubmissionLoopLimits,
} from "./submission-loop.js";
import { AgentRun } from "./agent-run.js";
import {
  defaultAgentEventBus,
  type AgentEventBus,
} from "./event-bus.js";
import { isFollowUpQuestions, validateFollowUpAnswers, type FollowUpSelection } from "../../spec/follow-up.js";
import type { FollowUpQuestion } from "../../spec/types.js";
import { throwIfAborted } from "./abort.js";

interface ActiveRun {
  runId: RunId;
  submissionId: string;
  sessionId: string;
  readonly status: AgentRunStatus;
  controller: AbortController;
  run: AgentRun;
  pendingInput?: {
    requestId: string;
    questions: FollowUpQuestion[];
    expiresAt: number;
    resolve: (answers: FollowUpSelection[]) => void;
  };
}

export interface AgentRuntimeOptions {
  limits?: SubmissionLoopLimits & { maxConcurrentRuns?: number; maxSessionLoops?: number };
  sessionStore?: InMemorySessionStore;
  userId?: string;
  runOptions?: PipelineOptions;
  planner?: Pick<ActivityPlanner, "run">;
  eventBus?: AgentEventBus;
}

export class SubmissionRouter {
  private readonly activeRuns = new Map<RunId, ActiveRun>();
  private readonly loops = new Map<string, SessionSubmissionLoop>();
  private executing = 0;
  private rejected = 0;
  private stopped = false;

  constructor(
    private readonly options: AgentRuntimeOptions = {},
  ) {
    for (const value of Object.values(options.limits ?? {})) {
      if (!Number.isSafeInteger(value) || value! < 1) throw new Error("invalid_runtime_limit");
    }
  }

  snapshot() {
    return { activeRuns: this.executing, sessions: this.loops.size,
      queued: [...this.loops.values()].reduce((sum, loop) => sum + loop.queuedCount(), 0), rejected: this.rejected };
  }

  /**
   * Control plane 入口：turn / cancel / inspect 先进入对应 Session 的 loop。
   * health_check 属于全局操作，不需要创建 AgentRun，因此直接处理。
   */
  async dispatch(submission: Submission): Promise<SubmissionResult> {
    if (this.stopped || (!this.loops.has(submission.sessionId) && this.loops.size >= (this.options.limits?.maxSessionLoops ?? 128))) {
      this.rejected++;
      return { submissionId: submission.id, sessionId: submission.sessionId, traceId: submission.traceId,
        status: "rejected", error: this.stopped ? "runtime_stopped" : "runtime_session_capacity" };
    }
    if (submission.op.type === "health_check") {
      return {
        submissionId: submission.id,
        status: "completed",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        result: { status: "ok" },
      };
    }

    const loop = this.getLoop(submission.sessionId);
    const result = await loop.submit(submission);
    if (result.status === "rejected") this.rejected++;
    await Promise.resolve();
    if (loop.isIdle() && this.loops.get(submission.sessionId) === loop) {
      this.loops.delete(submission.sessionId);
    }
    return result;
  }

  private getLoop(sessionId: string): SessionSubmissionLoop {
    let loop = this.loops.get(sessionId);
    if (loop) return loop;

    loop = createSessionSubmissionLoop(sessionId, {
      onIdle: () => { if (this.loops.get(sessionId) === loop) this.loops.delete(sessionId); },
      executeTurn: async (submission, controller) => {
        if (controller.signal.aborted || this.executing >= (this.options.limits?.maxConcurrentRuns ?? 16)) {
          return { submissionId: submission.id, sessionId: submission.sessionId, traceId: submission.traceId,
            status: "rejected", error: controller.signal.aborted ? "submission_cancelled" : "runtime_capacity" };
        }
        this.executing++;
        try { return await this.executeTurn(submission, controller); }
        finally { this.executing--; }
      },
      executeControl: (submission) => this.executeControl(submission),
    }, this.options.limits);
    this.loops.set(sessionId, loop);
    return loop;
  }

  private async executeTurn(
    submission: Submission,
    controller: AbortController,
  ): Promise<SubmissionResult> {
    const sessionStore = this.options.sessionStore ?? defaultSessionStore;
    const session = sessionStore.getOrCreate(
      submission.sessionId,
      this.options.userId ?? "anonymous",
    );

    const runId = newAgentId("run");
    const run = AgentRun.create(
      { rawText: submission.input.content, config: submission.input.config },
      {
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        eventBus: this.options.eventBus ?? defaultAgentEventBus,
      },
    );
    const agentState = run.state;
    const active: ActiveRun = {
      runId,
      submissionId: submission.id,
      sessionId: submission.sessionId,
      get status() {
        return run.state.status;
      },
      controller,
      run,
    };

    this.activeRuns.set(runId, active);
    const onAbort = () => {
      const reason = controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : String(controller.signal.reason ?? "user_cancelled");
      run.requestCancellation(reason, "transport");
    };
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });

    try {
      run.transition("running", {
        reason: "submission_started",
        source: "runtime",
        details: { submissionId: submission.id },
      });
      const config = submission.input.config ?? {};
      const parseFn = typeof config.parseFn === "function"
        ? (config.parseFn as (text: string) => import("../../spec/types.js").StructuredConstraints)
        : undefined;
      const configuredRunOptions =
        config.runOptions && typeof config.runOptions === "object"
          ? config.runOptions as Partial<PipelineOptions>
          : {};
      const profile =
        (config.profile as PipelineOptions["profile"] | undefined)
        ?? this.options.runOptions?.profile;
      const autoSegment =
        (config.autoSegment as PipelineOptions["autoSegment"] | undefined)
        ?? this.options.runOptions?.autoSegment;
      const weather =
        (config.weather as PipelineOptions["weather"] | undefined)
        ?? this.options.runOptions?.weather;
      const date =
        (config.date as PipelineOptions["date"] | undefined)
        ?? this.options.runOptions?.date;
      const baseConstraints =
        (config.baseConstraints as PipelineOptions["baseConstraints"] | undefined)
        ?? this.options.runOptions?.baseConstraints;
      const runOptions: PipelineOptions = {
        ...(this.options.runOptions ?? {}),
        ...configuredRunOptions,
        ...(profile !== undefined ? { profile } : {}),
        ...(autoSegment !== undefined ? { autoSegment } : {}),
        ...(weather !== undefined ? { weather } : {}),
        ...(date !== undefined ? { date } : {}),
        ...(baseConstraints !== undefined ? { baseConstraints } : {}),
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        signal: controller.signal,
        requestFollowUp: config.interactive === true
          ? questions => this.waitForAnswers(active, submission, questions)
          : undefined,
      };
      const planner = this.options.planner ?? defaultActivityPlanner;
      const pipelineResult = await planner.run(run, {
        ...runOptions,
        parseFn: parseFn ?? runOptions.parseFn,
      });

      for (const message of pipelineResult.agentState.messages.filter(
        (message) => message.runId === runId && message.id !== submission.input.id,
      )) {
        sessionStore.appendMessage(session.id, message);
      }

      const finalStatus: AgentRunStatus = pipelineResult.agentState.status === "cancelled"
        ? "cancelled"
        : pipelineResult.success
          ? "completed"
          : "failed";
      run.finish(
        finalStatus,
        agentState.result ?? { success: pipelineResult.success, message: pipelineResult.message },
        {
          reason: "submission_finished",
          source: "runtime",
          details: { submissionId: submission.id, success: pipelineResult.success },
        },
        { source: "runtime" },
      );
      return {
        submissionId: submission.id,
        status: finalStatus === "completed" ? "completed" : "failed",
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        result: pipelineResult,
      };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      const message = cancelled
        ? `运行已取消：${controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason ?? "user_cancelled")}`
        : error instanceof Error
          ? error.message
          : String(error);
      if (!run.isTerminal()) {
        run.emit({
          type: "error",
          payload: { message, cancelled, source: "runtime" },
        });
        const terminalStatus = cancelled ? "cancelled" : "failed";
        run.finish(
          terminalStatus,
          { success: false, message },
          { reason: message, source: "runtime", details: { submissionId: submission.id } },
          { source: "runtime" },
        );
      }
      return {
        submissionId: submission.id,
        status: "failed",
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        error: message,
      };
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      this.activeRuns.delete(runId);
      if (submission.sessionRetention === "ephemeral") {
        sessionStore.remove(submission.sessionId);
      }
      sessionStore.cleanup(new Set(
        [...this.activeRuns.values()].map((run) => run.sessionId),
      ));
    }
  }

  private async executeControl(submission: Submission): Promise<SubmissionResult> {
    switch (submission.op.type) {
      case "answer": {
        const active = this.ownedRun(submission.sessionId, submission.op.runId);
        const pending = active?.pendingInput;
        const reject = (error: string): SubmissionResult => ({ submissionId: submission.id,
          sessionId: submission.sessionId, traceId: submission.traceId, status: "rejected", error });
        if (!active || !pending || active.status !== "waiting_input" || active.controller.signal.aborted
          || pending.requestId !== submission.op.requestId || Date.now() >= pending.expiresAt) return reject("follow_up_not_pending");
        let answers: FollowUpSelection[];
        try { answers = validateFollowUpAnswers(pending.questions, submission.op.answers); }
        catch { return reject("invalid_follow_up_answers"); }
        active.run.emit({ type: "follow_up_answered", payload: { requestId: pending.requestId, questionIds: answers.map(a => a.questionId) } });
        active.run.transition("running", { source: "control", reason: "follow_up_answered" });
        active.pendingInput = undefined; // 同步认领，重复/过期回答不能再次推进运行。
        pending.resolve(answers);
        return { submissionId: submission.id, sessionId: submission.sessionId, traceId: submission.traceId,
          runId: active.runId, status: "completed", result: { accepted: true, requestId: pending.requestId } };
      }
      case "inspect_run": {
        const active = this.ownedRun(submission.sessionId, submission.op.runId);
        if (!active) return this.runNotFound(submission);
        return {
          submissionId: submission.id,
          status: "completed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          result: active,
        };
      }
      case "cancel":
        return this.handleCancel(submission, submission.op.runId);
      case "turn":
      case "health_check":
        throw new Error(`不应由 control handler 处理 op=${submission.op.type}`);
    }
  }

  private async waitForAnswers(active: ActiveRun, submission: Submission, questions: FollowUpQuestion[]): Promise<FollowUpSelection[]> {
    const signal = active.controller.signal;
    throwIfAborted(signal);
    if (active.pendingInput || !isFollowUpQuestions(questions)) throw new Error("invalid_follow_up_request");
    const requestId = `question_${randomUUID()}`;
    const expiresAt = submission.createdAt + (this.options.limits?.deadlineMs ?? 120_000);
    if (Date.now() >= expiresAt) throw new Error("submission_deadline_exceeded");
    let abort: () => void = () => {};
    try {
      return await new Promise<FollowUpSelection[]>((resolve, reject) => {
        abort = () => { active.pendingInput = undefined; reject(signal.reason ?? new Error("run_aborted")); };
        active.pendingInput = { requestId, questions: structuredClone(questions), expiresAt, resolve };
        signal.addEventListener("abort", abort, { once: true });
        active.run.transition("waiting_input", { source: "runtime", reason: "follow_up_requested" });
        active.run.emit({ type: "follow_up_requested", payload: { requestId, expiresAt, questions } });
      });
    } finally {
      signal.removeEventListener("abort", abort);
      active.pendingInput = undefined;
    }
  }

  private handleCancel(submission: Submission, runId: RunId): SubmissionResult {
    const active = this.ownedRun(submission.sessionId, runId);
    if (!active) return this.runNotFound(submission);

    active.run.requestCancellation("cancelled_by_submission", "control");
    active.controller.abort(new Error("cancelled_by_submission"));
    return {
      submissionId: submission.id,
      status: "completed",
      runId: active.runId,
      sessionId: submission.sessionId,
      traceId: submission.traceId,
      result: { cancelled: true },
    };
  }

  private ownedRun(sessionId: string, runId: RunId): ActiveRun | undefined {
    const active = this.activeRuns.get(runId);
    return active?.sessionId === sessionId ? active : undefined;
  }

  private runNotFound(submission: Submission): SubmissionResult {
    return {
      submissionId: submission.id,
      status: "rejected",
      sessionId: submission.sessionId,
      traceId: submission.traceId,
      error: "未找到可控制的运行。",
    };
  }

  getActiveRun(runId: RunId): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  shutdown(): void {
    this.stopped = true;
    for (const loop of this.loops.values()) {
      loop.stop();
    }
    this.loops.clear();
  }
}

export class AgentRuntime {
  readonly router: SubmissionRouter;
  readonly eventBus: AgentEventBus;

  constructor(options: AgentRuntimeOptions = {}) {
    this.eventBus = options.eventBus ?? defaultAgentEventBus;
    this.router = new SubmissionRouter({ ...options, eventBus: this.eventBus });
  }

  async submit(
    input: AgentInput | string,
    opts: {
      sessionId: string;
      traceId?: string;
      op?: SubmissionOp;
      parentSubmissionId?: string;
      sessionRetention?: SessionRetention;
      signal?: AbortSignal;
    },
  ): Promise<SubmissionResult> {
    const submission = createSubmission(input, opts);
    return this.submitSubmission(submission);
  }

  /** 已标准化 Submission 的统一执行入口；表现层可先注册 Subscriber 再提交。 */
  submitSubmission(submission: Submission): Promise<SubmissionResult> {
    return this.router.dispatch(submission);
  }

  shutdown(): void {
    this.router.shutdown();
  }
}

export const defaultAgentRuntime = new AgentRuntime();
