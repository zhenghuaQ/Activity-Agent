// ============================================================
// spec/agent.ts — Agent Runtime 运行状态契约（SDD）
//
// 两层状态分工：
//   AgentState    → Runtime 层：一次 Agent 运行的生命周期状态
//                   （输入/消息流/执行进度/工具调用/结果/追踪）
//   PlanningState → 业务层：领域规划过程的中间状态（约束/候选/决策）
//                   由 types.ts 定义，AgentState.planning 持有它
//
// 本文件为第一版（v1），字段后续可能调整。
// ============================================================

import type { FollowUpAnswer, FollowUpQuestion, PlanningState } from "./types.js";

// ─── 标识 ──────────────────────────────────────────────

/** 一次运行的唯一 ID（每次 runFullPipeline / agent.run 生成一个） */
export type RunId = string;

/** 会话 ID（多轮对话共用，跨 run 保持） */
export type SessionId = string;

/** 链路追踪 ID（Trace Collector 用，关联全部 trace 事件） */
export type TraceId = string;

// ─── 输入 ──────────────────────────────────────────────

/** Runtime 任务输入（第一版：自然语言 + 可选运行配置） */
export interface AgentRunInput {
  /** 用户原始输入（自然语言） */
  rawText: string;
  /** 运行配置（画像/天气/降级开关等，按领域扩展） */
  config?: Record<string, unknown>;
}

// ─── 消息流（Inbound / Outbound） ──────────────────────
//
// 按方向建模：进入 Agent 的为 Inbound（用户输入/追问回答/系统注入），
// Agent 发出的为 Outbound（文本/追问/工具结果/决策结论）。
// 各形态以 kind 判别（判别式联合，与 ToolResponse 同风格）；
// 工具结果作为 outbound 记入消息流，供 transcript 回放与观测。

/** 消息方向 */
export type MessageDirection = "inbound" | "outbound";

/** 消息公共字段 */
interface MessageBase {
  id: string;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 关联运行 ID（会话级消息可缺省） */
  runId?: RunId;
}

// ── Inbound：进入 Agent ──

/** 用户自然语言输入 */
export interface UserInputMessage extends MessageBase {
  direction: "inbound";
  kind: "user_input";
  /** 原始输入文本 */
  text: string;
}

/** 用户对追问的回答（含对约束的修正 patch） */
export interface FollowUpAnswerMessage extends MessageBase {
  direction: "inbound";
  kind: "followup_answer";
  answers: FollowUpAnswer[];
}

/** 系统注入（配置/指令/事件，非用户发起） */
export interface SystemInboundMessage extends MessageBase {
  direction: "inbound";
  kind: "system";
  /** 事件标识（如 flags 更新、降级事件） */
  event: string;
  /** 附加载荷 */
  payload?: unknown;
}

/** 入站消息 */
export type InboundMessage =
  | UserInputMessage
  | FollowUpAnswerMessage
  | SystemInboundMessage;

// ── Outbound：Agent 发出 ──

/** Agent 文本产出（意图摘要/解释/提示） */
export interface TextMessage extends MessageBase {
  direction: "outbound";
  kind: "text";
  text: string;
}

/** Agent 追问（等待用户回答，对应 waiting_input 态） */
export interface FollowUpQuestionMessage extends MessageBase {
  direction: "outbound";
  kind: "followup_question";
  questions: FollowUpQuestion[];
}

/** 工具调用结果（摘要；详情在 AgentToolCall / ToolResponse） */
export interface ToolResultMessage extends MessageBase {
  direction: "outbound";
  kind: "tool_result";
  /** 关联 AgentToolCall.id */
  toolCallId: string;
  toolName: string;
  /** 三态，与 ToolResponse.status 对齐 */
  status: "success" | "partial" | "error";
  /** 模型/人可读摘要（建议截断后的 text） */
  summary: string;
}

/** 决策/运行结论（终态产出；领域产物在 run 的 result.data） */
export interface DecisionMessage extends MessageBase {
  direction: "outbound";
  kind: "decision";
  success: boolean;
  /** 结论摘要 */
  message: string;
}

/** 出站消息 */
export type OutboundMessage =
  | TextMessage
  | FollowUpQuestionMessage
  | ToolResultMessage
  | DecisionMessage;

/** 统一消息（消息流中一条记录） */
export type AgentMessage = InboundMessage | OutboundMessage;

// ── 消息工厂（补齐公共字段） ──

export function inboundUserInput(text: string, runId?: RunId): UserInputMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "inbound", kind: "user_input", text };
}

export function inboundFollowUpAnswer(answers: FollowUpAnswer[], runId?: RunId): FollowUpAnswerMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "inbound", kind: "followup_answer", answers };
}

export function inboundSystem(event: string, payload?: unknown, runId?: RunId): SystemInboundMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "inbound", kind: "system", event, payload };
}

export function outboundText(text: string, runId?: RunId): TextMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "outbound", kind: "text", text };
}

export function outboundFollowUpQuestion(questions: FollowUpQuestion[], runId?: RunId): FollowUpQuestionMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "outbound", kind: "followup_question", questions };
}

export function outboundToolResult(
  toolCallId: string,
  toolName: string,
  status: "success" | "partial" | "error",
  summary: string,
  runId?: RunId
): ToolResultMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "outbound", kind: "tool_result", toolCallId, toolName, status, summary };
}

