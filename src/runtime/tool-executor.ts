// ============================================================
// src/runtime/tool-executor.ts — Runtime 统一 Tool 执行器
//
// Harness 层负责 Tool 的运行生命周期：查找、失败分类、超时、重试、
// 可选 fallback、执行记录与 Trace。具体 Tool 仍只负责业务执行本身。
// ============================================================

import type {
  AgentState,
  AgentToolCall,
} from "../../spec/agent.js";
import { newAgentId, outboundToolResult } from "../../spec/agent.js";
import type { ToolResponse } from "../../spec/tool-response.js";
import type { ToolErrorCode } from "../../spec/errors.js";
import { ERROR_CODE_META } from "../../spec/errors.js";
import { toolRegistry } from "../tools/registry.js";
import { appendTraceEvent } from "./trace.js";
import { defaultCircuitBreakerRegistry, CircuitBreakerRegistry } from "./circuit-breaker.js";

export type ToolFailureKind =
  | "not_found"
  | "resource"
  | "parameter"
  | "timeout"
  | "rate_limited"
  | "network"
  | "state_conflict"
  | "execution"
  | "circuit_open";

export interface ToolFailure {
  kind: ToolFailureKind;
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
}

export interface ToolFallbackContext {
  toolName: string;
  input: unknown;
  failure: ToolFailure;
  state: AgentState;
  attempt: number;
}

/** Fallback 是 Runtime 策略，不属于具体 Tool 本身。 */
export type ToolFallback = (
  context: ToolFallbackContext,
) => Promise<ToolResponse<unknown>>;

export interface ToolLike {
  name: string;
  execute(
    input: unknown,
    context?: { signal?: AbortSignal }
  ): Promise<ToolResponse<unknown>>;
}

export interface ToolRegistryLike {
  get(name: string): ToolLike | undefined;
}

export interface ToolExecutorOptions {
  /** 单次 Tool 最长运行时间；undefined 表示不设超时 */
  timeoutMs?: number;
  /** 可重试错误最多额外执行次数 */
  maxRetries?: number;
  /** 允许触发 fallback 的错误码；默认只覆盖“可恢复”的运行时错误 */
  fallbackOn?: ToolErrorCode[];
  /** 按工具名注册 fallback；没有注册则只记录最终失败 */
  fallbacks?: Record<string, ToolFallback>;
  /** 可注入 Registry，便于故障注入测试；默认使用生产全局 Registry。 */
  registry?: ToolRegistryLike;
  /** Tool 健康状态注册表；默认进程级共享，跨 Run 累积失败次数。 */
  circuitBreaker?: CircuitBreakerRegistry;
  /** 上层 AgentRun 的 cooperative cancellation 信号。 */
  signal?: AbortSignal;
}

function classifyFailure(
  code: ToolErrorCode,
  message: string,
): ToolFailure {
  const meta = ERROR_CODE_META[code];

  let kind: ToolFailureKind;
  switch (code) {
    case "E_RESOURCE_NOT_FOUND":
      kind = "not_found";
      break;
    case "E_RESOURCE_EXHAUSTED":
      kind = "resource";
      break;
    case "E_PARAM_MISSING":
    case "E_PARAM_INVALID":
      kind = "parameter";
      break;
    case "E_EXECUTION_TIMEOUT":
      kind = "timeout";
      break;
    case "E_RATE_LIMITED":
      kind = "rate_limited";
      break;
    case "E_NETWORK_UNAVAILABLE":
      kind = "network";
      break;
    case "E_STATE_CONFLICT":
      kind = "state_conflict";
      break;
    case "E_EXECUTION_FAILED":
      kind = "execution";
      break;
    case "E_CIRCUIT_OPEN":
      kind = "circuit_open";
      break;
  }

  return {
    kind,
    code,
    message,
    retryable: meta.retryable,
  };
}

