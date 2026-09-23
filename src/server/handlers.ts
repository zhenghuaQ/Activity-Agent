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
import {
  defaultAgentEventBus,
  type AgentEventBus,
} from "../runtime/event-bus.js";
import { newAgentId, type AgentRunContextInput } from "../../spec/agent.js";
import type { LocationRequest } from "../../spec/location.js";
import {
  createAgentInput,
  createSubmission,
  defaultAgentRuntime,
  type AgentRuntime,
  type SubmissionResult,
} from "../runtime/index.js";
import { SWAGGER_HTML } from "./swagger-html.js";
import { SseAgentEventSubscriber } from "./subscribers/sse-agent-event-subscriber.js";
import { parseFollowUpSelections } from "../../spec/follow-up.js";
import { linkAbortSignal } from "../runtime/abort.js";
import { defaultConversationStore, type ConversationStore } from "../conversation/store.js";
import { ConversationMemorySubscriber } from "../conversation/subscriber.js";

// ─── 内部工具 ──────────────────────────────────────────

interface DecideBody {
  text?: string;
  sessionId?: string;
  segment?: UserSegment;
  profileId?: string;
  autoSegment?: boolean;
  weather?: WeatherCondition;
  context?: AgentRunContextInput;
}

interface ProfileBody {
  id?: string;
  name?: string;
  segment?: UserSegment;
  override?: UserProfile["override"];
}

export interface HandlerDependencies {
  runtime: Pick<AgentRuntime, "submit" | "submitSubmission">;
  eventBus: AgentEventBus;
  createId: (prefix: string) => string;
  conversationStore?: Pick<ConversationStore, "get" | "list" | "getOrCreate" | "appendTurn" | "setPendingQuestion" | "checkpointConstraints" | "completePlan" | "confirmPlan">;
}

const DEFAULT_DEPENDENCIES: HandlerDependencies = {
  runtime: defaultAgentRuntime,
  eventBus: defaultAgentEventBus,
  createId: newAgentId,
};

const conversations = (deps: HandlerDependencies) => deps.conversationStore ?? defaultConversationStore;

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

function isLocationRequest(value: unknown): value is LocationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  switch (request.kind) {
    case "coords":
      return typeof request.lat === "number" && Number.isFinite(request.lat)
        && typeof request.lng === "number" && Number.isFinite(request.lng);
    case "address":
      return typeof request.address === "string" && request.address.trim().length > 0;
    case "ip":
      return request.ip === undefined || typeof request.ip === "string";
    case "default":
      return true;
    default:
      return false;
  }
}

function isAgentRunContext(value: unknown): value is AgentRunContextInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return context.location === undefined || isLocationRequest(context.location);
}

/** Optional stream-query adapter; it never infers location from proxy headers. */
function locationContextFromQuery(query: Record<string, string>): AgentRunContextInput | null | undefined {
  const lat = query.lat;
  const lng = query.lng;
  const address = query.address;
  const ip = query.ip;
  const supplied = [lat !== undefined || lng !== undefined, address !== undefined, ip !== undefined].filter(Boolean).length;
  if (supplied === 0) return undefined;
  if (supplied !== 1) return null;
  if (lat !== undefined || lng !== undefined) {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
    return { location: { kind: "coords", lat: parsedLat, lng: parsedLng, ...(query.city ? { city: query.city } : {}) } };
  }
  if (address !== undefined && address.trim()) return { location: { kind: "address", address: address.trim(), ...(query.city ? { city: query.city } : {}) } };
  if (ip !== undefined) return { location: { kind: "ip", ...(ip ? { ip } : {}) } };
  return null;
}

