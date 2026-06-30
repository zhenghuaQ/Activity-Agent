// ============================================================
// src/server/app.ts — Fastify 网关（决策 API 数据底座）
//
// 提供：同步决策 /api/decide、SSE 流式决策 /api/decide/stream、
// 画像 CRUD、分层列表、指标、运行时降级开关、OpenAPI/Swagger。
// 全局挂载：限流（可热切）+ 指标采集 + CORS。
// 注意：本服务只做决策，不含任何下单/支付/履约接口。
// ============================================================

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { StructuredConstraints } from "../../spec/types.js";
import type { UserProfile, UserSegment } from "../../spec/profile.js";
import type { WeatherCondition } from "../../spec/decision.js";
import { runFullPipeline, runFullPipelineStreaming } from "../planner/engine.js";
import { parseIntent } from "../intent/parser.js";
import {
  ALL_SEGMENTS,
  getSegmentProfile,
  createProfile,
  getProfileStore,
} from "../profile/index.js";
import { getAppConfig } from "../core/config.js";
import { metrics } from "./metrics.js";
import { getRuntimeFlags, setRuntimeFlags, type RuntimeFlags } from "./flags.js";
import { checkRateLimit } from "./ratelimit.js";
import { getOpenApiSpec } from "./openapi.js";
import { SWAGGER_HTML } from "./swagger-html.js";

const VERSION = process.env.npm_package_version || "1.0.0";
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 120);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);

interface DecideBody {
  text?: string;
  segment?: UserSegment;
  profileId?: string;
  autoSegment?: boolean;
  weather?: WeatherCondition;
}

interface ProfileBody {
  id?: string;
  name?: string;
  segment?: UserSegment;
  override?: UserProfile["override"];
}

/** 解析请求所用画像：profileId 优先，其次 segment 临时画像 */
async function resolveRequestProfile(
  profileId?: string,
  segment?: UserSegment
): Promise<UserProfile | undefined> {
  if (profileId) {
    const p = await getProfileStore().get(profileId);
    if (p) return p;
  }
  if (segment) return createProfile({ id: "_req", segment });
  return undefined;
}

/** 选择意图解析函数：降级开关开启 → 关键词 Mock；否则 LLM（无 Key 自动降级） */
function pickParseFn(): ((t: string) => StructuredConstraints) | undefined {
  return getRuntimeFlags().forceMockIntent ? parseIntent : undefined;
}

function isDegraded(state: { planningNotes?: string[] }): boolean {
  return (state.planningNotes?.length ?? 0) > 0 || getRuntimeFlags().forceMockIntent;
}

export interface ServerOptions {
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
}

export function buildServer(opts: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const rlMax = opts.rateLimitMax ?? RATE_LIMIT_MAX;
  const rlWindow = opts.rateLimitWindowMs ?? RATE_LIMIT_WINDOW_MS;

  app.register(cors, { origin: true });

  // ── 全局：限流（命中即短路，return reply 终止生命周期）──
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

  // ── 全局：指标采集 ──
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url || req.url.split("?")[0];
    metrics.recordRequest(route, Math.round(reply.elapsedTime), reply.statusCode < 500);
  });

  // ── 健康检查 ──
  app.get("/health", async () => {
    const cfg = getAppConfig();
    return {
      status: "ok",
      version: VERSION,
      env: cfg.env,
      flags: cfg.flags,
      runtime: getRuntimeFlags(),
      uptimeMs: Date.now() - metrics.startedAt,
    };
  });

  // ── 同步决策 ──
  app.post<{ Body: DecideBody }>("/api/decide", async (req, reply) => {
    const body = req.body || {};
    if (!body.text || !body.text.trim()) {
      return reply.code(400).send({ error: "bad_request", message: "缺少 text" });
    }
    const profile = await resolveRequestProfile(body.profileId, body.segment);
    const result = await runFullPipeline(body.text, pickParseFn(), {
      profile,
      autoSegment: body.autoSegment,
      weather: body.weather,
    });
    metrics.recordDecision(isDegraded(result.state));

    return {
      success: result.success,
      message: result.message,
      constraints: result.state.constraints,
      decision: result.state.decision,
      selectedPlan: result.state.selectedPlan,
      notes: result.state.planningNotes ?? [],
    };
  });

  // ── SSE 流式决策 ──
  app.get<{ Querystring: { q?: string; segment?: UserSegment; weather?: WeatherCondition } }>(
    "/api/decide/stream",
    async (req, reply) => {
      const q = (req.query.q || "").trim();
      if (!q) return reply.code(400).send({ error: "bad_request", message: "缺少查询参数 q" });

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const send = (event: string, data: unknown) => {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const profile = await resolveRequestProfile(undefined, req.query.segment);
        const result = await runFullPipelineStreaming(
          q,
          pickParseFn(),
          { profile, weather: req.query.weather },
          (e) => send("stage", e)
        );
        metrics.recordDecision(isDegraded(result.state));
        send("done", {
          success: result.success,
          message: result.message,
          decision: result.state.decision,
          selectedPlan: result.state.selectedPlan,
          notes: result.state.planningNotes ?? [],
        });
      } catch (err) {
        send("error", { message: err instanceof Error ? err.message : String(err) });
      } finally {
        raw.end();
      }
    }
  );

  // ── 分层列表 ──
  app.get("/api/segments", async () => {
    return ALL_SEGMENTS.map((s) => {
      const sp = getSegmentProfile(s);
      return { segment: sp.segment, label: sp.label, description: sp.description };
    });
  });

  // ── 画像 CRUD ──
  app.get("/api/profiles", async () => getProfileStore().list());

  app.post<{ Body: ProfileBody }>("/api/profiles", async (req, reply) => {
    const body = req.body || {};
    if (!body.id) return reply.code(400).send({ error: "bad_request", message: "缺少 id" });
    const profile = createProfile({
      id: body.id,
      name: body.name,
      segment: body.segment,
      override: body.override,
    });
    await getProfileStore().upsert(profile);
    return profile;
  });

  app.get<{ Params: { id: string } }>("/api/profiles/:id", async (req, reply) => {
    const p = await getProfileStore().get(req.params.id);
    if (!p) return reply.code(404).send({ error: "not_found" });
    return p;
  });

  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (req) => {
    const ok = await getProfileStore().remove(req.params.id);
    return { ok };
  });

  // ── 指标 ──
  app.get("/api/metrics", async () => metrics.snapshot());

  // ── 运行时降级开关 ──
  app.get("/api/admin/flags", async () => getRuntimeFlags());
  app.post<{ Body: Partial<RuntimeFlags> }>("/api/admin/flags", async (req) => {
    return setRuntimeFlags(req.body || {});
  });

  // ── OpenAPI / Swagger ──
  app.get("/openapi.json", async () => getOpenApiSpec(VERSION));
  app.get("/docs", async (_req, reply) => {
    reply.type("text/html").send(SWAGGER_HTML);
  });

  return app;
}