function errorResponse<T>(
  code: ToolErrorCode,
  toolName: string,
  input: unknown,
  message: string,
  startedAt: number,
  durationMs = Date.now() - startedAt,
): ToolResponse<T> {
  const meta = ERROR_CODE_META[code];
  return {
    status: "error",
    text: `工具 ${toolName} 执行失败 [${code}] ${message}`,
    errorInfo: {
      code,
      category: meta.category,
      retryable: meta.retryable,
      message,
    },
    stats: {
      startedAt,
      durationMs,
    },
    context: {
      toolName,
      input,
    },
  };
}

function timeoutResponse<T>(
  toolName: string,
  input: unknown,
  startedAt: number,
): ToolResponse<T> {
  const code: ToolErrorCode = "E_EXECUTION_TIMEOUT";
  return errorResponse(
    code,
    toolName,
    input,
    ERROR_CODE_META[code].defaultMessage,
    startedAt,
  );
}


function circuitOpenResponse<T>(
  toolName: string,
  input: unknown,
  startedAt = Date.now(),
): ToolResponse<T> {
  const code: ToolErrorCode = "E_CIRCUIT_OPEN";
  return errorResponse(
    code,
    toolName,
    input,
    ERROR_CODE_META[code].defaultMessage,
    startedAt,
    0,
  );
}

function recordToolCall(
  state: AgentState,
  toolName: string,
  input: unknown,
  response: ToolResponse<unknown>,
  attempt: number,
  recovery?: AgentToolCall["recovery"],
  failure?: ToolFailure,
): void {
  const startedAt = response.stats.startedAt;
  const record: AgentToolCall = {
    id: newAgentId("toolcall"),
    toolName,
    input,
    status: response.status,
    durationMs: response.stats.durationMs,
    startedAt,
    attempt,
    ...(recovery ? { recovery } : {}),
    ...(response.status === "error" ? { errorCode: response.errorInfo.code } : {}),
  };

  state.toolCalls.push(record);
  appendTraceEvent(state, {
    type: "tool_result",
    toolName,
    durationMs: response.stats.durationMs,
    metadata: {
      status: response.status,
      errorCode: record.errorCode,
      attempt,
      recovery,
      failureKind: failure?.kind,
      retryable: failure?.retryable,
    },
  });
  state.messages.push(
    outboundToolResult(
      record.id,
      toolName,
      response.status,
      response.text,
      state.runId,
    ),
  );
}

const DEFAULT_FALLBACK_CODES: ToolErrorCode[] = [
  "E_EXECUTION_TIMEOUT",
  "E_EXECUTION_FAILED",
  "E_NETWORK_UNAVAILABLE",
  "E_RESOURCE_EXHAUSTED",
  "E_RATE_LIMITED",
];

export class ToolExecutor {
  constructor(
    private readonly state: AgentState,
    private readonly options: ToolExecutorOptions = {},
  ) {}

