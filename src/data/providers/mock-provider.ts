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
  ActivityDataProviderV1,
  BreakPlaceQuery,
  DestinationQuery,
  PlaceQuery,
  ProviderCapabilities,
  ProviderContext,
  SearchArea,
} from "../../../spec/datasource.js";
import type { PlaceSearchRequest, PlaceSearchResult } from "../../../spec/place-search.js";
import { filterWithinRadius } from "../../core/geo.js";
import { ATTRACTIONS, BREAK_PLACES, HOME, RESTAURANTS } from "../mock.js";
import { DataProviderError } from "../provider-error.js";
import { requireSearchCity, searchCenter, withProviderSource } from "../provider-utils.js";
import { searchPlacePool } from "../place-search.js";

export interface MockProviderOptions {
  attractions?: Attraction[];
  restaurants?: Restaurant[];
  breakPlaces?: BreakPlace[];
  destinationCenters?: Record<string, GeoLocation>;
}

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

export class MockProvider implements ActivityDataProviderV1 {
  private readonly attractions: Attraction[];
  private readonly restaurants: Restaurant[];
  private readonly breakPlaces: BreakPlace[];
  private readonly destinationCenters: Record<string, GeoLocation>;

  constructor(options: MockProviderOptions = {}) {
    this.attractions = options.attractions ?? ATTRACTIONS;
    this.restaurants = options.restaurants ?? RESTAURANTS;
    this.breakPlaces = options.breakPlaces ?? BREAK_PLACES;
    this.destinationCenters = { ...(options.destinationCenters ?? { 北京: HOME }) };
  }

  readonly apiVersion = 1 as const;
  readonly id = "mock";
  readonly name = "mock";
  readonly capabilities: ProviderCapabilities = { places: true, destinationResolution: true, attractions: true,
    restaurants: true, breakPlaces: true, geocoding: true, lookupById: true };

  async resolveDestination(query: DestinationQuery, _context?: ProviderContext): Promise<SearchArea> {
    const configuredCity = Object.keys(this.destinationCenters).find((city) =>
      query.city.includes(city) || city.includes(query.city));
    if (!configuredCity) {
      throw new DataProviderError("destination_unsupported", `MockProvider 不包含该目的地演示数据，不支持：${query.city}`, this.id);
    }
    const configuredCenter = this.destinationCenters[configuredCity];
    const center = query.coordinates
      ? { ...configuredCenter, ...query.coordinates, city: query.city, district: query.district, address: `${query.city}${query.district ?? ""}（演示中心点）` }
      : { ...configuredCenter, city: query.city, district: query.district ?? configuredCenter.district };
    return { destination: { ...query }, center, providerAreaId: `mock-${configuredCity}`, confidence: 1 };
  }

  async searchPlaces(request: PlaceSearchRequest, _context?: ProviderContext): Promise<PlaceSearchResult> {
    const origin = request.spatial.origin;
    const all = [...this.attractions, ...this.restaurants, ...this.breakPlaces];
    const nearby = withProviderSource(this.id, filterWithinRadius(origin, all, request.spatial.maxKm));
    return searchPlacePool(nearby, request);
  }

  async searchAttractions(query: PlaceQuery, _context?: ProviderContext): Promise<Attraction[]> {
    requireSearchCity(this.id, ["北京"], query);
    const result = await this.searchPlaces({
      spatial: { origin: searchCenter(query), maxKm: query.radiusKm },
      intent: { categories: ["attraction"] },
    });
    let list = result.places.map((candidate) => candidate.detail).filter((place): place is Attraction => place.type === "attraction");
    list = list.filter(
      (a) =>
        matchKeywords(a.name, a.address, query.keywords) &&
        matchLocalFeatures(a, query.localFeatures)
    );
    list.sort((a, b) => a.distanceKm - b.distanceKm);
    return withProviderSource(this.id, query.limit ? list.slice(0, query.limit) : list);
  }

  async searchRestaurants(query: PlaceQuery, _context?: ProviderContext): Promise<Restaurant[]> {
    requireSearchCity(this.id, ["北京"], query);
    const result = await this.searchPlaces({
      spatial: { origin: searchCenter(query), maxKm: query.radiusKm },
      intent: { categories: ["restaurant"] },
    });
    let list = result.places.map((candidate) => candidate.detail).filter((place): place is Restaurant => place.type === "restaurant");
    list = list.filter(
      (r) =>
        matchKeywords(r.name, r.address, query.keywords) &&
        matchLocalFeatures(r, query.localFeatures)
    );
    list.sort((a, b) => a.distanceKm - b.distanceKm);
    return withProviderSource(this.id, query.limit ? list.slice(0, query.limit) : list);
  }

  async searchBreakPlaces(query: BreakPlaceQuery, _context?: ProviderContext): Promise<BreakPlace[]> {
    requireSearchCity(this.id, ["北京"], query);
    const result = await this.searchPlaces({
      spatial: { origin: searchCenter(query), maxKm: query.radiusKm },
      intent: { categories: ["break", ...(query.breakSubtype ? [query.breakSubtype] : [])] },
    });
    let list = result.places.map((candidate) => candidate.detail).filter((place): place is BreakPlace => place.type === "break");
    if (query.breakSubtype) {
      list = list.filter((b) => b.breakSubtype === query.breakSubtype);
    }
    list = list.filter(
      (b) =>
        matchKeywords(b.name, b.address, query.keywords) &&
        matchLocalFeatures(b, query.localFeatures)
    );
    list.sort((a, b) => a.distanceKm - b.distanceKm);
    return withProviderSource(this.id, query.limit ? list.slice(0, query.limit) : list);
  }

  async getAttractionById(id: string, _context?: ProviderContext): Promise<Attraction | undefined> {
    const value = this.attractions.find((a) => a.id === id);
    return value ? withProviderSource(this.id, [value])[0] : undefined;
  }

  async getRestaurantById(id: string, _context?: ProviderContext): Promise<Restaurant | undefined> {
    const value = this.restaurants.find((r) => r.id === id);
    return value ? withProviderSource(this.id, [value])[0] : undefined;
  }

  async geocode(address: string, _context?: ProviderContext): Promise<GeoLocation | null> {
    // Mock 无地理编码服务：命中已知地点名则返回其坐标，否则交由上层降级
    const all = [...this.attractions, ...this.restaurants, ...this.breakPlaces];
    const hit = all.find(
      (p) => p.address.includes(address) || address.includes(p.name)
    );
    return hit ? { ...hit.location } : null;
  }
}
