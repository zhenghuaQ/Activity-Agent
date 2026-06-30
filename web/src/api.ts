// ============================================================
// web/src/api.ts — 后端 API 封装
//
// 同步决策 / SSE 流式决策 / 画像 / 分层 / 指标 / 降级开关。
// 开发态由 Vite proxy 转发到 localhost:3000。
// ============================================================

import type {
  DecideRequest,
  DecisionResult,
  DoneEvent,
  ErrorEvent,
  HealthInfo,
  MetricsSnapshot,
  Plan,
  RuntimeFlags,
  SegmentInfo,
  StageEvent,
  UserProfile,
} from "./types.js";

const BASE = "";

// ─── 同步决策 ────────────────────────────────────────

export interface DecideResponse {
  success: boolean;
  message: string;
  constraints: unknown;
  decision?: DecisionResult;
  selectedPlan?: Plan;
  notes: string[];
}

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
  return res.json();
}

// ─── SSE 流式决策 ────────────────────────────────────

export interface StreamHandlers {
  onStage: (e: StageEvent) => void;
  onDone: (e: DoneEvent) => void;
  onError: (e: ErrorEvent) => void;
}

export function streamDecide(
  params: { q: string; segment?: SegmentInfo["segment"]; weather?: string },
  handlers: StreamHandlers
): () => void {
  const url = new URL(`${BASE}/api/decide/stream`, window.location.origin);
  url.searchParams.set("q", params.q);
  if (params.segment) url.searchParams.set("segment", params.segment);
  if (params.weather) url.searchParams.set("weather", params.weather);

  const es = new EventSource(url.toString());

  es.addEventListener("stage", (ev) => {
    try {
      handlers.onStage(JSON.parse((ev as MessageEvent).data));
    } catch {
      console.warn("Failed to parse SSE stage event");
    }
  });

  es.addEventListener("done", (ev) => {
    try {
      handlers.onDone(JSON.parse((ev as MessageEvent).data));
    } catch {
      console.warn("Failed to parse SSE stage event");
    }
    es.close();
  });

  es.addEventListener("error", () => {
    // readyState=CLOSED 通常是 done 后正常关闭，忽略
    if (es.readyState === EventSource.CLOSED) return;
    // 网络错误/后端 down：error 事件无 data，直接报连接异常
    handlers.onError({ message: "连接异常，请确认后端服务可用" });
    es.close();
  });

  return () => es.close();
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
