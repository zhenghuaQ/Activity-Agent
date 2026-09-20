// ============================================================
// src/data/providers/amap-provider.ts — 高德数据源（只读）
//
// 能力：POI 周边搜索 + 地理编码。无 Key 或任何异常 → 降级 fallback(Mock)。
// 高德 POI 字段有限，这里做「最佳努力」映射 + 合成补全（时段/时长等），
// 实时排队等软信号统一交给 crowd.ts 启发式处理。
// 所有外呼经 LRU+TTL 缓存收敛重复请求。
// ============================================================

import type {
  Attraction,
  BreakPlace,
  GeoLocation,
  LocalFeatureTag,
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
import { withDistanceFrom } from "../../core/geo.js";
import { TtlLruCache } from "../../core/cache.js";
import { childLogger } from "../../core/logger.js";
import { throwIfAborted } from "../../runtime/abort.js";
import { searchCenter, withProviderSource } from "../provider-utils.js";

const log = childLogger("data:amap");

const AMAP_AROUND = "https://restapi.amap.com/v3/place/around";
const AMAP_GEOCODE = "https://restapi.amap.com/v3/geocode/geo";

// 高德 POI 大类代码
const TYPE_RESTAURANT = "050000"; // 餐饮服务
const TYPE_ATTRACTION = "110000|080000"; // 风景名胜|体育休闲
const TYPE_CAFE_TEA = "050500|050300"; // 咖啡厅|茶艺馆

interface AmapPoi {
  id?: string;
  name?: string;
  address?: string | string[];
  location?: string; // "lng,lat"
  type?: string;
  biz_ext?: { rating?: string | string[]; cost?: string | string[] };
}

function num(v: unknown, fallback: number): number {
  if (Array.isArray(v)) v = v[0];
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? (n as number) : fallback;
}

function str(v: unknown): string {
  if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
  return typeof v === "string" ? v : "";
}

function parseLocation(loc?: string): { lat: number; lng: number } | null {
  if (!loc || !loc.includes(",")) return null;
  const [lng, lat] = loc.split(",").map((s) => parseFloat(s));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function localFeaturesFromRating(rating: number): LocalFeatureTag[] {
  return rating >= 4.6 ? ["popular_checkin"] : [];
}

export interface AmapProviderOptions {
  apiKey: string;
  fallback: ActivityDataProviderV1;
  /** 缓存 TTL（毫秒），默认 5 分钟 */
  ttlMs?: number;
}

export class AmapProvider implements ActivityDataProviderV1 {
  readonly apiVersion = 1 as const;
  readonly id = "amap";
  readonly name = "amap";
  readonly capabilities: ProviderCapabilities = { destinationResolution: true, attractions: true,
    restaurants: true, breakPlaces: true, geocoding: true, lookupById: false };
  private readonly apiKey: string;
  private readonly fallback: ActivityDataProviderV1;
  private readonly poiCache: TtlLruCache<AmapPoi[]>;
  private readonly geoCache: TtlLruCache<GeoLocation | null>;

  constructor(opts: AmapProviderOptions) {
    this.apiKey = opts.apiKey;
    this.fallback = opts.fallback;
    const ttl = opts.ttlMs ?? 5 * 60 * 1000;
    this.poiCache = new TtlLruCache<AmapPoi[]>(300, ttl);
    this.geoCache = new TtlLruCache<GeoLocation | null>(300, ttl);
  }

  private async fetchAround(
    origin: GeoLocation,
    types: string,
    radiusKm: number,
    keywords?: string[],
    signal?: AbortSignal
  ): Promise<AmapPoi[]> {
    const kw = (keywords ?? []).join("|");
    const radiusM = Math.round(radiusKm * 1000);
    const cacheKey = `${origin.lng},${origin.lat}|${types}|${radiusM}|${kw}`;

    return this.poiCache.wrap(cacheKey, async () => {
      const url = new URL(AMAP_AROUND);
      url.searchParams.set("key", this.apiKey);
      url.searchParams.set("location", `${origin.lng},${origin.lat}`);
      url.searchParams.set("radius", String(radiusM));
      url.searchParams.set("types", types);
      if (kw) url.searchParams.set("keywords", kw);
      url.searchParams.set("offset", "25");
      url.searchParams.set("page", "1");
      url.searchParams.set("extensions", "all");

      const resp = await fetch(url.toString(), { signal });
      const json = (await resp.json()) as { status?: string; pois?: AmapPoi[] };
      if (json.status !== "1" || !Array.isArray(json.pois)) {
        log.warn({ status: json.status }, "高德 POI 返回异常");
        return [];
      }
      return json.pois;
    });
  }

  private toCity(origin: GeoLocation): Pick<GeoLocation, "city" | "district"> {
    return { city: origin.city, district: origin.district };
  }

  async resolveDestination(query: DestinationQuery, context: ProviderContext = {}): Promise<SearchArea> {
    throwIfAborted(context.signal);
    if (query.coordinates) {
      return { destination: { ...query }, center: { ...query.coordinates, city: query.city,
        district: query.district, address: `${query.city}${query.district ?? ""}` }, confidence: 1 };
    }
    const address = `${query.city}${query.district ?? ""}`;
    const center = await this.geocode(address, context);
    if (center) return { destination: { ...query }, center: { ...center, city: center.city || query.city,
      district: center.district || query.district }, confidence: 0.95 };
    return this.fallback.resolveDestination(query, context);
  }

  async searchAttractions(query: PlaceQuery, context: ProviderContext = {}): Promise<Attraction[]> {
    const signal = context.signal;
    throwIfAborted(signal);
    try {
      const center = searchCenter(query);
      const pois = await this.fetchAround(
        center,
        TYPE_ATTRACTION,
        query.radiusKm,
        query.keywords,
        signal
      );
      if (pois.length === 0) return this.fallback.searchAttractions(query, context);

      const items: Attraction[] = pois.flatMap((p) => {
        const coord = parseLocation(p.location);
        if (!coord) return [];
        const rating = num(p.biz_ext?.rating, 4.3);
        const a: Attraction = {
          id: p.id || `amap_attr_${p.name}`,
          name: str(p.name),
          type: "attraction",
          crowdTags: ["family_kids", "family_elderly", "family_mixed", "friends", "couple", "solo"],
          localFeatures: localFeaturesFromRating(rating),
          address: str(p.address) || str(p.name),
          distanceKm: 0,
          location: { ...coord, address: str(p.address), ...this.toCity(center) },
          rating,
          pricePerPerson: num(p.biz_ext?.cost, 0),
          durationMinutes: 120,
          indoor: true,
          availableSlots: [{ start: "09:00", end: "21:00", remaining: 999 }],
        };
        return [a];
      });
      return withProviderSource(this.id, this.applyFeatures(withDistanceFrom(center, items), query));
    } catch (err) {
      return this.degrade(err, signal, () => this.fallback.searchAttractions(query, context));
    }
  }

  async searchRestaurants(query: PlaceQuery, context: ProviderContext = {}): Promise<Restaurant[]> {
    const signal = context.signal;
    throwIfAborted(signal);
    try {
      const center = searchCenter(query);
      const pois = await this.fetchAround(
        center,
        TYPE_RESTAURANT,
        query.radiusKm,
        query.keywords,
        signal
      );
      if (pois.length === 0) return this.fallback.searchRestaurants(query, context);

      const items: Restaurant[] = pois.flatMap((p) => {
        const coord = parseLocation(p.location);
        if (!coord) return [];
        const rating = num(p.biz_ext?.rating, 4.2);
        const r: Restaurant = {
          id: p.id || `amap_rest_${p.name}`,
          name: str(p.name),
          type: "restaurant",
          crowdTags: ["family_kids", "family_elderly", "family_mixed", "friends", "couple", "solo"],
          localFeatures: localFeaturesFromRating(rating),
          address: str(p.address) || str(p.name),
          distanceKm: 0,
          location: { ...coord, address: str(p.address), ...this.toCity(center) },
          rating,
          pricePerPerson: num(p.biz_ext?.cost, 80),
          cuisine: str(p.type).split(";").pop() || "餐厅",
          tags: [],
          avgDurationMinutes: 75,
          hasQueue: false,
          queueCount: 0,
          dietaryOptions: true,
        };
        return [r];
      });
      return withProviderSource(this.id, this.applyFeatures(withDistanceFrom(center, items), query));
    } catch (err) {
      return this.degrade(err, signal, () => this.fallback.searchRestaurants(query, context));
    }
  }

  async searchBreakPlaces(query: BreakPlaceQuery, context: ProviderContext = {}): Promise<BreakPlace[]> {
    const signal = context.signal;
    throwIfAborted(signal);
    try {
      const center = searchCenter(query);
      const pois = await this.fetchAround(
        center,
        TYPE_CAFE_TEA,
        query.radiusKm,
        query.keywords,
        signal
      );
      if (pois.length === 0) return this.fallback.searchBreakPlaces(query, context);

      const subtype = query.breakSubtype ?? "cafe";
      const items: BreakPlace[] = pois.flatMap((p) => {
        const coord = parseLocation(p.location);
        if (!coord) return [];
        const rating = num(p.biz_ext?.rating, 4.2);
        const b: BreakPlace = {
          id: p.id || `amap_break_${p.name}`,
          name: str(p.name),
          type: "break",
          breakSubtype: subtype,
          crowdTags: ["friends", "couple", "solo"],
          localFeatures: localFeaturesFromRating(rating),
          address: str(p.address) || str(p.name),
          distanceKm: 0,
          location: { ...coord, address: str(p.address), ...this.toCity(center) },
          rating,
          pricePerPerson: num(p.biz_ext?.cost, 40),
          durationMinutes: 45,
          accessible: true,
          kidsFriendly: subtype === "kids_indoor_play",
        };
        return [b];
      });
      const withDist = withDistanceFrom(center, items);
      return withProviderSource(this.id, this.applyFeatures(withDist, query));
    } catch (err) {
      return this.degrade(err, signal, () => this.fallback.searchBreakPlaces(query, context));
    }
  }

  async getAttractionById(id: string, context?: ProviderContext): Promise<Attraction | undefined> {
    return this.fallback.getAttractionById(id, context);
  }

  async getRestaurantById(id: string, context?: ProviderContext): Promise<Restaurant | undefined> {
    return this.fallback.getRestaurantById(id, context);
  }

  async geocode(address: string, context: ProviderContext = {}): Promise<GeoLocation | null> {
    const signal = context.signal;
    throwIfAborted(signal);
    try {
      return await this.geoCache.wrap(address, async () => {
        const url = new URL(AMAP_GEOCODE);
        url.searchParams.set("key", this.apiKey);
        url.searchParams.set("address", address);
        const resp = await fetch(url.toString(), { signal });
        const json = (await resp.json()) as {
          status?: string;
          geocodes?: Array<{ location?: string; city?: string; district?: string }>;
        };
        const g = json.geocodes?.[0];
        const coord = parseLocation(g?.location);
        if (json.status !== "1" || !coord) {
          return this.fallback.geocode(address, context);
        }
        return {
          ...coord,
          address,
          city: str(g?.city) || "",
          district: str(g?.district) || undefined,
        };
      });
    } catch (err) {
      throwIfAborted(signal);
      log.warn({ err: err instanceof Error ? err.message : String(err) }, "高德地理编码失败，降级");
      return this.fallback.geocode(address, context);
    }
  }

  private applyFeatures<T extends { localFeatures: LocalFeatureTag[] }>(
    list: T[],
    query: PlaceQuery
  ): T[] {
    let out = list;
    if (query.localFeatures && query.localFeatures.length > 0) {
      out = out.filter((p) =>
        p.localFeatures.some((f) => query.localFeatures!.includes(f))
      );
    }
    return query.limit ? out.slice(0, query.limit) : out;
  }

  private degrade<T>(
    err: unknown,
    signal: AbortSignal | undefined,
    fallback: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "高德请求异常，降级 Mock"
    );
    return fallback();
  }
}
