// ============================================================
// src/runtime/submission.ts — Runtime 输入提交契约
//
// Submission 表示“一次输入进入 Runtime 系统后的标准化请求”。
// 它不等价于 AgentRun：某些 op 可以直接处理而不创建 Run。
// ============================================================

import {
  newAgentId,
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
  createdAt: number;
}

export type SubmissionOp =
  | { type: "turn" }
  | { type: "health_check" }
  | { type: "inspect_run"; runId: RunId }
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
  config?: Record<string, unknown>,
): AgentInput {
  return {
    id: newAgentId("input"),
    content,
    ...(config ? { config } : {}),
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
        : createAgentInput(input.rawText, input.config);

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
  };
}
