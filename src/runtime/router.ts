// ============================================================
// src/runtime/router.ts — Submission Router + Session Submission Loop
// ============================================================

import {
  createAgentState,
  newAgentId,
  type AgentRunStatus,
  type RunId,
} from "../../spec/agent.js";
import { type PipelineOptions } from "../planner/engine.js";
import { defaultActivityPlanner } from "../planner/activity-planner.js";
import {
  createSubmission,
  type AgentInput,
  type Submission,
  type SubmissionResult,
  type SubmissionOp,
} from "./submission.js";
import {
  defaultSessionStore,
  type InMemorySessionStore,
} from "./session.js";
import {
  createSessionSubmissionLoop,
  type SessionSubmissionLoop,
} from "./submission-loop.js";

interface ActiveRun {
  runId: RunId;
  submissionId: string;
  sessionId: string;
  status: AgentRunStatus;
  controller: AbortController;
}

export interface AgentRuntimeOptions {
  sessionStore?: InMemorySessionStore;
  userId?: string;
  runOptions?: PipelineOptions;
}

export class SubmissionRouter {
  private readonly activeRuns = new Map<RunId, ActiveRun>();
  private readonly loops = new Map<string, SessionSubmissionLoop>();

  constructor(
    private readonly options: AgentRuntimeOptions = {},
  ) {}

  /**
   * Control plane 入口：turn / cancel / inspect 先进入对应 Session 的 loop。
   * health_check 属于全局操作，不需要创建 AgentRun，因此直接处理。
   */
  async dispatch(submission: Submission): Promise<SubmissionResult> {
    if (submission.op.type === "health_check") {
      return {
        submissionId: submission.id,
        status: "completed",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        result: { status: "ok" },
      };
    }

    return this.getLoop(submission.sessionId).submit(submission);
  }

  private getLoop(sessionId: string): SessionSubmissionLoop {
    let loop = this.loops.get(sessionId);
    if (loop) return loop;

    loop = createSessionSubmissionLoop(sessionId, {
      executeTurn: (submission, controller) => this.executeTurn(submission, controller),
      executeControl: (submission) => this.executeControl(submission),
    });
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
    const active: ActiveRun = {
      runId,
      submissionId: submission.id,
      sessionId: submission.sessionId,
      status: "pending",
      controller,
    };

    this.activeRuns.set(runId, active);

    sessionStore.appendMessage(session.id, {
      ...submission.input,
      id: submission.input.id,
      createdAt: submission.input.createdAt,
      runId,
      direction: "inbound",
      kind: "user_input",
      text: submission.input.content,
    });


    try {
      active.status = "running";
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
      const runOptions: PipelineOptions = {
        ...(this.options.runOptions ?? {}),
        ...configuredRunOptions,
        ...(profile !== undefined ? { profile } : {}),
        ...(autoSegment !== undefined ? { autoSegment } : {}),
        ...(weather !== undefined ? { weather } : {}),
        ...(date !== undefined ? { date } : {}),
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        signal: controller.signal,
      };
      const agentState = createAgentState(
        { rawText: submission.input.content, config: submission.input.config },
        { runId, sessionId: submission.sessionId, traceId: submission.traceId },
      );
      const pipelineResult = await defaultActivityPlanner.run(agentState, {
        ...runOptions,
        parseFn,
      });

      for (const message of pipelineResult.agentState.messages.filter(
        (message) => message.runId === runId && message.id !== submission.input.id,
      )) {
        sessionStore.appendMessage(session.id, message);
      }

      active.status = pipelineResult.success ? "completed" : "failed";
      return {
        submissionId: submission.id,
        status: pipelineResult.success ? "completed" : "failed",
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        result: pipelineResult,
      };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      active.status = cancelled ? "cancelled" : "failed";
      return {
        submissionId: submission.id,
        status: "failed",
        runId,
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        error: cancelled
          ? `运行已取消：${controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason ?? "user_cancelled")}`
          : error instanceof Error
            ? error.message
            : String(error),
      };
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async executeControl(submission: Submission): Promise<SubmissionResult> {
    switch (submission.op.type) {
      case "inspect_run":
        return {
          submissionId: submission.id,
          status: "completed",
          sessionId: submission.sessionId,
          traceId: submission.traceId,
          result: this.activeRuns.get(submission.op.runId) ?? null,
        };
      case "cancel":
        return this.handleCancel(submission, submission.op.runId);
      case "turn":
      case "health_check":
        throw new Error(`不应由 control handler 处理 op=${submission.op.type}`);
    }
  }

  private handleCancel(submission: Submission, runId: RunId): SubmissionResult {
    const active = this.activeRuns.get(runId);
    if (!active) {
      return {
        submissionId: submission.id,
        status: "rejected",
        sessionId: submission.sessionId,
        traceId: submission.traceId,
        error: "未找到可取消的运行。",
      };
    }

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

  getActiveRun(runId: RunId): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  shutdown(): void {
    for (const loop of this.loops.values()) {
      loop.stop();
    }
    this.loops.clear();
  }
}

export class AgentRuntime {
  readonly router: SubmissionRouter;

  constructor(options: AgentRuntimeOptions = {}) {
    this.router = new SubmissionRouter(options);
  }

  async submit(
    input: AgentInput | string,
    opts: {
      sessionId: string;
      traceId?: string;
      op?: SubmissionOp;
      parentSubmissionId?: string;
    },
  ): Promise<SubmissionResult> {
    const submission = createSubmission(input, opts);
    return this.submitSubmission(submission);
  }

  /** 已标准化 Submission 的统一执行入口；SSE 等上层可先订阅事件再提交。 */
  submitSubmission(submission: Submission): Promise<SubmissionResult> {
    return this.router.dispatch(submission);
  }

  shutdown(): void {
    this.router.shutdown();
  }
}

export const defaultAgentRuntime = new AgentRuntime();
