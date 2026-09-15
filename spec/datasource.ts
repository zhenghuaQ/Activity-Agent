// ============================================================
// spec/datasource.ts — 数据服务层契约（SDD）
//
// 把「数据从哪来」与「决策怎么算」彻底解耦：
//   - 工具/引擎只依赖 DataSource 接口，不直接 import Mock 数组；
//   - MockProvider / AmapProvider 可热插拔，无 Key 自动降级 Mock；
//   - 距离一律相对查询 origin 实时计算（Haversine），不读写死字段。
// ============================================================

import type {
  Attraction,
  BreakPlace,
  BreakSubtype,
  GeoLocation,
  LocalFeatureTag,
  Restaurant,
} from "./types.js";

// ─── 周边检索查询 ──────────────────────────────────────

/** 通用周边检索参数：以 origin 为圆心、radiusKm 为半径 */
export interface PlaceQuery {
  /** 出发点 / 检索圆心（用户真实定位） */
  origin: GeoLocation;
  /** 检索半径（km） */
  radiusKm: number;
  /** 关键词（高德 POI 检索用；Mock 做名称/地址包含匹配） */
  keywords?: string[];
  /** 当地特色过滤 */
  localFeatures?: LocalFeatureTag[];
  /** 返回上限（默认由 Provider 决定） */
  limit?: number;
}

/** 茶歇检索：在通用参数上追加子类型 */
export interface BreakPlaceQuery extends PlaceQuery {
  breakSubtype?: BreakSubtype;
}

// ─── 拥挤度预测（替代旧的可用性硬过滤） ────────────────

export type CrowdLevel = "low" | "medium" | "high" | "packed";

/**
 * 拥挤度/排队预测结果。
 * 真实实时客流不可得，用启发式（时段×周末×热度×场所类型）估计，
 * 并显式给出 confidence，供 M2 评分与可解释模块使用。
 */
export interface CrowdPrediction {
  placeId: string;
  level: CrowdLevel;
  /** 预估排队/等待分钟 */
  estimatedWaitMinutes: number;
  /** 0-1 置信度（数据越间接越低） */
  confidence: number;
  /** 启发式依据，便于解释「为什么判定为拥挤」 */
  factors: string[];
}

// ─── 数据源接口 ────────────────────────────────────────

/**
 * 只读数据源。所有方法异步（高德为网络调用），
 * 返回的地点 distanceKm 已相对 query.origin 重算并按距离升序。
 */
export interface DataSource {
  /** 数据源标识，用于日志/可观测（如 "mock" / "amap" / "amap+mock"） */
  readonly name: string;

  searchAttractions(query: PlaceQuery, signal?: AbortSignal): Promise<Attraction[]>;
  searchRestaurants(query: PlaceQuery, signal?: AbortSignal): Promise<Restaurant[]>;
  searchBreakPlaces(query: BreakPlaceQuery, signal?: AbortSignal): Promise<BreakPlace[]>;

  getAttractionById(id: string, signal?: AbortSignal): Promise<Attraction | undefined>;
  getRestaurantById(id: string, signal?: AbortSignal): Promise<Restaurant | undefined>;

  /** 地址 → 经纬度；失败返回 null（调用方负责降级） */
  geocode(address: string, signal?: AbortSignal): Promise<GeoLocation | null>;
}