export function outboundDecision(success: boolean, message: string, runId?: RunId): DecisionMessage {
  return { id: newAgentId("msg"), createdAt: Date.now(), runId, direction: "outbound", kind: "decision", success, message };
}

// ─── 运行状态 ──────────────────────────────────────────

/** 运行生命周期状态 */
export type AgentRunStatus =
  | "pending"        // 已创建未开始
  | "running"        // 执行中
  | "waiting_input"  // 等待用户补充输入（如追问回答）
  | "completed"      // 正常完成
  | "failed"         // 失败终止
  | "cancelled";     // 主动取消

/** 当前执行步骤（v1：步骤名/ID 字符串，后续可扩展为结构化 Step） */
export type AgentStepRef = string;

// ─── 工具调用记录 ──────────────────────────────────────

/** 一次工具调用的运行记录（摘要，载荷细节在 ToolResponse/Trace） */
export interface AgentToolCall {
  id: string;
  /** 工具名（注册中心内的 name） */
  toolName: string;
  /** 调用入参（回显） */
  input: unknown;
  /** 调用状态 */
  status: "success" | "partial" | "error";
  /** 耗时（ms） */
  durationMs: number;
  /** 错误码（status=error 时） */
  errorCode?: string;
  /** 调用时间（epoch ms） */
  startedAt: number;
}

// ─── 运行结果 ──────────────────────────────────────────

/** 运行结果信封（领域产物放 data，保持 Runtime 领域无关） */
export interface AgentRunResult {
  /** 是否成功 */
  success: boolean;
  /** 人类可读的结论摘要 */
  message: string;
  /** 领域产物（如出行决策的 DecisionResult/Plan） */
  data?: unknown;
}

// ─── AgentState（Runtime 运行状态） ────────────────────

/**
 * Agent Runtime 的运行状态：一次 Agent 运行的唯一载体。
 *
 * 生命周期：createAgentState() 创建（pending）
 *   → running（步骤推进，消息/工具调用/业务状态累积）
 *   → completed / failed / cancelled（终态，result 必填）
 *   （waiting_input 为可逆中间态，如需用户追问回答）
 */
export interface AgentState {
  /** 运行 ID（每次运行唯一） */
  runId: RunId;
  /** 会话 ID（多轮共享） */
  sessionId: SessionId;
  /** 链路追踪 ID（关联全部 trace 事件） */
  traceId: TraceId;
  /** 任务输入 */
  input: AgentRunInput;
  /** 运行状态 */
  status: AgentRunStatus;
  /** 当前执行步骤（步骤名/ID，v1 为字符串） */
  currentStep?: AgentStepRef;
  /** 业务状态：领域规划过程（PlanningState 及其扩展） */
  planning: PlanningState;
  /** 消息流（用户输入/Agent 产出/系统注记/工具返回） */
  messages: AgentMessage[];
  /** 工具调用记录（按调用顺序） */
  toolCalls: AgentToolCall[];
  /** 错误收集 */
  errors: string[];
  /** 运行结果（终态时必填） */
  result?: AgentRunResult;
}

// ─── 工厂 ──────────────────────────────────────────────

/** ID 生成（简单递增 + 随机后缀，可替换为 ULID/UUID） */
export function newAgentId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 创建初始 AgentState（pending 态，planning 为零值业务状态） */
export function createAgentState(
  input: AgentRunInput,
  opts: { runId?: RunId; sessionId?: SessionId; traceId?: TraceId } = {}
): AgentState {
  return {
    runId: opts.runId ?? newAgentId("run"),
    sessionId: opts.sessionId ?? newAgentId("sess"),
    traceId: opts.traceId ?? newAgentId("trace"),
    input,
    status: "pending",
    planning: { stage: "intent_parsing", errors: [] },
    messages: [],
    toolCalls: [],
    errors: [],
  };
}

// ─── Session（会话容器，轻量版 v1） ──────────────────────
//
// 只承载会话身份 + 消息流 + 元数据；不持有 AgentState/
// PlanningState——运行状态归每次 run，会话只串联多轮。

/** 用户 ID */
export type UserId = string;

/** 会话（多轮对话的容器） */
export interface AgentSession {
  /** 会话 ID */
  id: SessionId;
  /** 归属用户 ID */
  userId: UserId;
  /** 会话消息流（跨 run 累积） */
  messages: AgentMessage[];
  /** 元数据（画像/偏好/入口等，按需放） */
  metadata: Record<string, unknown>;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最近更新时间（epoch ms） */
  updatedAt: number;
}

/** 创建初始会话（空消息流，时间戳取当前） */
export function createAgentSession(
  userId: UserId,
  opts: { id?: SessionId; metadata?: Record<string, unknown> } = {}
): AgentSession {
  const now = Date.now();
  return {
    id: opts.id ?? newAgentId("sess"),
    userId,
    messages: [],
    metadata: opts.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/** 追加消息并刷新 updatedAt（返回新对象，不动原会话） */
export function appendSessionMessage(
  session: AgentSession,
  message: AgentMessage
): AgentSession {
  return {
    ...session,
    messages: [...session.messages, message],
    updatedAt: Date.now(),
  };
}
