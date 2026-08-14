// ============================================================
// src/tools/errors.ts — ToolError 实现
//
// 工具作者在 run() 中抛出带精确错误码的异常，
// BaseTool.execute 会将其统一转为 error 信封。
// ============================================================

import type { ToolErrorCode } from "../../spec/errors.js";
import { ERROR_CODE_META } from "../../spec/errors.js";

/** 带错误码的工具异常 */
export class ToolError extends Error {
  readonly code: ToolErrorCode;

  constructor(code: ToolErrorCode, message?: string) {
    super(message ?? ERROR_CODE_META[code].defaultMessage);
    this.name = "ToolError";
    this.code = code;
  }
}