/** HTTP Channel 提供可选的 Session ID；未提供时为本次请求创建独立会话，避免不同用户共享默认 Session。 */
function resolveSession(
  req: ChannelRequest,
  explicit?: string,
  createId: (prefix: string) => string = newAgentId,
): { sessionId: string; sessionRetention: "retained" | "ephemeral" } {
  const supplied = explicit?.trim() || req.headers["x-session-id"]?.toString().trim();
  return supplied
    ? { sessionId: supplied, sessionRetention: "retained" }
    : { sessionId: createId("sess"), sessionRetention: "ephemeral" };
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
async function decide(
  req: ChannelRequest,
  deps: HandlerDependencies,
): Promise<ChannelResponse> {
  const body = (req.body || {}) as DecideBody;
  if (typeof body.text !== "string" || !body.text.trim()) {
    return badRequest("缺少 text");
  }
  if (body.text.length > 8000 || (body.segment !== undefined && !ALL_SEGMENTS.includes(body.segment))
    || (body.sessionId !== undefined && typeof body.sessionId !== "string")
    || (body.profileId !== undefined && typeof body.profileId !== "string")
    || (body.context !== undefined && !isAgentRunContext(body.context))
    || (body.autoSegment !== undefined && typeof body.autoSegment !== "boolean")
    || (body.weather !== undefined && !["clear", "rain", "snow", "hot", "cold", "unknown"].includes(body.weather))) return badRequest("决策参数无效");
  const profile = await resolveRequestProfile(body.profileId, body.segment);
  const session = resolveSession(req, body.sessionId, deps.createId);
  const conversation = await conversations(deps).getOrCreate(session.sessionId, body.text);
  await conversations(deps).appendTurn(session.sessionId, "user", "text", body.text);
  const result = await deps.runtime.submit(
    createAgentInput(body.text, {
      profile,
      autoSegment: body.autoSegment,
      weather: body.weather,
      parseFn: pickParseFn(),
      baseConstraints: conversation.memory.constraints,
      context: body.context,
    }),
    { ...session, op: { type: "turn" }, signal: req.signal },
  );

  if (!result.result || typeof result.result !== "object") {
    return {
      statusCode: result.status === "rejected" ? 429 : result.error === "submission_deadline_exceeded" ? 504 : 500,
      body: { error: result.error || "runtime_execution_failed", message: result.error || "规划失败，请重试", submissionId: result.submissionId },
    };
  }

  const pipelineResult = result.result as {
    success: boolean;
    message: string;
    state: import("../../spec/types.js").PlanningState;
  };
  metrics.recordDecision(isDegraded(pipelineResult.state));
  let planVersion: number | undefined;
  if (result.runId && pipelineResult.state.constraints && pipelineResult.state.decision && pipelineResult.state.selectedPlan) {
    const updated = await conversations(deps).completePlan(session.sessionId, result.runId,
      pipelineResult.state.constraints, pipelineResult.state.decision, pipelineResult.state.selectedPlan, pipelineResult.message);
    planVersion = updated.memory.currentPlanVersion;
  }

  return {
    body: {
      submissionId: result.submissionId,
      sessionId: result.sessionId,
      runId: result.runId,
      traceId: result.traceId,
      conversationId: session.sessionId,
      planVersion,
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
async function answerFollowUp(req: ChannelRequest, deps: HandlerDependencies): Promise<ChannelResponse> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || !["sessionId", "runId", "requestId"].every(key => typeof body[key] === "string" && (body[key] as string).trim().length > 0 && (body[key] as string).length <= 200)) return badRequest("追问标识无效");
  let answers;
  try { answers = parseFollowUpSelections(body.answers); }
  catch { return badRequest("请为每个问题选择一个有效答案"); }
  const result = await deps.runtime.submit("", { sessionId: body.sessionId as string, signal: req.signal,
    op: { type: "answer", runId: body.runId as string, requestId: body.requestId as string, answers } });
  if (result.status !== "completed") return { statusCode: result.error === "invalid_follow_up_answers" ? 400 : 409,
    body: { error: result.error, message: result.error === "invalid_follow_up_answers" ? "回答与当前问题不匹配，请重新选择" : "追问已失效、已提交或运行已结束，请重新开始" } };
  await conversations(deps).setPendingQuestion(body.sessionId as string, undefined).catch(() => undefined);
  await conversations(deps).appendTurn(body.sessionId as string, "user", "choice",
    `已回答：${answers.flatMap(answer => answer.selectedValues).join("、")}`).catch(() => undefined);
  return { body: result.result };
}

async function decideStream(
  req: ChannelRequest,
  emit: import("../../spec/channel.js").ChannelEmitter,
  deps: HandlerDependencies,
): Promise<void | ChannelResponse> {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return badRequest("缺少查询参数 q");
  if (req.query.sessionId !== undefined && typeof req.query.sessionId !== "string") return badRequest("sessionId 无效");
  if (req.query.interactive !== undefined && !["0", "1"].includes(req.query.interactive)) return badRequest("interactive 无效");
  if (q.length > 8000 || (req.query.segment && !ALL_SEGMENTS.includes(req.query.segment as UserSegment))
    || (req.query.weather && !["clear", "rain", "snow", "hot", "cold", "unknown"].includes(req.query.weather))) return badRequest("决策参数无效");
  const context = locationContextFromQuery(req.query);
  if (context === null) return badRequest("location 参数无效");

  const segment = req.query.segment as UserSegment | undefined;
  const weather = req.query.weather as WeatherCondition | undefined;

  const traceId = deps.createId("trace");
  const linked = linkAbortSignal(req.signal);
  let conversationId: string | undefined;
  const subscriber = new SseAgentEventSubscriber(traceId, emit);
  const subscription = deps.eventBus.subscribe(subscriber);
  const memorySubscription = deps.eventBus.subscribe(
    new ConversationMemorySubscriber(traceId, conversations(deps)),
  );
  try {
    const profile = await resolveRequestProfile(undefined, segment);
    const session = resolveSession(req, req.query.sessionId, deps.createId);
    conversationId = session.sessionId;
    const conversation = await conversations(deps).getOrCreate(session.sessionId, q);
    await conversations(deps).appendTurn(session.sessionId, "user", "text", q);
    const submission = createSubmission(
      createAgentInput(q, {
        profile,
        weather,
        parseFn: pickParseFn(),
        interactive: req.query.interactive === "1",
        baseConstraints: conversation.memory.constraints,
        context,
      }),
      {
        ...session,
        traceId,
        op: { type: "turn" },
        signal: linked.controller.signal,
      },
    );
    const runPromise = deps.runtime.submitSubmission(submission);
    const settled = await Promise.race([
      subscriber.waitForFinal().then(() => "final" as const),
      runPromise.then(() => "result" as const),
    ]);
    const submissionResult: SubmissionResult = await runPromise;
    if (req.signal?.aborted) return;
    subscription.close();
    memorySubscription.close();
    const [delivery] = await Promise.all([subscription.drain(), memorySubscription.drain()]);
    if (delivery.failed || delivery.rejected) throw delivery.lastError;
    if (settled === "result" && !subscriber.hasFinal) {
      await subscriber.fail(
        submissionResult.error ?? "runtime_finished_without_final_event",
        submissionResult.submissionId,
      );
      return;
    }
    if (!submissionResult.result || typeof submissionResult.result !== "object") {
      await subscriber.fail(
        submissionResult.error ?? "runtime_execution_failed",
        submissionResult.submissionId,
      );
      return;
    }
    const result = submissionResult.result as {
      success: boolean;
      message: string;
      state: import("../../spec/types.js").PlanningState;
    };
    metrics.recordDecision(isDegraded(result.state));
    let planVersion: number | undefined;
    if (submissionResult.runId && result.state.constraints && result.state.decision && result.state.selectedPlan) {
      const updated = await conversations(deps).completePlan(session.sessionId, submissionResult.runId,
        result.state.constraints, result.state.decision, result.state.selectedPlan, result.message);
      planVersion = updated.memory.currentPlanVersion;
    }
    await subscriber.complete({
      submissionId: submissionResult.submissionId,
      sessionId: submissionResult.sessionId,
      runId: submissionResult.runId,
      traceId,
      conversationId: session.sessionId,
      planVersion,
      success: result.success,
      message: result.message,
      decision: result.state.decision,
      selectedPlan: result.state.selectedPlan,
      constraints: result.state.constraints,
      notes: result.state.planningNotes ?? [],
    });
  } catch (err) {
    if (!req.signal?.aborted) {
      await subscriber.fail(err instanceof Error ? err.message : String(err));
    }
  } finally {
    subscription.close();
    memorySubscription.close();
    await memorySubscription.drain().catch(() => undefined);
    if (conversationId) await conversations(deps).setPendingQuestion(conversationId, undefined).catch(() => undefined);
    linked.controller.abort(new Error("stream_closed"));
    linked.dispose();
  }
}

async function listConversations(_req: ChannelRequest, deps: HandlerDependencies): Promise<ChannelResponse> {
  const values = await conversations(deps).list();
  return { body: values.map(value => ({ id: value.id, title: value.title, updatedAt: value.updatedAt,
    currentPlanVersion: value.memory.currentPlanVersion, acceptedPlanVersion: value.memory.acceptedPlanVersion })) };
}

async function getConversation(req: ChannelRequest, deps: HandlerDependencies): Promise<ChannelResponse> {
  const value = await conversations(deps).get(req.params.id);
  return value ? { body: value } : { statusCode: 404, body: { error: "conversation_not_found", message: "会话不存在" } };
}

async function createConversation(req: ChannelRequest, deps: HandlerDependencies): Promise<ChannelResponse> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : deps.createId("conversation");
  if (id.length > 200) return badRequest("会话 ID 无效");
  return { statusCode: 201, body: await conversations(deps).getOrCreate(id) };
}

async function confirmConversationPlan(req: ChannelRequest, deps: HandlerDependencies): Promise<ChannelResponse> {
  const body = req.body as { version?: unknown; planId?: unknown } | undefined;
  const version = body?.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) return badRequest("方案版本无效");
  if (body?.planId !== undefined && (typeof body.planId !== "string" || !body.planId)) return badRequest("候选方案 ID 无效");
  try { return { body: await conversations(deps).confirmPlan(req.params.id, version as number, body?.planId as string | undefined) }; }
  catch (error) { return { statusCode: 409, body: { error: error instanceof Error ? error.message : String(error),
    message: "只能确认当前方案版本" } }; }
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
  return { body: { ...metrics.snapshot(), runtime: defaultAgentRuntime.router.snapshot(), subscribers: defaultAgentEventBus.snapshot?.() } };
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
export function buildChannelRoutes(
  deps: HandlerDependencies = DEFAULT_DEPENDENCIES,
): ChannelRoute[] {
  return [
    { method: "GET", path: "/health", handler: health, summary: "健康检查" },
    {
      method: "POST",
      path: "/api/decide",
      handler: (req) => decide(req, deps),
      summary: "同步决策",
    },
    {
      method: "GET",
      path: "/api/decide/stream",
      stream: (req, emit) => decideStream(req, emit, deps),
      summary: "SSE 流式决策",
    },
    { method: "GET", path: "/api/segments", handler: segments, summary: "分层列表" },
    { method: "POST", path: "/api/decide/answer", handler: req => answerFollowUp(req, deps), summary: "提交追问回答并继续原运行" },
    { method: "GET", path: "/api/conversations", handler: req => listConversations(req, deps), summary: "会话列表" },
    { method: "POST", path: "/api/conversations", handler: req => createConversation(req, deps), summary: "创建可恢复会话" },
    { method: "GET", path: "/api/conversations/:id", handler: req => getConversation(req, deps), summary: "恢复会话" },
    { method: "POST", path: "/api/conversations/:id/confirm", handler: req => confirmConversationPlan(req, deps), summary: "确认当前方案" },
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
