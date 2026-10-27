// ============================================================
// spec/profile.ts — 用户画像契约（SDD，M3）
//
// 个性化闭环：用户分层(segment) → 权重先验(乘子) → 自定义覆盖 →
// 最终权重喂给 M2 决策引擎的 weightOverride；同一句话不同画像得到差异化决策。
// 画像本地 JSON 持久化（store.ts），无账户体系，零配置可演示。
// ============================================================

import type { ScoringWeights } from "./decision.js";
import type { DietaryRequirement } from "./dietary.js";

// ─── 用户分层 ──────────────────────────────────────────

export type UserSegment =
  | "balanced" // 均衡型（默认）
  | "family_first" // 亲子优先
  | "comfort_senior" // 舒适陪老
  | "quality_seeker" // 品质体验党
  | "budget_conscious" // 精打细算
  | "explorer" // 尝鲜打卡
  | "efficiency"; // 高效省时

/** 某分层的权重先验与默认参数 */
export interface SegmentProfile {
  segment: UserSegment;
  label: string;
  description: string;
  /** 相对 DEFAULT_WEIGHTS 的乘子（>1 提升，<1 降低；缺省维度按 1） */
  weightMultipliers: Partial<ScoringWeights>;
  /** 该分层的默认偏好（可被用户覆盖 / 请求覆盖） */
  defaults?: {
    budget?: "low" | "medium" | "high";
    maxDistanceKm?: number;
  };
}

// ─── 自定义覆盖 ────────────────────────────────────────

/** 用户手动调参（优先级最高，覆盖分层先验） */
export interface UserPreferenceOverride {
  /** 直接指定的维度权重（绝对值，未归一也可，引擎会归一） */
  weights?: Partial<ScoringWeights>;
  budget?: "low" | "medium" | "high";
  maxDistanceKm?: number;
  dietaryRestrictions?: DietaryRequirement[];
  preferredCuisine?: string[];
}

// ─── 画像 ──────────────────────────────────────────────

export interface ProfileStats {
  /** 累计决策次数 */
  decisionCount: number;
  /** 最近活跃时间戳 */
  lastActiveAt: number;
}

export interface UserProfile {
  id: string;
  name?: string;
  segment: UserSegment;
  override: UserPreferenceOverride;
  stats: ProfileStats;
  createdAt: number;
  updatedAt: number;
}

/** 持久化文件结构（带版本号便于演进） */
export interface ProfileStoreFile {
  version: 1;
  profiles: Record<string, UserProfile>;
}
