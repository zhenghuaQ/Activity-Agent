// ============================================================
// spec/location.ts — Location Contract
//
// LocationRequest 表示调用方提供的环境提示；ResolvedLocation 表示
// 定位服务完成解析后的事实。两者刻意分开，避免 Runtime 把未解析的
// 输入误当成已确认的环境状态。
// ============================================================

import type { GeoLocation } from "./types.js";

export type LocationSource = "coords" | "geocode" | "ip" | "default";

export type LocationRequest =
  | {
      kind: "coords";
      lat: number;
      lng: number;
      address?: string;
      city?: string;
    }
  | {
      kind: "address";
      address: string;
      city?: string;
    }
  | {
      kind: "ip";
      ip?: string;
    }
  | {
      kind: "default";
    };

export interface ResolvedLocation {
  location: GeoLocation;
  /** 实际命中的来源，便于可观测与降级提示 */
  source: LocationSource;
}

/** Optional cancellation context shared by location capability providers. */
export interface LocationProviderContext {
  signal?: AbortSignal;
}

/** Address-to-coordinate capability. A null result means no match was found. */
export interface GeocodingProvider {
  geocode(address: string, options?: LocationProviderContext & { city?: string }): Promise<GeoLocation | null>;
}

/** IP-to-coordinate capability. A null result means the provider had no result. */
export interface GeoIpProvider {
  locateIp(ip?: string, options?: LocationProviderContext): Promise<GeoLocation | null>;
}

/** Explicit default-location capability. */
export interface DefaultLocationProvider {
  getDefaultLocation(): Promise<GeoLocation>;
}

/** Infrastructure boundary consumed by get_user_location. */
export interface LocationResolver {
  resolve(request: LocationRequest): Promise<ResolvedLocation>;
}
