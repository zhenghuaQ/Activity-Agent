// ============================================================
// src/tools/base.ts — Tool 基类（Claude Code 式工具协议）
//
// execute() 是公共入口：计时 + 上下文注入 + 异常转 error 信封。
// run() 由工具作者实现，可返回：
//   - 裸数据 TOutput     → 自动包装为 success 信封
//   - 字符串             → success 信封（text 与 data 相同）
//   - ToolResponse       → 原样透传（用 ok/partial/err 工厂构造）
// ============================================================

import type { JsonSchemaObject, LLMToolFormat } from "../../spec/tools.js";
import type {
  ToolContext,
  ToolOutput,
  ToolResponse,
  ToolStats,
} from "../../spec/tool-response.js";
import type { ToolErrorCode, ToolErrorInfo } from "../../spec/errors.js";
import { ERROR_CODE_META } from "../../spec/errors.js";
import { ToolError } from "./errors.js";

/** 裸数据自动转 text 时的截断上限（控制 transcript 体积） */
const TEXT_TRUNCATE_LIMIT = 6000;

/** 工具作者可附加的上下文信息 */
export interface ContextExtras {
  source?: string;
  notes?: string[];
}

const EMPTY_STATS: ToolStats = { startedAt: 0, durationMs: 0 };
const EMPTY_CONTEXT: ToolContext = { toolName: "", input: undefined };

/** 快速构造 success 响应 */
export function ok<T>(text: string, data: T, extras: ContextExtras = {}): ToolResponse<T> {
  return {
    status: "success",
    text,
    data,
    stats: EMPTY_STATS,
    context: { ...EMPTY_CONTEXT, ...extras },
  };
}

/** 快速构造 partial 响应（有数据但不完整/降级） */
export function partial<T>(text: string, data: T, extras: ContextExtras = {}): ToolResponse<T> {
  return {
    status: "partial",
    text,
    data,
    stats: EMPTY_STATS,
    context: { ...EMPTY_CONTEXT, ...extras },
  };
}

/** 快速构造 error 响应 */
export function err(
  code: ToolErrorCode,
  message: string,
  extras: ContextExtras = {}
): ToolResponse<never> {
  const meta = ERROR_CODE_META[code];
  return {
    status: "error",
    text: `[${code}] ${message}`,
    errorInfo: { code, category: meta.category, retryable: meta.retryable, message },
    stats: EMPTY_STATS,
    context: { ...EMPTY_CONTEXT, ...extras },
  };
}

/** 异常 → 错误信息（ToolError 用其自带码，其余归为 E_EXECUTION_FAILED） */
function toErrorInfo(e: unknown): ToolErrorInfo {
  if (e instanceof ToolError) {
    const meta = ERROR_CODE_META[e.code];
    return { code: e.code, category: meta.category, retryable: meta.retryable, message: e.message };
  }
  const meta = ERROR_CODE_META.E_EXECUTION_FAILED;
  return {
    code: "E_EXECUTION_FAILED",
    category: meta.category,
    retryable: meta.retryable,
    message: e instanceof Error ? e.message : String(e),
  };
}

function isToolResponse<T>(raw: unknown): raw is ToolResponse<T> {
  return typeof raw === "object" && raw !== null && "status" in raw && "text" in raw;
}

/** 裸数据 → 模型可读文本（JSON，超长截断） */
function dataToText(data: unknown): string {
  const json = JSON.stringify(data);
  if (json.length <= TEXT_TRUNCATE_LIMIT) return json;
  return `${json.slice(0, TEXT_TRUNCATE_LIMIT)}…（已截断，共 ${json.length} 字符）`;
}

/**
 * 通用 Tool 基类。
 * description + inputSchema 是写给 LLM 看的接口（agent loop 的前提）。
 */
export abstract class BaseTool<TInput, TOutput> {
  abstract name: string;
  /** 工具的用途与调用时机 —— 模型据此决定是否调用 */
  abstract description: string;
  /** 输入参数的 JSON Schema —— 模型据此传参 */
  abstract inputSchema: JsonSchemaObject;
  /** 工具作者实现：可返回裸数据（自动包 success 信封）或完整 ToolResponse */
  protected abstract run(input: TInput): Promise<TOutput | ToolOutput<TOutput>>;

  /**
   * 公共入口（即 run_with_timing 语义）：
   * 自动注入 stats（计时）与 context（工具名/入参），异常转为 error 信封。
   */
  async execute(input: TInput): Promise<ToolResponse<TOutput>> {
    const startedAt = Date.now();
    const startMs = performance.now();
    const baseContext: ToolContext = { toolName: this.name, input };

    try {
      const raw = await this.run(input);
      const res = normalizeOutput(raw);
      return {
        ...res,
        stats: { ...res.stats, startedAt, durationMs: Math.round(performance.now() - startMs) },
        // baseContext 后展开：真实 toolName/input 覆盖工厂占位值，extras 保留
        context: { ...res.context, ...baseContext },
      };
    } catch (e) {
      const info = toErrorInfo(e);
      return {
        status: "error",
        text:
          `工具 ${this.name} 调用失败 [${info.code}] ${info.message}` +
          (info.retryable ? "（可重试）" : ""),
        errorInfo: info,
        stats: { startedAt, durationMs: Math.round(performance.now() - startMs) },
        context: baseContext,
      };
    }
  }

  /** 转换为 OpenAI 兼容的 function tool 定义（chat.completions 的 tools 参数） */
  toLLMTool(): LLMToolFormat {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.inputSchema,
      },
    };
  }
}

/** run() 返回值归一化为 ToolResponse（裸数据/字符串自动包装，信封透传） */
function normalizeOutput<T>(raw: T | ToolOutput<T>): ToolResponse<T> {
  if (isToolResponse<T>(raw)) return raw;
  if (typeof raw === "string") {
    return {
      status: "success",
      text: raw,
      data: raw as unknown as T,
      stats: EMPTY_STATS,
      context: EMPTY_CONTEXT,
    };
  }
  return { status: "success", text: dataToText(raw), data: raw, stats: EMPTY_STATS, context: EMPTY_CONTEXT };
}
