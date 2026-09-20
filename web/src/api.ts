// ============================================================
// web/src/api.ts — 后端 API 封装
//
// 同步决策 / SSE 流式决策 / 画像 / 分层 / 指标 / 降级开关。
// 开发态由 Vite proxy 转发到 localhost:3000。
// ============================================================

import { parseDecisionResponse, parseDecisionStage } from "../../spec/decision-response.js";
import { parseFollowUpRequest, type FollowUpRequest, type FollowUpSelection } from "../../spec/follow-up.js";
import type { PlanningConversation } from "../../spec/conversation.js";
import type {
  DecideRequest,
  DoneEvent,
  ErrorEvent,
  HealthInfo,
  MetricsSnapshot,
  RuntimeFlags,
  SegmentInfo,
  StageEvent,
  UserProfile,
} from "./types.js";

const BASE = "";

// ─── 同步决策 ────────────────────────────────────────

export type DecideResponse = DoneEvent;

export async function decide(req: DecideRequest): Promise<DecideResponse> {
  const res = await fetch(`${BASE}/api/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  return parseDecisionResponse(await res.json());
}

// ─── SSE 流式决策 ────────────────────────────────────

export interface StreamHandlers {
  onFollowUp?: (request: FollowUpRequest) => void;
  onStage: (e: StageEvent) => void;
  onDone: (e: DoneEvent) => void;
  onError: (e: ErrorEvent) => void;
}

export function streamDecide(
  params: { q: string; segment?: SegmentInfo["segment"]; weather?: string; sessionId?: string },
  handlers: StreamHandlers
): () => void {
  const url = new URL(`${BASE}/api/decide/stream`, window.location.origin);
  url.searchParams.set("q", params.q);
  if (handlers.onFollowUp) url.searchParams.set("interactive", "1");
  if (params.segment) url.searchParams.set("segment", params.segment);
  if (params.weather) url.searchParams.set("weather", params.weather);
  if (params.sessionId) url.searchParams.set("sessionId", params.sessionId);

  const es = new EventSource(url.toString());
  let finished = false;
  const close = () => { finished = true; es.close(); };
  const fail = (message: string) => { if (finished) return; close(); handlers.onError({ message }); };

  es.addEventListener("stage", (ev) => {
    if (finished) return;
    try {
      handlers.onStage(parseDecisionStage(JSON.parse((ev as MessageEvent).data)));
    } catch {
      fail("规划进度解析失败，请重试");
    }
  });

  es.addEventListener("follow_up", (ev) => {
    if (finished) return;
    try { handlers.onFollowUp?.(parseFollowUpRequest(JSON.parse((ev as MessageEvent).data))); }
    catch { fail("追问内容解析失败，请重新开始"); }
  });

  es.addEventListener("done", (ev) => {
    if (finished) return;
    try {
      const result = parseDecisionResponse(JSON.parse((ev as MessageEvent).data));
      close();
      handlers.onDone(result);
    } catch {
      fail("决策结果解析失败，请重试");
    }
  });

  es.addEventListener("error", (ev) => {
    // readyState=CLOSED 通常是 done 后正常关闭，忽略
    if (finished) return;
    // 网络错误/后端 down：error 事件无 data，直接报连接异常
    let message = "连接异常，请确认后端服务可用";
    if ("data" in ev && typeof ev.data === "string") {
      try {
        const payload = JSON.parse(ev.data);
        if (payload && typeof payload.message === "string") message = payload.message;
      } catch { /* 非 JSON 错误仍显示连接提示 */ }
    }
    fail(message);
  });

  return close;
}

export async function getConversation(id: string): Promise<PlanningConversation | undefined> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createConversation(id: string): Promise<PlanningConversation> {
  const res = await fetch(`${BASE}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function confirmConversationPlan(id: string, version: number, planId: string): Promise<PlanningConversation> {
  const res = await fetch(`${BASE}/api/conversations/${encodeURIComponent(id)}/confirm`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version, planId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  return body;
}

export async function answerFollowUp(request: FollowUpRequest, answers: FollowUpSelection[], signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/api/decide/answer`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ sessionId: request.sessionId, runId: request.runId, requestId: request.requestId, answers }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  if (body.accepted !== true || body.requestId !== request.requestId) throw new Error("回答确认失败，请重试");
}

// ─── 分层 ────────────────────────────────────────────

export async function listSegments(): Promise<SegmentInfo[]> {
  const res = await fetch(`${BASE}/api/segments`);
  return res.json();
}

// ─── 画像 CRUD ────────────────────────────────────────

export async function listProfiles(): Promise<UserProfile[]> {
  const res = await fetch(`${BASE}/api/profiles`);
  return res.json();
}

export async function getProfile(id: string): Promise<UserProfile> {
  const res = await fetch(`${BASE}/api/profiles/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function createProfile(body: {
  id: string;
  name?: string;
  segment?: SegmentInfo["segment"];
  override?: UserProfile["override"];
}): Promise<UserProfile> {
  const res = await fetch(`${BASE}/api/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function deleteProfile(id: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE}/api/profiles/${id}`, { method: "DELETE" });
  return res.json();
}

// ─── 指标 ────────────────────────────────────────────

export async function getMetrics(): Promise<MetricsSnapshot> {
  const res = await fetch(`${BASE}/api/metrics`);
  return res.json();
}

// ─── 运行时降级开关 ──────────────────────────────────

export async function getFlags(): Promise<RuntimeFlags> {
  const res = await fetch(`${BASE}/api/admin/flags`);
  return res.json();
}

export async function setFlags(patch: Partial<RuntimeFlags>): Promise<RuntimeFlags> {
  const res = await fetch(`${BASE}/api/admin/flags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json();
}

// ─── 健康 ────────────────────────────────────────────

export async function getHealth(): Promise<HealthInfo> {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}
