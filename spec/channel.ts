// ============================================================
// spec/channel.ts — Channel Adapter 契约（SDD）
//
// 目标：把「传输协议」（HTTP/SSE/WebSocket/CLI…）与「业务处理」
// 解耦。业务以统一形态注册 ChannelRoute，各协议提供自己的
// Adapter（如 FastifyChannelAdapter）做绑定。
//
// 分工边界：
//   handlers（业务） → 只见 ChannelRequest/ChannelResponse，
//                       不 import 任何协议框架
//   adapter（协议）  → 路由绑定、参数/请求体解析、SSE 编码、
//                       限流/指标等传输层中间件
// ============================================================

/** 支持的 HTTP 方法（其他协议可映射为等价操作） */
export type ChannelMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// ─── 统一请求 / 响应 ────────────────────────────────────

/** 协议无关的请求（由 adapter 从原生请求转换而来） */
export interface ChannelRequest {
  method: ChannelMethod;
  /** 路由路径（不含 query），如 /api/profiles/:id 的实际路径 */
  path: string;
  /** 路径参数（如 :id） */
  params: Record<string, string>;
  /** 查询参数 */
  query: Record<string, string>;
  /** 请求体（JSON 已解析；GET 为 undefined） */
  body: unknown;
  /** 请求头（小写键） */
  headers: Record<string, string | string[] | undefined>;
  /** 客户端标识（IP 等，用于限流/审计） */
  clientIp?: string;
  /** Aborted when the transport closes before the handler completes. */
  signal?: AbortSignal;
}

/** 协议无关的响应（由 adapter 转换回原生回复） */
export interface ChannelResponse {
  /** HTTP 状态码，缺省 200 */
  statusCode?: number;
  /** 响应体（JSON 序列化或原始字符串） */
  body?: unknown;
  /** 附加响应头 */
  headers?: Record<string, string>;
}

// ─── 处理器 ────────────────────────────────────────────

/** 普通处理器：一次请求一次响应 */
export type ChannelHandler = (req: ChannelRequest) => Promise<ChannelResponse>;

/**
 * 流式事件发射器：首帧发送前由 adapter 建立流（HTTP 即 hijack +
 * SSE 头），业务不感知协议细节。
 */
export type ChannelEmitter = (event: string, data: unknown) => void | Promise<void>;

/**
 * 流式处理器：通过 emit 逐事件推送。
 * 返回 ChannelResponse 表示「未开始流，直接以普通响应返回」
 * （如参数校验 400）；一旦 emit 过，返回值将被忽略。
 */
export type ChannelStreamHandler = (
  req: ChannelRequest,
  emit: ChannelEmitter
) => Promise<void | ChannelResponse>;

// ─── 路由注册 ──────────────────────────────────────────

/** 一条路由的注册描述（stream 与 handler 二选一） */
export interface ChannelRoute {
  method: ChannelMethod;
  /** 路径模板（Fastify 风格参数 :id，adapter 负责翻译） */
  path: string;
  /** 普通处理器 */
  handler?: ChannelHandler;
  /** 流式处理器（提供时按流式路由绑定，如 SSE） */
  stream?: ChannelStreamHandler;
  /** 用途说明（文档/调试用） */
  summary?: string;
}

// ─── Adapter 接口 ──────────────────────────────────────

/**
 * 通道适配器：把 ChannelRoute 绑定到具体协议。
 * 各协议 listen 形态差异大，由具体 adapter 自行提供。
 */
export interface AgentChannelAdapter {
  /** 绑定路由表（可多次调用） */
  register(routes: ChannelRoute[]): void;
  /** 优雅关闭 */
  close(): Promise<void>;
}
