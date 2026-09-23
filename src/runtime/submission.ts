// ============================================================
// src/runtime/submission.ts — Runtime 输入提交契约
//
// Submission 表示“一次输入进入 Runtime 系统后的标准化请求”。
// 它不等价于 AgentRun：某些 op 可以直接处理而不创建 Run。
// ============================================================

import {
  newAgentId,
  type AgentRunContextInput,
  type AgentRunInput,
  type RunId,
  type SessionId,
  type TraceId,
} from "../../spec/agent.js";

export type SubmissionId = string;
export type InputId = string;
export type SessionRetention = "retained" | "ephemeral";

export interface AgentInput {
  id: InputId;
  content: string;
  config?: Record<string, unknown>;
  /** 调用方提供的环境事实提示，不与运行配置混用。 */
  context?: AgentRunContextInput;
  createdAt: number;
}

/**
 * 新调用可显式区分 config/context；保留 Record 形态兼容既有调用方。
 * 仅包含 location 的对象也支持作为 context 简写。
 */
export interface AgentInputOptions {
  config?: Record<string, unknown>;
  context?: AgentRunContextInput;
}

export type SubmissionOp =
  | { type: "turn" }
  | { type: "health_check" }
  | { type: "inspect_run"; runId: RunId }
  | { type: "answer"; runId: RunId; requestId: string; answers: import("../../spec/follow-up.js").FollowUpSelection[] }
  | { type: "cancel"; runId: RunId };

export type SubmissionStatus =
  | "created"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "rejected";

export interface Submission {
  id: SubmissionId;
  input: AgentInput;
  sessionId: SessionId;
  traceId: TraceId;
  op: SubmissionOp;
  sessionRetention: SessionRetention;
  signal?: AbortSignal;
  createdAt: number;
  parentSubmissionId?: SubmissionId;
}

export interface SubmissionResult {
  submissionId: SubmissionId;
  status: SubmissionStatus;
  runId?: RunId;
  sessionId: SessionId;
  traceId: TraceId;
  result?: unknown;
  error?: string;
}

export function createAgentInput(
  content: string,
  configOrOptions?: Record<string, unknown> | AgentInputOptions,
  context?: AgentRunContextInput,
): AgentInput {
  let config: Record<string, unknown> | undefined;
  let resolvedContext = context;

  if (configOrOptions) {
    const candidate = configOrOptions as Record<string, unknown>;
    const hasContext = "context" in candidate;
    const hasNestedConfig = "config" in candidate;
    const hasLocation = "location" in candidate;

    if (hasContext || hasNestedConfig || hasLocation) {
      const {
        context: nestedContext,
        config: nestedConfig,
        location,
        ...legacyConfig
      } = candidate;
      config = {
        ...legacyConfig,
        ...(nestedConfig && typeof nestedConfig === "object" ? nestedConfig : {}),
      };
      if (Object.keys(config).length === 0) config = undefined;
      resolvedContext = (nestedContext as AgentRunContextInput | undefined)
        ?? (hasLocation ? { location: location as AgentRunContextInput["location"] } : resolvedContext);
    } else {
      config = configOrOptions as Record<string, unknown>;
    }
  }

  return {
    id: newAgentId("input"),
    content,
    ...(config ? { config } : {}),
    ...(resolvedContext ? { context: resolvedContext } : {}),
    createdAt: Date.now(),
  };
}

export function createSubmission(
  input: AgentInput | AgentRunInput | string,
  opts: {
    sessionId: SessionId;
    traceId?: TraceId;
    op?: SubmissionOp;
    parentSubmissionId?: SubmissionId;
    sessionRetention?: SessionRetention;
    signal?: AbortSignal;
  },
): Submission {
  const normalized: AgentInput =
    typeof input === "string"
      ? createAgentInput(input)
      : "id" in input
        ? input
        : createAgentInput(input.rawText, input.config, input.context);

  return {
    id: newAgentId("submission"),
    input: normalized,
    sessionId: opts.sessionId,
    traceId: opts.traceId ?? newAgentId("trace"),
    op: opts.op ?? { type: "turn" },
    sessionRetention: opts.sessionRetention ?? "retained",
    ...(opts.signal ? { signal: opts.signal } : {}),
    createdAt: Date.now(),
    ...(opts.parentSubmissionId ? { parentSubmissionId: opts.parentSubmissionId } : {}),
  };
}

export function toAgentRunInput(input: AgentInput): AgentRunInput {
  return {
    rawText: input.content,
    config: input.config,
    context: input.context,
  };
}
