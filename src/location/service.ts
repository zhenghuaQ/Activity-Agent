// ============================================================
// src/location/service.ts — Location resolver orchestration
//
// This module owns the resolution policy, not provider implementations.
// Provider-specific HTTP/configuration lives in providers.ts.
// ============================================================

import type { GeoLocation } from "../../spec/types.js";
import type {
  DefaultLocationProvider,
  GeoIpProvider,
  GeocodingProvider,
  LocationRequest,
  LocationResolver,
  ResolvedLocation,
} from "../../spec/location.js";
import {
  ActivityDataGeocodingProvider,
  AmapGeoIpProvider,
  StaticDefaultLocationProvider,
} from "./providers.js";
import { createDefaultDataProvider } from "../data/index.js";

export interface DefaultLocationResolverDependencies {
  geocodingProvider: GeocodingProvider;
  geoIpProvider: GeoIpProvider;
  defaultLocationProvider: DefaultLocationProvider;
}

/** Selects a capability based on the formal LocationRequest kind. */
export class DefaultLocationResolver implements LocationResolver {
  constructor(private readonly dependencies: DefaultLocationResolverDependencies) {}

  async resolve(request: LocationRequest): Promise<ResolvedLocation> {
    switch (request.kind) {
      case "coords":
        return {
          source: "coords",
          location: {
            lat: request.lat,
            lng: request.lng,
            address: request.address || "用户当前位置",
            city: request.city || "",
          },
        };
      case "address": {
        const location = await this.dependencies.geocodingProvider.geocode(request.address, {
          city: request.city,
        });
        return location
          ? { source: "geocode", location }
          : this.defaultResolvedLocation();
      }
      case "ip": {
        const location = await this.dependencies.geoIpProvider.locateIp(request.ip);
        return location
          ? { source: "ip", location }
          : this.defaultResolvedLocation();
      }
      case "default":
        return this.defaultResolvedLocation();
    }
  }

  private async defaultResolvedLocation(): Promise<ResolvedLocation> {
    return {
      source: "default",
      location: await this.dependencies.defaultLocationProvider.getDefaultLocation(),
    };
  }
}

export interface DefaultLocationResolverOptions {
  geocodingProvider?: GeocodingProvider;
  geoIpProvider?: GeoIpProvider;
  defaultLocationProvider?: DefaultLocationProvider;
}

/** Production/development composition factory. */
export function createDefaultLocationResolver(
  options: DefaultLocationResolverOptions = {},
): LocationResolver {
  const dataProvider = options.geocodingProvider ? undefined : createDefaultDataProvider();
  return new DefaultLocationResolver({
    geocodingProvider: options.geocodingProvider ?? new ActivityDataGeocodingProvider(dataProvider!),
    geoIpProvider: options.geoIpProvider ?? new AmapGeoIpProvider(),
    defaultLocationProvider: options.defaultLocationProvider ?? new StaticDefaultLocationProvider(),
  });
}

/** @deprecated Prefer an injected LocationResolver or createDefaultLocationResolver(). */
export async function resolveLocation(
  input: LocationRequest = { kind: "default" },
): Promise<ResolvedLocation> {
  return createDefaultLocationResolver().resolve(input);
}

export type { GeoLocation };
