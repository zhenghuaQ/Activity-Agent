// ============================================================
// spec/datasource.ts — 开放位置/POI Provider 契约 v1
// ============================================================

import type { Attraction, BreakPlace, BreakSubtype, GeoLocation, LocalFeatureTag, Restaurant } from "./types.js";

export const ACTIVITY_DATA_PROVIDER_API_VERSION = 1 as const;

export interface DestinationQuery {
  city: string;
  district?: string;
  /** 接入方已知目的地中心点时可直接提供，避免再次地理编码。 */
  coordinates?: Pick<GeoLocation, "lat" | "lng">;
}

/** Provider 将自然语言目的地归一化后的检索范围。 */
export interface SearchArea {
  destination: DestinationQuery;
  center: GeoLocation;
  /** Provider 可识别的行政区编码。 */
  providerAreaId?: string;
  confidence: number;
}

export interface ProviderCapabilities {
  destinationResolution: boolean;
  attractions: boolean;
  restaurants: boolean;
  breakPlaces: boolean;
  geocoding: boolean;
  lookupById: boolean;
}

export interface ProviderContext { signal?: AbortSignal; requestId?: string }

export type DataProviderErrorCode = "destination_unsupported" | "invalid_response"
  | "authentication_failed" | "rate_limited" | "network_unavailable" | "capability_unsupported";

export interface ProviderSource { providerId: string; externalId: string; fetchedAt: number }

/**
 * `searchArea` 存在时必须以它为检索区域，不能静默回退到其他城市；
 * `origin` 是该区域内计算 distanceKm 与首段通勤的起点。
 */
export interface PlaceQuery {
  origin: GeoLocation;
  destination?: DestinationQuery;
  searchArea?: SearchArea;
  radiusKm: number;
  keywords?: string[];
  localFeatures?: LocalFeatureTag[];
  limit?: number;
}

export interface BreakPlaceQuery extends PlaceQuery { breakSubtype?: BreakSubtype }

export type CrowdLevel = "low" | "medium" | "high" | "packed";
export interface CrowdPrediction {
  placeId: string;
  level: CrowdLevel;
  estimatedWaitMinutes: number;
  confidence: number;
  factors: string[];
}

/** 社区 Provider 的稳定只读 SPI；实现方无需依赖 Planner、Runtime 或传输层。 */
export interface ActivityDataProviderV1 {
  readonly apiVersion: typeof ACTIVITY_DATA_PROVIDER_API_VERSION;
  readonly id: string;
  /** @deprecated 兼容旧观测字段；新代码使用 id。 */
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  resolveDestination(query: DestinationQuery, context?: ProviderContext): Promise<SearchArea>;
  searchAttractions(query: PlaceQuery, context?: ProviderContext): Promise<Attraction[]>;
  searchRestaurants(query: PlaceQuery, context?: ProviderContext): Promise<Restaurant[]>;
  searchBreakPlaces(query: BreakPlaceQuery, context?: ProviderContext): Promise<BreakPlace[]>;
  getAttractionById(id: string, context?: ProviderContext): Promise<Attraction | undefined>;
  getRestaurantById(id: string, context?: ProviderContext): Promise<Restaurant | undefined>;
  geocode(address: string, context?: ProviderContext): Promise<GeoLocation | null>;
}

/** @deprecated 使用 ActivityDataProviderV1。 */
export type DataSource = ActivityDataProviderV1;
