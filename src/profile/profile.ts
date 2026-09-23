// ============================================================
// src/profile/profile.ts — 画像派生逻辑
//
// 职责：
//   resolveWeights        画像 → 最终评分权重（先验乘子 + 自定义覆盖 → 归一）
//   inferSegment          从约束启发式推断分层（无显式画像时）
//   applyProfileToConstraints  把画像默认/自定义偏好并入本次约束
//   createProfile / touchProfileStats  画像创建与活跃统计
// 纯函数为主，便于单测与「为什么这样推荐」的可解释。
// ============================================================

import type { StructuredConstraints } from "../../spec/types.js";
import type { ScoringWeights } from "../../spec/decision.js";
import type {
  UserProfile,
  UserPreferenceOverride,
  UserSegment,
} from "../../spec/profile.js";
import { ALL_DIMENSIONS, DEFAULT_WEIGHTS } from "../../spec/decision.js";
import { normalizeWeights } from "../decision/weights.js";
import { getSegmentProfile } from "./segments.js";

/**
 * 画像 → 最终权重：默认权重 × 分层乘子 → 应用自定义绝对权重 → 归一化。
 */
export function resolveWeights(profile: UserProfile): ScoringWeights {
  const seg = getSegmentProfile(profile.segment);
  const w: ScoringWeights = { ...DEFAULT_WEIGHTS };

  for (const d of ALL_DIMENSIONS) {
    w[d] *= seg.weightMultipliers[d] ?? 1;
  }

  const custom = profile.override.weights;
  if (custom) {
    for (const d of ALL_DIMENSIONS) {
      if (typeof custom[d] === "number") w[d] = custom[d] as number;
    }
  }

  return normalizeWeights(w);
}

/**
 * 无显式画像时，从约束启发式推断分层。
 * 敏感人群优先（老人 > 孩子），其次预算信号，再次打卡意图。
 */
export function inferSegment(constraints: StructuredConstraints): UserSegment {
  const g = constraints.group;
  const p = g.preferences;

  if (g.ageGroup.seniors > 0) return "comfort_senior";
  if (g.ageGroup.youngChildren > 0) return "family_first";
  if (p.budget === "low") return "budget_conscious";
  if (p.budget === "high") return "quality_seeker";

  const hints = (constraints.extraHints ?? []).join(" ");
  if (/打卡|拍照|网红|探店/.test(hints)) return "explorer";

  return "balanced";
}

/**
 * 把画像的默认/自定义偏好并入本次约束。
 * 优先级：用户自定义覆盖 > 本次请求 > 分层默认。
 */
export function applyProfileToConstraints(
  constraints: StructuredConstraints,
  profile: UserProfile
): StructuredConstraints {
  const seg = getSegmentProfile(profile.segment);
  const ov: UserPreferenceOverride = profile.override;

  const budget =
    ov.budget ?? constraints.group.preferences.budget ?? seg.defaults?.budget;

  // 距离：显式自定义优先；否则用分层默认作为「上限」收紧（只缩不放，
  // 避免把亲子/陪老等人群拖得过远），无默认则保持请求值。
  const requestDistance = constraints.distance.preferredMaxKm ?? constraints.distance.hardMaxKm;
  const preferredMaxKm = ov.maxDistanceKm
    ?? (seg.defaults?.maxDistanceKm !== undefined && requestDistance !== undefined
      ? Math.min(requestDistance, seg.defaults.maxDistanceKm)
      : seg.defaults?.maxDistanceKm ?? constraints.distance.preferredMaxKm);

  const dietary = Array.from(
    new Set([
      ...constraints.group.preferences.dietaryRestrictions,
      ...(ov.dietaryRestrictions ?? []),
    ])
  );
  const cuisine =
    ov.preferredCuisine ?? constraints.group.preferences.preferredCuisine;

  return {
    ...constraints,
    group: {
      ...constraints.group,
      preferences: {
        ...constraints.group.preferences,
        budget,
        dietaryRestrictions: dietary,
        preferredCuisine: cuisine,
      },
    },
    distance: { ...constraints.distance, preferredMaxKm },
  };
}

/** 创建新画像（带时间戳与零统计） */
export function createProfile(input: {
  id: string;
  name?: string;
  segment?: UserSegment;
  override?: UserPreferenceOverride;
}): UserProfile {
  const now = Date.now();
  return {
    id: input.id,
    name: input.name,
    segment: input.segment ?? "balanced",
    override: input.override ?? {},
    stats: { decisionCount: 0, lastActiveAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

/** 记一次决策活跃（返回新对象，不可变） */
export function touchProfileStats(profile: UserProfile): UserProfile {
  const now = Date.now();
  return {
    ...profile,
    stats: {
      decisionCount: profile.stats.decisionCount + 1,
      lastActiveAt: now,
    },
    updatedAt: now,
  };
}