  async execute<TInput, TOutput>(
    toolName: string,
    input: TInput,
  ): Promise<ToolResponse<TOutput>> {
    const logicalCallId = newAgentId("toolrun");
    appendTraceEvent(this.state, {
      type: "tool_call",
      toolName,
      metadata: { input, logicalCallId },
    });

    const registry = this.options.registry ?? (toolRegistry as unknown as ToolRegistryLike);
    const breaker = this.options.circuitBreaker ?? defaultCircuitBreakerRegistry;

    const permission = breaker.beforeCall(toolName);
    if (!permission.allowed) {
      const response = circuitOpenResponse<TOutput>(toolName, input);
      const failure = classifyFailure(
        "E_CIRCUIT_OPEN",
        response.status === "error" ? response.errorInfo.message : ERROR_CODE_META.E_CIRCUIT_OPEN.defaultMessage,
      );
      recordToolCall(this.state, toolName, input, response, 0, undefined, failure);
      appendTraceEvent(this.state, {
        type: "error",
        toolName,
        metadata: { phase: "circuit_open", breakerState: permission.state },
      });
      return response;
    }

    const tool = registry.get(toolName);
    if (!tool) {
      const failure = classifyFailure(
        "E_RESOURCE_NOT_FOUND",
        `未找到工具: ${toolName}`,
      );
      const response = errorResponse<TOutput>(
        failure.code,
        toolName,
        input,
        failure.message,
        Date.now(),
        0,
      );
      recordToolCall(this.state, toolName, input, response, 1, undefined, failure);
      // Tool not found 是配置/参数问题，不计入熔断器。
      return response;
    }

    const maxRetries = Math.max(0, this.options.maxRetries ?? 0);
    let lastFailure: ToolFailure | undefined;
    let lastResponse: ToolResponse<TOutput> | undefined;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const parentSignal = this.options.signal;
      const onParentAbort = () => controller.abort(parentSignal?.reason);
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      const execution = tool.execute(input, { signal: controller.signal }) as Promise<ToolResponse<TOutput>>;

      const timeoutPromise = this.options.timeoutMs !== undefined
        ? new Promise<ToolResponse<TOutput>>((resolve) => {
            timeoutHandle = setTimeout(() => {
              controller.abort();
              resolve(timeoutResponse<TOutput>(toolName, input, startedAt));
            }, this.options.timeoutMs);
          })
        : undefined;

      const response = timeoutPromise ? await Promise.race([execution, timeoutPromise]) : await execution;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      parentSignal?.removeEventListener("abort", onParentAbort);

      lastResponse = response;

      if (response.status !== "error") {
        recordToolCall(this.state, toolName, input, response, attempt);
        breaker.recordSuccess(toolName);
        return response;
      }

      lastFailure = classifyFailure(response.errorInfo.code, response.errorInfo.message);

      const canRetry = lastFailure.retryable && attempt <= maxRetries;
      const fallbackCodes = this.options.fallbackOn ?? DEFAULT_FALLBACK_CODES;
      const canFallback =
        !canRetry &&
        fallbackCodes.includes(lastFailure.code) &&
        Boolean(this.options.fallbacks?.[toolName]);

      recordToolCall(
        this.state,
        toolName,
        input,
        response,
        attempt,
        canRetry ? "retry" : undefined,
        lastFailure,
      );

      if (canRetry) {
        appendTraceEvent(this.state, {
          type: "error",
          toolName,
          metadata: { phase: "tool_retry", attempt, nextAttempt: attempt + 1, failure: lastFailure },
        });
        continue;
      }

      // 只有一次“逻辑调用”最终失败时才给熔断器记一次失败，避免 retry 放大计数。
      if (lastFailure.retryable) {
        breaker.recordFailure(toolName);
      }

      if (canFallback) {
        appendTraceEvent(this.state, {
          type: "error",
          toolName,
          metadata: { phase: "tool_fallback", attempt, failure: lastFailure },
        });

        const fallbackResponse = await this.options.fallbacks![toolName]({
          toolName,
          input,
          failure: lastFailure,
          state: this.state,
          attempt,
        });

        recordToolCall(
          this.state,
          toolName,
          input,
          fallbackResponse,
          attempt,
          "fallback",
          fallbackResponse.status === "error"
            ? classifyFailure(fallbackResponse.errorInfo.code, fallbackResponse.errorInfo.message)
            : undefined,
        );

        appendTraceEvent(this.state, {
          type: "tool_result",
          toolName,
          metadata: { recovery: "fallback", recovered: fallbackResponse.status !== "error" },
        });

        return fallbackResponse as ToolResponse<TOutput>;
      }

      return response;
    }

    if (lastResponse) return lastResponse;
    return errorResponse<TOutput>(
      lastFailure?.code ?? "E_EXECUTION_FAILED",
      toolName,
      input,
      lastFailure?.message ?? ERROR_CODE_META.E_EXECUTION_FAILED.defaultMessage,
      Date.now(),
      0,
    );
  }
}

export { classifyFailure };
