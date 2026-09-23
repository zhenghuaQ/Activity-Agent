// ============================================================
// src/decision/context.ts — 情境感知调权（M2）
//
// 依据「周末 / 天气 / 出发时段 / 敏感人群」动态调整各维度权重：
//   - 周末或敏感人群 → 抬高「人群适配」权重；
//   - 雨雪/高峰 → 抬高「通勤效率」权重；
// 天气来自高德 Weather API（无 Key 或失败 → unknown，不影响主流程）。
// ============================================================

import type { StructuredConstraints } from "../../spec/types.js";
import type { ResolvedLocation } from "../../spec/location.js";
import type {
  DecisionContext,
  ScoringWeights,
  WeatherCondition,
} from "../../spec/decision.js";
import { normalizeWeights, hasVulnerable } from "./weights.js";
import { timeToMinutes } from "../../spec/constraints.js";
import { getAppConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("decision:context");
const AMAP_WEATHER = "https://restapi.amap.com/v3/weather/weatherInfo";

function mapWeather(text: string): WeatherCondition {
  if (/雨/.test(text)) return "rain";
  if (/雪/.test(text)) return "snow";
  if (/(晴)/.test(text)) return "clear";
  return "unknown";
}

/** 高德实时天气（city 可为中文城市名或 adcode）；失败返回 unknown */
async function fetchWeather(city: string): Promise<WeatherCondition> {
  const key = process.env.AMAP_API_KEY;
  if (!key || !getAppConfig().flags.amap || !city) return "unknown";
  try {
    const url = new URL(AMAP_WEATHER);
    url.searchParams.set("key", key);
    url.searchParams.set("city", city);
    url.searchParams.set("extensions", "base");
    const resp = await fetch(url.toString());
    const json = (await resp.json()) as {
      status?: string;
      lives?: Array<{ weather?: string }>;
    };
    const w = json.lives?.[0]?.weather;
    if (json.status !== "1" || !w) return "unknown";
    return mapWeather(w);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "天气获取失败");
    return "unknown";
  }
}

function isWeekendDate(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export interface BuildContextOptions {
  /** 指定参考日期（默认今天），用于判断周末 */
  date?: Date;
  /** 显式覆盖天气（测试/无网用） */
  weather?: WeatherCondition;
  /** Runtime 已解析的环境位置；不从 StructuredConstraints 读取。 */
  environmentLocation?: ResolvedLocation;
}

/** 构建决策情境。会尝试拉取天气（可被 opts.weather 覆盖）。 */
export async function buildContext(
  constraints: StructuredConstraints,
  opts: BuildContextOptions = {}
): Promise<DecisionContext> {
  const date = opts.date ?? new Date();
  const weather =
    opts.weather ?? (await fetchWeather(opts.environmentLocation?.location.city ?? ""));
  const departureHour = Math.floor(
    timeToMinutes(constraints.timeWindow.start) / 60
  );
  return { isWeekend: isWeekendDate(date), weather, departureHour };
}

function isRushHour(hour: number): boolean {
  return (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);
}

/**
 * 依据情境与约束调整权重（在基础权重上乘以系数后归一化）。
 * 纯函数，便于单测与「为什么这样调权」的可解释展示。
 */
export function adjustWeights(
  base: ScoringWeights,
  context: DecisionContext,
  constraints: StructuredConstraints
): { weights: ScoringWeights; notes: string[] } {
  const w = { ...base };
  const notes: string[] = [];

  if (context.isWeekend) {
    w.crowd *= 1.4;
    notes.push("周末客流大 → 提升『人群适配』权重");
  }
  if (hasVulnerable(constraints.group)) {
    w.crowd *= 1.3;
    w.transit *= 1.2;
    notes.push("含老人/儿童 → 提升『人群适配』『通勤效率』权重");
  }
  if (context.weather === "rain" || context.weather === "snow") {
    w.transit *= 1.25;
    w.preference *= 1.1;
    notes.push("雨雪天 → 提升『通勤效率』并偏好室内体验");
  }
  if (isRushHour(context.departureHour)) {
    w.transit *= 1.3;
    notes.push("高峰出发 → 提升『通勤效率』权重");
  }
  if (constraints.group.preferences.budget === "low") {
    w.budget *= 1.3;
    notes.push("预算偏紧 → 提升『预算契合』权重");
  }

  return { weights: normalizeWeights(w), notes };
}
