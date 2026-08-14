// ============================================================
// spec/tool-response.ts — 工具响应协议（SDD）
//
// Claude Code 式设计：工具结果本质是「写进 transcript 的话」。
//   text      → LLM 阅读的格式化文本（含错误时的建议）
//   data      → 程序（loop/校验器/UI）消费的结构化载荷
//   errorInfo → 仅 status=error 时存在
//   stats     → 运行统计（时间、token 等）
//   context   → 上下文（工具名、入参、数据源、注记）
//
// 三态协议：
//   success → 完整成功
//   partial → 部分成功（有数据但不完整/降级），模型据此判断重试或接受
//   error   → 失败，text 中带错误码与建议
// ============================================================

import type { ToolErrorInfo } from "./errors.js";

/** 工具状态三态 */
export type ToolStatus = "success" | "partial" | "error";

/** 运行统计 */
export interface ToolStats {
  /** 开始时间（epoch ms） */
  startedAt: number;
  /** 耗时（ms） */
  durationMs: number;
  /** token 用量（仅 LLM 型工具可回填，由 loop 层补充） */
  tokens?: { input: number; output: number };
}

/** 工具上下文 */
export interface ToolContext {
  toolName: string;
  /** 本次调用的入参（回显，便于调试与 transcript） */
  input: unknown;
  /** 数据来源：mock / amap / llm / cache */
  source?: string;
  /** 过程注记（如「已扩大半径重搜」），非错误 */
  notes?: string[];
}

/** 工具响应（判别式联合：error 无 data 有 errorInfo） */
export type ToolResponse<T = unknown> =
  | { status: "success"; text: string; data: T; stats: ToolStats; context: ToolContext }
  | { status: "partial"; text: string; data: T; stats: ToolStats; context: ToolContext }
  | {
      status: "error";
      text: string;
      errorInfo: ToolErrorInfo;
      stats: ToolStats;
      context: ToolContext;
    };

/**
 * 工具作者在 run() 中可返回的类型：
 *   - 裸数据 TOutput → 自动包装为 success 信封
 *   - 字符串        → success 信封（text 与 data 均为该字符串）
 *   - ToolResponse  → 原样透传
 */
export type ToolOutput<T = unknown> = string | ToolResponse<T>;
