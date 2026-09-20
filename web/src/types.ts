// ============================================================
// web/src/types.ts — 前端类型定义（与 spec/ 对齐，仅保留 UI 所需）
//
// 决策数据直接复用共享契约，避免前后端字段漂移。
import type { ScoreDimension, WeatherCondition } from "../../spec/decision.js";
export type {
  ScoreDimension, PlanObjective, DimensionScore, PlanScore,
  PlanExplanation, DecisionResult, WeatherCondition,
} from "../../spec/decision.js";
export type { PlanCandidate, Plan, Activity, ActivityType, PlanningStage } from "../../spec/types.js";
export type { DecisionResponse as DoneEvent, DecisionStage as StageEvent } from "../../spec/decision-response.js";
export type { PlanningConversation, ConversationTurn, ConversationPlanVersion } from "../../spec/conversation.js";

// ─── 画像契约（spec/profile.ts） ─────────────────────

export type UserSegment =
  | "balanced"
  | "family_first"
  | "comfort_senior"
  | "quality_seeker"
  | "budget_conscious"
  | "explorer"
  | "efficiency";

export interface UserProfile {
  id: string;
  name?: string;
  segment: UserSegment;
  override: UserPreferenceOverride;
  stats: ProfileStats;
  createdAt: number;
  updatedAt: number;
}

export interface UserPreferenceOverride {
  weights?: Partial<Record<ScoreDimension, number>>;
  budget?: "low" | "medium" | "high";
  maxDistanceKm?: number;
  dietaryRestrictions?: string[];
  preferredCuisine?: string[];
}

export interface ProfileStats {
  decisionCount: number;
  lastActiveAt: number;
}

export interface SegmentInfo {
  segment: UserSegment;
  label: string;
  description: string;
}

// ─── SSE 展示事件 ───────────────────────────────────

export interface ErrorEvent {
  message: string;
}

// ─── 指标（server/metrics.ts snapshot） ──────────────

export interface MetricsSnapshot {
  runtime?: { activeRuns: number; sessions: number; queued: number; rejected: number };
  subscribers?: { subscribers: number; pending: number; delivered: number; failed: number; rejected: number; processingMs: number };
  uptimeMs: number;
  requests: number;
  errors: number;
  decisions: number;
  degraded: number;
  rateLimited: number;
  latency: { avgMs: number; p95Ms: number; samples: number };
  routes: Record<string, { count: number; errors: number; avgMs: number }>;
}

// ─── 运行时降级开关（server/flags.ts） ───────────────

export interface RuntimeFlags {
  rateLimit: boolean;
  forceMockIntent: boolean;
  cache: boolean;
}

// ─── 决策请求体（server/app.ts DecideBody） ──────────

export interface DecideRequest {
  text: string;
  segment?: UserSegment;
  profileId?: string;
  autoSegment?: boolean;
  weather?: WeatherCondition;
}

// ─── 健康检查（server/app.ts /health） ──────────────

export interface HealthInfo {
  status: string;
  version: string;
  env: string;
  flags: unknown;
  runtime: RuntimeFlags;
  uptimeMs: number;
}
