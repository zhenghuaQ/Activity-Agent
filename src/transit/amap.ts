// ============================================================
// src/transit/amap.ts — 高德地图 Directions API 集成
// 用于真实通勤预估，替代 spec/transit.ts 中的 mock 算法
// ============================================================

import type { GeoLocation } from "../../spec/types.js";
import type {
  TransitEstimate,
  TransitRoute,
  CongestionLevel,
} from "../../spec/transit.js";
import { mockEstimateTransit } from "../../spec/transit.js";
import type { AmapDrivingResponse } from "../../spec/tool-data.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("transit:amap");

function getAmapConfig(): { apiKey: string; enabled: boolean } {
  const apiKey = process.env.AMAP_API_KEY || "";
  return { apiKey, enabled: !!apiKey };
}

/**
 * 调用高德驾车路径规划 API 进行真实通勤预估。
 * API Key 未配置时自动降级为 mock。
 */
export async function estimateTransitWithAmap(
  from: GeoLocation,
  to: GeoLocation,
  departureTime: string
): Promise<TransitEstimate> {
  const config = getAmapConfig();

  if (!config.enabled) {
    return mockEstimateTransit(from, to, departureTime);
  }

  try {
    const url = new URL("https://restapi.amap.com/v3/direction/driving");
    url.searchParams.set("key", config.apiKey);
    url.searchParams.set("origin", `${from.lng},${from.lat}`);
    url.searchParams.set("destination", `${to.lng},${to.lat}`);
    url.searchParams.set("strategy", "0");
    url.searchParams.set("extensions", "all");

    const resp = await fetch(url.toString());
    const json: AmapDrivingResponse = await resp.json();

    if (json.status !== "1" || !json.route?.paths?.length) {
      log.warn({ status: json.status }, "高德返回异常，降级 Mock 通勤");
      return mockEstimateTransit(from, to, departureTime);
    }

    const path = json.route.paths[0];
    const distanceKm = Math.round(parseInt(path.distance, 10) / 100) / 10;
    const totalMinutes = Math.round(parseInt(path.duration, 10) / 60);

    let congestionLevel: CongestionLevel = "smooth";
    const steps = path.steps || [];
    const slowSteps = steps.filter((s) => {
      const tmcs = s.tmcs || [];
      return tmcs.some((t) => t.status && t.status !== "0");
    });
    if (slowSteps.length > steps.length * 0.5) congestionLevel = "congested";
    else if (slowSteps.length > 0) congestionLevel = "slow";

    const best: TransitRoute = {
      distanceKm,
      congestionLevel,
      estimatedMinutes: totalMinutes,
      congestionDelayMinutes: Math.round(totalMinutes * (congestionLevel === "congested" ? 0.3 : congestionLevel === "slow" ? 0.15 : 0)),
      description: from.address + " -> " + to.address,
    };

    const bufferMinutes = Math.max(5, Math.round(totalMinutes * 0.2));

    log.debug(
      { from: from.address, to: to.address, totalMinutes, distanceKm, congestionLevel },
      "高德通勤估算"
    );

    return {
      from,
      to,
      departureTime,
      routes: [best],
      best,
      bufferMinutes,
      totalMinutes: totalMinutes + bufferMinutes,
    };
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "高德请求失败，降级 Mock 通勤");
    return mockEstimateTransit(from, to, departureTime);
  }
}