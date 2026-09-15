// ============================================================
// src/server/app.ts — Fastify Channel Adapter（协议层）
//
// 职责仅限协议绑定：路由注册、Fastify 请求 → ChannelRequest
// 转换、ChannelResponse → reply 转换、SSE 流建立与编码、
// 限流/指标/CORS 等传输层中间件。
// 业务逻辑全部在 handlers.ts（不依赖 Fastify），未来可
// 复用于 WebSocket/CLI 等其他 Channel。
// ============================================================

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type {
  AgentChannelAdapter,
  ChannelRequest,
  ChannelResponse,
  ChannelRoute,
} from "../../spec/channel.js";
import { buildChannelRoutes } from "./handlers.js";
import { metrics } from "./metrics.js";
import { getRuntimeFlags } from "./flags.js";
import { checkRateLimit } from "./ratelimit.js";

const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);

export interface ServerOptions {
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

/** Fastify 原生请求 → 协议无关请求 */
function toChannelRequest(req: FastifyRequest): ChannelRequest {
  return {
    method: req.method as ChannelRequest["method"],
    path: req.url.split("?")[0],
    params: (req.params ?? {}) as Record<string, string>,
    query: (req.query ?? {}) as Record<string, string>,
    body: req.body,
    headers: req.headers,
    clientIp: req.ip,
  };
}

/** ChannelResponse → Fastify reply */
function applyChannelResponse(reply: FastifyReply, res: ChannelResponse) {
  if (res.headers) {
    for (const [k, v] of Object.entries(res.headers)) reply.header(k, v);
  }
  return reply.code(res.statusCode ?? 200).send(res.body);
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const rlMax = opts.rateLimitMax ?? RATE_LIMIT_MAX;
  const rlWindow = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;

  app.register(cors, { origin: true });

  // ── 传输层中间件：限流（命中即短路）──
  app.addHook("onRequest", async (req, reply) => {
    if (!getRuntimeFlags().rateLimit) return;
    const r = checkRateLimit(req.ip || "anon", rlMax, rlWindow);
    reply.header("X-RateLimit-Limit", r.limit);
    reply.header("X-RateLimit-Remaining", r.remaining);
    if (!r.ok) {
      metrics.recordRateLimited();
      return reply
        .code(429)
        .send({ error: "rate_limited", message: "请求过于频繁，请稍后再试", resetAt: r.resetAt });
    }
  });

  // ── 传输层中间件：指标采集 ──
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url || req.url.split("?")[0];
    metrics.recordRequest(route, Math.round(reply.elapsedTime), reply.statusCode < 500);
  });

  // ── 绑定 Channel 路由表 ──
  registerRoutes(app, buildChannelRoutes());

  return app;
}

/** 把 ChannelRoute 绑定到 Fastify（普通 + 流式两种形态） */
function registerRoutes(app: FastifyInstance, routes: ChannelRoute[]): void {
  for (const route of routes) {
    if (route.stream) {
      bindStreamRoute(app, route);
    } else if (route.handler) {
      bindPlainRoute(app, route);
    }
  }
}

/** 普通路由：一次请求一次响应 */
function bindPlainRoute(app: FastifyInstance, route: ChannelRoute): void {
  app.route({
    method: route.method,
    url: route.path,
    handler: async (req, reply) => {
      const res = await route.handler!(toChannelRequest(req));
      return applyChannelResponse(reply, res);
    },
  });
}

/**
 * 流式路由（SSE）：emit 首帧时才 hijack 建流；
 * 未 emit 即返回（如校验 400）则按普通响应处理。
 */
function bindStreamRoute(app: FastifyInstance, route: ChannelRoute): void {
  app.route({
    method: route.method,
    url: route.path,
    handler: async (req, reply) => {
      let hijacked = false;

      const emit = (event: string, data: unknown) => {
        if (!hijacked) {
          reply.hijack();
          reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          hijacked = true;
        }
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const res = await route.stream!(toChannelRequest(req), emit);

      if (hijacked) {
        reply.raw.end();
        return reply;
      }
      // 未建立流：以普通响应返回（如参数校验失败）
      if (res) return applyChannelResponse(reply, res);
      return reply.code(500).send({ error: "stream_no_output", message: "流式处理无输出" });
    },
  });
}

/** Fastify 版 Channel Adapter（实现 spec/channel.ts 契约） */
export class FastifyChannelAdapter implements AgentChannelAdapter {
  readonly app: FastifyInstance;

  constructor(opts: ServerOptions = {}) {
    this.app = buildServer(opts);
  }

  register(routes: ChannelRoute[]): void {
    registerRoutes(this.app, routes);
  }

  close(): Promise<void> {
    return this.app.close();
  }
}
