// ============================================================
// src/data/providers/mock-provider.ts — 内置 Mock 数据源
//
// 包装 src/data/mock.ts 的静态数组，对外实现 DataSource 接口。
// 关键改造：distanceKm 不再读静态字段，而是相对 query.origin 用
// Haversine 实时重算并按距离升序——保证换出发点后距离正确。
// 零网络依赖，作为所有 Provider 的最终降级兜底。
// ============================================================

import type {
  Attraction,
  BreakPlace,
  GeoLocation,
  Restaurant,
} from "../../../spec/types.js";
import type {
  BreakPlaceQuery,
  DataSource,
  PlaceQuery,
} from "../../../spec/datasource.js";
import { filterWithinRadius } from "../../core/geo.js";
import { ATTRACTIONS, BREAK_PLACES, RESTAURANTS } from "../mock.js";

function matchKeywords(name: string, address: string, keywords?: string[]): boolean {
  if (!keywords || keywords.length === 0) return true;
  const hay = (name + " " + address).toLowerCase();
  return keywords.some((k) => hay.includes(k.toLowerCase()));
}

function matchLocalFeatures<T extends { localFeatures: string[] }>(
  item: T,
  features?: string[]
): boolean {
  if (!features || features.length === 0) return true;
  return item.localFeatures.some((f) => features.includes(f));
}

export class MockProvider implements DataSource {
  readonly name = "mock";

  async searchAttractions(query: PlaceQuery, _signal?: AbortSignal): Promise<Attraction[]> {
    let list = filterWithinRadius(query.origin, ATTRACTIONS, query.radiusKm);
    list = list.filter(
      (a) =>
        matchKeywords(a.name, a.address, query.keywords) &&
        matchLocalFeatures(a, query.localFeatures)
    );
    return query.limit ? list.slice(0, query.limit) : list;
  }

  async searchRestaurants(query: PlaceQuery, _signal?: AbortSignal): Promise<Restaurant[]> {
    let list = filterWithinRadius(query.origin, RESTAURANTS, query.radiusKm);
    list = list.filter(
      (r) =>
        matchKeywords(r.name, r.address, query.keywords) &&
        matchLocalFeatures(r, query.localFeatures)
    );
    return query.limit ? list.slice(0, query.limit) : list;
  }

  async searchBreakPlaces(query: BreakPlaceQuery, _signal?: AbortSignal): Promise<BreakPlace[]> {
    let list = filterWithinRadius(query.origin, BREAK_PLACES, query.radiusKm);
    if (query.breakSubtype) {
      list = list.filter((b) => b.breakSubtype === query.breakSubtype);
    }
    list = list.filter(
      (b) =>
        matchKeywords(b.name, b.address, query.keywords) &&
        matchLocalFeatures(b, query.localFeatures)
    );
    return query.limit ? list.slice(0, query.limit) : list;
  }

  async getAttractionById(id: string, _signal?: AbortSignal): Promise<Attraction | undefined> {
    return ATTRACTIONS.find((a) => a.id === id);
  }

  async getRestaurantById(id: string, _signal?: AbortSignal): Promise<Restaurant | undefined> {
    return RESTAURANTS.find((r) => r.id === id);
  }

  async geocode(address: string, _signal?: AbortSignal): Promise<GeoLocation | null> {
    // Mock 无地理编码服务：命中已知地点名则返回其坐标，否则交由上层降级
    const all = [...ATTRACTIONS, ...RESTAURANTS, ...BREAK_PLACES];
    const hit = all.find(
      (p) => p.address.includes(address) || address.includes(p.name)
    );
    return hit ? { ...hit.location } : null;
  }
}
