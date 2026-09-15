// ============================================================
// src/server/handlers.ts — Channel 业务处理器
//
// 全部处理器只依赖 spec/channel.ts 契约与业务模块，
// 不 import 任何协议框架（Fastify/WebSocket/…）。
// 由 adapter（app.ts）把路由表绑定到具体传输协议。
// ============================================================

import type {
  ChannelRequest,
  ChannelResponse,
  ChannelRoute,
} from "../../spec/channel.js";
import type { StructuredConstraints } from "../../spec/types.js";
import type { UserProfile, UserSegment } from "../../spec/profile.js";
import type { WeatherCondition } from "../../spec/decision.js";
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
import { getOpenApiSpec } from "./openapi.js";
import { defaultRuntimeEventBus } from "../runtime/event-bus.js";
import { newAgentId } from "../../spec/agent.js";
import { createAgentInput, createSubmission, defaultAgentRuntime } from "../runtime/index.js";
import { SWAGGER_HTML } from "./swagger-html.js";

// ─── 内部工具 ──────────────────────────────────────────

interface DecideBody {
  text?: string;
  sessionId?: string;
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

function badRequest(message: string): ChannelResponse {
  return { statusCode: 400, body: { error: "bad_request", message } };
}

/** HTTP Channel 提供可选的 Session ID；未提供时为本次请求创建独立会话，避免不同用户共享默认 Session。 */
function resolveSessionId(
  req: ChannelRequest,
  explicit?: string,
): string {
  return explicit?.trim() || req.headers["x-session-id"]?.toString().trim() || newAgentId("sess");
}

// ─── 处理器 ────────────────────────────────────────────

/** 健康检查 */
async function health(_req: ChannelRequest): Promise<ChannelResponse> {
  const cfg = getAppConfig();
  return {
    body: {
      status: "ok",
      version: process.env.npm_package_version || "1.0.0",
      env: cfg.env,
      flags: cfg.flags,
      runtime: getRuntimeFlags(),
      uptimeMs: Date.now() - metrics.startedAt,
    },
  };
}

/** 同步决策 */
async function decide(req: ChannelRequest): Promise<ChannelResponse> {
  const body = (req.body || {}) as DecideBody;
  if (!body.text || !body.text.trim()) {
    return badRequest("缺少 text");
  }
  const profile = await resolveRequestProfile(body.profileId, body.segment);
  const sessionId = resolveSessionId(req, body.sessionId);
  const result = await defaultAgentRuntime.submit(
    createAgentInput(body.text, {
      profile,
      autoSegment: body.autoSegment,
      weather: body.weather,
      parseFn: pickParseFn(),
    }),
    { sessionId, op: { type: "turn" } },
  );

  if (!result.result || typeof result.result !== "object") {
    return {
      statusCode: result.status === "rejected" ? 409 : 500,
      body: { error: result.error || "runtime_execution_failed", submissionId: result.submissionId },
    };
  }

  const pipelineResult = result.result as {
    success: boolean;
    message: string;
    state: import("../../spec/types.js").PlanningState;
  };
  metrics.recordDecision(isDegraded(pipelineResult.state));

  return {
    body: {
      submissionId: result.submissionId,
      sessionId: result.sessionId,
      runId: result.runId,
      success: pipelineResult.success,
      message: pipelineResult.message,
      constraints: pipelineResult.state.constraints,
      decision: pipelineResult.state.decision,
      selectedPlan: pipelineResult.state.selectedPlan,
      notes: pipelineResult.state.planningNotes ?? [],
    },
  };
}

/** SSE 流式决策 */
async function decideStream(
  req: ChannelRequest,
  emit: (event: string, data: unknown) => void
): Promise<void | ChannelResponse> {
  const q = (req.query.q || "").trim();
  if (!q) return badRequest("缺少查询参数 q");

  const segment = req.query.segment as UserSegment | undefined;
  const weather = req.query.weather as WeatherCondition | undefined;

  const traceId = newAgentId("trace");
  const subscription = defaultRuntimeEventBus.subscribe(traceId);
  try {
    const profile = await resolveRequestProfile(undefined, segment);
    const sessionId = resolveSessionId(req, req.query.sessionId);
    const submission = createSubmission(
      createAgentInput(q, {
        profile,
        weather,
        parseFn: pickParseFn(),
      }),
      { sessionId, traceId, op: { type: "turn" } },
    );
    const runPromise = defaultAgentRuntime.submitSubmission(submission);

    // SSE 现在消费 Runtime Event，而不是把 Pipeline callback 当作主通信机制。
    for await (const event of subscription) {
      if (event.type === "stage_update") {
        const metadata = event.metadata ?? {};
        emit("stage", {
          stage: metadata.stage,
          index: metadata.index,
          total: metadata.total,
          message: String(metadata.stage ?? ""),
          data: metadata.data,
        });
      } else {
        emit("runtime", event);
      }
      if (event.type === "final") break;
    }

    const submissionResult = await runPromise;
    const result = submissionResult.result as {
      success: boolean;
      message: string;
      state: import("../../spec/types.js").PlanningState;
    };
    metrics.recordDecision(isDegraded(result.state));
    emit("done", {
      submissionId: submissionResult.submissionId,
      submissionTraceId: traceId,
      success: result.success,
      message: result.message,
      decision: result.state.decision,
      selectedPlan: result.state.selectedPlan,
      notes: result.state.planningNotes ?? [],
    });
  } catch (err) {
    emit("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    subscription.close();
    defaultRuntimeEventBus.closeTrace(traceId);
  }
}

/** 分层列表 */
async function segments(_req: ChannelRequest): Promise<ChannelResponse> {
  return {
    body: ALL_SEGMENTS.map((s) => {
      const sp = getSegmentProfile(s);
      return { segment: sp.segment, label: sp.label, description: sp.description };
    }),
  };
}

/** 画像列表 */
async function listProfiles(_req: ChannelRequest): Promise<ChannelResponse> {
  return { body: await getProfileStore().list() };
}

/** 创建/更新画像 */
async function upsertProfile(req: ChannelRequest): Promise<ChannelResponse> {
  const body = (req.body || {}) as ProfileBody;
  if (!body.id) return badRequest("缺少 id");
  const profile = createProfile({
    id: body.id,
    name: body.name,
    segment: body.segment,
    override: body.override,
  });
  await getProfileStore().upsert(profile);
  return { body: profile };
}

/** 获取画像 */
async function getProfile(req: ChannelRequest): Promise<ChannelResponse> {
  const p = await getProfileStore().get(req.params.id);
  if (!p) return { statusCode: 404, body: { error: "not_found" } };
  return { body: p };
}

/** 删除画像 */
async function removeProfile(req: ChannelRequest): Promise<ChannelResponse> {
  const ok = await getProfileStore().remove(req.params.id);
  return { body: { ok } };
}

/** 指标快照 */
async function getMetrics(_req: ChannelRequest): Promise<ChannelResponse> {
  return { body: metrics.snapshot() };
}

/** 读取运行时开关 */
async function getFlags(_req: ChannelRequest): Promise<ChannelResponse> {
  return { body: getRuntimeFlags() };
}

/** 设置运行时开关 */
async function setFlags(req: ChannelRequest): Promise<ChannelResponse> {
  return { body: setRuntimeFlags((req.body || {}) as Partial<RuntimeFlags>) };
}

/** OpenAPI 规范 */
async function openapi(_req: ChannelRequest): Promise<ChannelResponse> {
  return { body: getOpenApiSpec(process.env.npm_package_version || "1.0.0") };
}

/** Swagger UI */
async function docs(_req: ChannelRequest): Promise<ChannelResponse> {
  return {
    statusCode: 200,
    headers: { "content-type": "text/html" },
    body: SWAGGER_HTML,
  };
}

// ─── 路由表 ────────────────────────────────────────────

/** 全部 Channel 路由（adapter 据此绑定具体协议） */
export function buildChannelRoutes(): ChannelRoute[] {
  return [
    { method: "GET", path: "/health", handler: health, summary: "健康检查" },
    { method: "POST", path: "/api/decide", handler: decide, summary: "同步决策" },
    { method: "GET", path: "/api/decide/stream", stream: decideStream, summary: "SSE 流式决策" },
    { method: "GET", path: "/api/segments", handler: segments, summary: "分层列表" },
    { method: "GET", path: "/api/profiles", handler: listProfiles, summary: "画像列表" },
    { method: "POST", path: "/api/profiles", handler: upsertProfile, summary: "创建画像" },
    { method: "GET", path: "/api/profiles/:id", handler: getProfile, summary: "获取画像" },
    { method: "DELETE", path: "/api/profiles/:id", handler: removeProfile, summary: "删除画像" },
    { method: "GET", path: "/api/metrics", handler: getMetrics, summary: "指标快照" },
    { method: "GET", path: "/api/admin/flags", handler: getFlags, summary: "读取降级开关" },
    { method: "POST", path: "/api/admin/flags", handler: setFlags, summary: "设置降级开关" },
    { method: "GET", path: "/openapi.json", handler: openapi, summary: "OpenAPI 规范" },
    { method: "GET", path: "/docs", handler: docs, summary: "Swagger UI" },
  ];
}
