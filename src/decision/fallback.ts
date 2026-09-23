// ============================================================
// src/decision/fallback.ts — 分级异常兜底（M2）
//
// 候选不足时分级降级，避免「搜不到就空手而归」：
//   L1 扩半径   —— 逐步放大检索半径；
//   L2 放宽过滤 —— 清空软过滤（人群标签/当地特色）再搜一次；
//   L3 熔断     —— 仍无结果则返回空 + 明确 note，由上层提示用户。
// 这里提供与具体工具解耦的通用升级器，引擎按数据类型套用。
// ============================================================

export interface EscalationResult<O> {
  items: O[];
  /** 最终生效半径（km） */
  radiusUsed: number;
  /** 是否触发了扩半径 */
  escalated: boolean;
  /** 过程说明 */
  note?: string;
}

export interface EscalationOptions {
  /** 期望至少拿到的数量 */
  minCount?: number;
  /** 半径上限（km） */
  maxRadius?: number;
  /** 每步放大系数 */
  factor?: number;
  /** 最大尝试步数 */
  maxSteps?: number;
}

interface DistanceInput {
  distance: { maxKm: number };
  origin: unknown;
}

export interface SpatialInput {
  spatial: { origin: unknown; maxKm: number };
}

export async function withSpatialRadiusEscalation<I extends SpatialInput, O>(
  baseInput: I,
  run: (input: I) => Promise<O[]>,
  opts: EscalationOptions = {},
): Promise<EscalationResult<O>> {
  const minCount = opts.minCount ?? 1;
  const maxRadius = opts.maxRadius ?? 30;
  const factor = opts.factor ?? 1.6;
  const maxSteps = opts.maxSteps ?? 3;
  let radius = baseInput.spatial.maxKm;
  let items = await run(baseInput);
  if (items.length >= minCount) return { items, radiusUsed: radius, escalated: false };
  for (let step = 0; step < maxSteps && radius < maxRadius; step++) {
    radius = Math.min(maxRadius, Math.round(radius * factor));
    const input = { ...baseInput, spatial: { ...baseInput.spatial, maxKm: radius } } as I;
    items = await run(input);
    if (items.length >= minCount) return { items, radiusUsed: radius, escalated: true, note: `候选不足，已扩检索半径至 ${radius}km` };
  }
  return { items, radiusUsed: radius, escalated: radius > baseInput.spatial.maxKm,
    note: items.length === 0 ? `半径扩至 ${radius}km 仍无结果（已熔断，建议放宽条件）` : `半径扩至 ${radius}km` };
}

/**
 * L1：半径升级。clone 输入、逐步放大 distance.maxKm 调用 run，
 * 直到结果数 ≥ minCount 或半径达上限。
 */
export async function withRadiusEscalation<I extends DistanceInput, O>(
  baseInput: I,
  run: (input: I) => Promise<O[]>,
  opts: EscalationOptions = {}
): Promise<EscalationResult<O>> {
  const minCount = opts.minCount ?? 1;
  const maxRadius = opts.maxRadius ?? 30;
  const factor = opts.factor ?? 1.6;
  const maxSteps = opts.maxSteps ?? 3;

  let radius = baseInput.distance.maxKm;
  let items = await run(baseInput);
  if (items.length >= minCount) {
    return { items, radiusUsed: radius, escalated: false };
  }

  for (let step = 0; step < maxSteps && radius < maxRadius; step++) {
    radius = Math.min(maxRadius, Math.round(radius * factor));
    const input = {
      ...baseInput,
      distance: { ...baseInput.distance, maxKm: radius },
    } as I;
    items = await run(input);
    if (items.length >= minCount) {
      return {
        items,
        radiusUsed: radius,
        escalated: true,
        note: `候选不足，已扩检索半径至 ${radius}km`,
      };
    }
  }

  return {
    items,
    radiusUsed: radius,
    escalated: radius > baseInput.distance.maxKm,
    note:
      items.length === 0
        ? `半径扩至 ${radius}km 仍无结果（已熔断，建议放宽条件）`
        : `半径扩至 ${radius}km`,
  };
}
