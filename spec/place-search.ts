// ============================================================
// spec/place-search.ts — 通用地点搜索契约
//
// Search Layer 只理解空间约束、开放式地点类别与搜索意图。
// Planner 的 plan role（如 meal/rest）不进入 Provider contract。
// ============================================================

import type { GeoLocation, Place } from "./types.js";
import type { ProviderSource } from "./datasource.js";

export interface SearchSpatialConstraint {
  /** 本次搜索实际使用的中心点，由 Planner 决定。 */
  origin: GeoLocation;
  /** 搜索半径，统一使用 km。 */
  maxKm: number;
}

export interface PlaceSearchFilters {
  minRating?: number;
  priceLevels?: number[];
  cuisines?: string[];
  openAt?: string;
}

export interface PlaceSearchIntent {
  query?: string;
  /** Provider 自己映射的 canonical category，不限制为固定枚举。 */
  categories?: string[];
  requiredTags?: string[];
  preferredTags?: string[];
  excludedTags?: string[];
  filters?: PlaceSearchFilters;
}

export interface PlaceSearchRequest {
  spatial: SearchSpatialConstraint;
  intent: PlaceSearchIntent;
  /** 执行参数，不属于用户意图。 */
  limit?: number;
}

export interface PlaceSearchTask {
  /** Planner slot/用途，例如 primary_activity、meal、rest。 */
  role: string;
  request: PlaceSearchRequest;
}

/**
 * 通用地点候选：保留既有领域 Place 作为 discriminated detail，
 * 同时提供 Provider 可稳定理解的开放 categories/tags。
 */
export interface PlaceCandidate {
  id: string;
  name: string;
  address: string;
  location: GeoLocation;
  distanceKm: number;
  rating: number;
  pricePerPerson?: number;
  categories: string[];
  tags: string[];
  metadata: Record<string, unknown>;
  detail: Place;
  source?: ProviderSource;
}

export interface PlaceSearchResult {
  places: PlaceCandidate[];
  total: number;
}

export function validateSearchSpatial(spatial: SearchSpatialConstraint): string | undefined {
  if (!Number.isFinite(spatial.origin.lat) || spatial.origin.lat < -90 || spatial.origin.lat > 90) {
    return "spatial.origin.lat must be finite and within [-90, 90]";
  }
  if (!Number.isFinite(spatial.origin.lng) || spatial.origin.lng < -180 || spatial.origin.lng > 180) {
    return "spatial.origin.lng must be finite and within [-180, 180]";
  }
  if (!Number.isFinite(spatial.maxKm) || spatial.maxKm <= 0) {
    return "spatial.maxKm must be finite and greater than 0";
  }
  return undefined;
}
