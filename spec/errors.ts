// ============================================================
// spec/errors.ts — 工具错误码契约（SDD）
//
// 统一为字符串错误码：机器可判、模型可读。
// 每条码附带 category（错误分类）与 retryable（模型据此决定是否重试）。
// ============================================================

/** 错误分类 */
export type ErrorCategory = "resource" | "param" | "execution" | "state" | "network";

/** 工具错误码 */
export type ToolErrorCode =
  // 资源相关
  | "E_RESOURCE_NOT_FOUND" // 资源不存在（景点/餐厅 ID 无效）
  | "E_RESOURCE_EXHAUSTED" // 资源耗尽（无余票/无座位）
  | "E_DESTINATION_UNSUPPORTED" // 当前 Provider 不支持该目的地
  // 参数相关
  | "E_PARAM_MISSING" // 缺少必需参数
  | "E_PARAM_INVALID" // 参数非法（类型/取值/格式错误）
  // 执行相关
  | "E_EXECUTION_FAILED" // 执行失败（未分类的运行时错误）
  | "E_EXECUTION_TIMEOUT" // 执行超时
  // 状态相关
  | "E_STATE_CONFLICT" // 状态冲突（前置条件不满足）
  // 网络相关
  | "E_NETWORK_UNAVAILABLE" // 网络不可用/上游服务不可达
  | "E_RATE_LIMITED" // 触发限流
  | "E_CIRCUIT_OPEN"; // Runtime 熔断：近期上游持续失败，暂时拒绝调用

/** 工具错误信息（ToolResponse 中 errorInfo 字段的结构） */
export interface ToolErrorInfo {
  code: ToolErrorCode;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
}

/** 错误码元数据表：分类 + 是否可重试 + 默认文案 */
export const ERROR_CODE_META: Record<
  ToolErrorCode,
  { category: ErrorCategory; retryable: boolean; defaultMessage: string }
> = {
  E_RESOURCE_NOT_FOUND: {
    category: "resource",
    retryable: false,
    defaultMessage: "资源不存在",
  },
  E_RESOURCE_EXHAUSTED: {
    category: "resource",
    retryable: true,
    defaultMessage: "资源已耗尽（无余票/无座位）",
  },
  E_DESTINATION_UNSUPPORTED: {
    category: "resource",
    retryable: false,
    defaultMessage: "当前地点数据源不支持该目的地",
  },
  E_PARAM_MISSING: {
    category: "param",
    retryable: false,
    defaultMessage: "缺少必需参数",
  },
  E_PARAM_INVALID: {
    category: "param",
    retryable: false,
    defaultMessage: "参数非法",
  },
  E_EXECUTION_FAILED: {
    category: "execution",
    retryable: true,
    defaultMessage: "执行失败",
  },
  E_EXECUTION_TIMEOUT: {
    category: "execution",
    retryable: true,
    defaultMessage: "执行超时",
  },
  E_STATE_CONFLICT: {
    category: "state",
    retryable: false,
    defaultMessage: "状态冲突",
  },
  E_NETWORK_UNAVAILABLE: {
    category: "network",
    retryable: true,
    defaultMessage: "网络不可用",
  },
  E_RATE_LIMITED: {
    category: "network",
    retryable: true,
    defaultMessage: "触发限流",
  },
  E_CIRCUIT_OPEN: {
    category: "state",
    retryable: false,
    defaultMessage: "工具当前处于熔断状态，请稍后重试",
  },
};
