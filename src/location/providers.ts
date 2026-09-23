// ============================================================
// src/location/providers.ts — Location capability adapters
//
// These adapters keep provider-specific configuration and response handling
// outside DefaultLocationResolver. The resolver only orchestrates capabilities.
// ============================================================

import type { GeoLocation } from "../../spec/types.js";
import type { ActivityDataProviderV1, ProviderContext } from "../../spec/datasource.js";
import type {
  DefaultLocationProvider,
  GeoIpProvider,
  GeocodingProvider,
  LocationProviderContext,
} from "../../spec/location.js";
import { HOME } from "../data/mock.js";
import { getAppConfig } from "../core/config.js";

/** Adapts the configured Activity data provider's geocoding capability. */
export class ActivityDataGeocodingProvider implements GeocodingProvider {
  constructor(private readonly provider: Pick<ActivityDataProviderV1, "geocode">) {}

  geocode(address: string, options: LocationProviderContext & { city?: string } = {}): Promise<GeoLocation | null> {
    const context: ProviderContext = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.city ? { city: options.city } : {}),
    };
    return this.provider.geocode(address, context);
  }
}

export interface AmapGeoIpProviderOptions {
  apiKey?: string;
  enabled?: boolean;
  apiKeyProvider?: () => string | undefined;
  enabledProvider?: () => boolean;
  endpoint?: string;
}

/** AMap Geo-IP adapter. Provider exceptions intentionally propagate. */
export class AmapGeoIpProvider implements GeoIpProvider {
  private readonly apiKeyProvider: () => string | undefined;
  private readonly enabledProvider: () => boolean;
  private readonly endpoint: string;

  constructor(options: AmapGeoIpProviderOptions = {}) {
    this.apiKeyProvider = options.apiKeyProvider ?? (() => options.apiKey ?? process.env.AMAP_API_KEY);
    this.enabledProvider = options.enabledProvider ?? (() => options.enabled ?? getAppConfig().flags.amap);
    this.endpoint = options.endpoint ?? "https://restapi.amap.com/v3/ip";
  }

  async locateIp(ip?: string, options: LocationProviderContext = {}): Promise<GeoLocation | null> {
    const key = this.apiKeyProvider();
    if (!key || !this.enabledProvider()) return null;

    const url = new URL(this.endpoint);
    url.searchParams.set("key", key);
    if (ip) url.searchParams.set("ip", ip);
    const response = await fetch(url.toString(), { signal: options.signal });
    const json = await response.json() as {
      status?: string;
      city?: string | string[];
      rectangle?: string;
    };
    if (json.status !== "1" || !json.rectangle || !json.rectangle.includes(";")) return null;

    const [first, second] = json.rectangle.split(";");
    const [lng1, lat1] = first.split(",").map(Number);
    const [lng2, lat2] = second.split(",").map(Number);
    if (![lng1, lat1, lng2, lat2].every(Number.isFinite)) return null;
    const city = Array.isArray(json.city) ? json.city[0] : json.city || "";
    return {
      lat: (lat1 + lat2) / 2,
      lng: (lng1 + lng2) / 2,
      address: `${city}（IP 粗定位）`,
      city,
    };
  }
}

/** Development-safe default provider; production can replace it at composition time. */
export class StaticDefaultLocationProvider implements DefaultLocationProvider {
  constructor(private readonly location: GeoLocation = HOME) {}

  async getDefaultLocation(): Promise<GeoLocation> {
    return { ...this.location };
  }
}
