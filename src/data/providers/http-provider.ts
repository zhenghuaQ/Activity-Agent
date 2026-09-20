import type { Attraction, BreakPlace, GeoLocation, Restaurant } from "../../../spec/types.js";
import type { ActivityDataProviderV1, BreakPlaceQuery, DestinationQuery, PlaceQuery,
  ProviderCapabilities, ProviderContext, SearchArea } from "../../../spec/datasource.js";
import { throwIfAborted } from "../../runtime/abort.js";
import { DataProviderError } from "../provider-error.js";
import { withProviderSource } from "../provider-utils.js";

interface HttpEnvelope<T> { apiVersion: 1; data: T }

export interface HttpDataProviderOptions {
  id?: string;
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  capabilities?: Partial<ProviderCapabilities>;
}

const ALL_CAPABILITIES: ProviderCapabilities = { destinationResolution: true, attractions: true,
  restaurants: true, breakPlaces: true, geocoding: true, lookupById: true };

/** Activity Data Provider v1 的语言无关 HTTP 客户端。 */
export class HttpDataProvider implements ActivityDataProviderV1 {
  readonly apiVersion = 1 as const;
  readonly id: string;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpDataProviderOptions) {
    if (!/^https?:\/\//i.test(options.baseUrl)) throw new Error("invalid_http_provider_url");
    this.id = options.id?.trim() || "http";
    this.name = this.id;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.capabilities = { ...ALL_CAPABILITIES, ...options.capabilities };
  }

  async resolveDestination(query: DestinationQuery, context?: ProviderContext): Promise<SearchArea> {
    const area = await this.request<SearchArea>("/v1/resolve-destination", { query }, context);
    const matches = area?.destination?.city && (area.destination.city.includes(query.city) || query.city.includes(area.destination.city))
      && area.center?.city && (area.center.city.includes(query.city) || query.city.includes(area.center.city));
    if (!matches || !Number.isFinite(area.center.lat) || !Number.isFinite(area.center.lng)) {
      throw new DataProviderError("invalid_response", "resolve-destination 返回了错误城市或无效中心点", this.id);
    }
    return area;
  }
  async searchAttractions(query: PlaceQuery, context?: ProviderContext): Promise<Attraction[]> {
    return this.validatePlaces(query, withProviderSource(this.id,
      await this.arrayRequest<Attraction>("/v1/places/attractions/search", { query }, context)));
  }
  async searchRestaurants(query: PlaceQuery, context?: ProviderContext): Promise<Restaurant[]> {
    return this.validatePlaces(query, withProviderSource(this.id,
      await this.arrayRequest<Restaurant>("/v1/places/restaurants/search", { query }, context)));
  }
  async searchBreakPlaces(query: BreakPlaceQuery, context?: ProviderContext): Promise<BreakPlace[]> {
    return this.validatePlaces(query, withProviderSource(this.id,
      await this.arrayRequest<BreakPlace>("/v1/places/breaks/search", { query }, context)));
  }
  async getAttractionById(id: string, context?: ProviderContext): Promise<Attraction | undefined> {
    const value = await this.request<Attraction | null>(`/v1/places/attractions/${encodeURIComponent(id)}`, undefined, context, "GET");
    return value ? withProviderSource(this.id, [value])[0] : undefined;
  }
  async getRestaurantById(id: string, context?: ProviderContext): Promise<Restaurant | undefined> {
    const value = await this.request<Restaurant | null>(`/v1/places/restaurants/${encodeURIComponent(id)}`, undefined, context, "GET");
    return value ? withProviderSource(this.id, [value])[0] : undefined;
  }
  geocode(address: string, context?: ProviderContext): Promise<GeoLocation | null> {
    return this.request("/v1/geocode", { address }, context);
  }

  private async arrayRequest<T>(path: string, body: unknown, context?: ProviderContext): Promise<T[]> {
    const value = await this.request<unknown>(path, body, context);
    if (!Array.isArray(value)) throw new DataProviderError("invalid_response", `${path} 未返回数组`, this.id);
    return value as T[];
  }

  private validatePlaces<T extends Attraction | Restaurant | BreakPlace>(query: PlaceQuery, places: T[]): T[] {
    const city = query.searchArea?.destination.city || query.destination?.city;
    for (const place of places) {
      if (!place || typeof place.id !== "string" || !Number.isFinite(place.distanceKm) || !place.location?.city) {
        throw new DataProviderError("invalid_response", "地点缺少 id、distanceKm 或 location.city", this.id);
      }
      if (city && !(place.location.city.includes(city) || city.includes(place.location.city))) {
        throw new DataProviderError("invalid_response", `Provider 返回跨城市地点：${place.location.city} != ${city}`, this.id);
      }
    }
    return places.filter(place => place.distanceKm <= query.radiusKm);
  }

  private async request<T>(path: string, body: unknown, context: ProviderContext = {}, method = "POST"): Promise<T> {
    throwIfAborted(context.signal);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = context.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
    const headers: Record<string, string> = { Accept: "application/json", "X-Activity-Provider-Version": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method, headers, signal, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "authentication_failed"
          : response.status === 404 ? "destination_unsupported"
            : response.status === 429 ? "rate_limited" : "network_unavailable";
        throw new DataProviderError(code, `HTTP Provider ${response.status}: ${path}`, this.id);
      }
      const envelope = await response.json() as Partial<HttpEnvelope<T>>;
      if (envelope.apiVersion !== 1 || !("data" in envelope)) {
        throw new DataProviderError("invalid_response", `${path} 返回的信封不符合 Provider v1`, this.id);
      }
      return envelope.data as T;
    } catch (error) {
      throwIfAborted(context.signal);
      if (error instanceof DataProviderError) throw error;
      throw new DataProviderError("network_unavailable", `${this.id} 请求失败：${error instanceof Error ? error.message : String(error)}`, this.id, { cause: error });
    }
  }
}
