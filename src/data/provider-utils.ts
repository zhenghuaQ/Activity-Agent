import type { Place } from "../../spec/types.js";
import type { PlaceQuery, ProviderSource } from "../../spec/datasource.js";
import { DataProviderError } from "./provider-error.js";

export function searchCenter(query: PlaceQuery) {
  return query.searchArea?.center ?? query.origin;
}

export function requireSearchCity(providerId: string, supportedCities: readonly string[], query: PlaceQuery): void {
  const city = query.searchArea?.destination.city || query.destination?.city || query.origin.city;
  if (city && !supportedCities.some(supported => city.includes(supported) || supported.includes(city))) {
    throw new DataProviderError("destination_unsupported", `${providerId} 不支持目的地：${city}`, providerId);
  }
}

export function withProviderSource<T extends Place>(providerId: string, places: readonly T[]): T[] {
  const fetchedAt = Date.now();
  return places.map(place => ({ ...place, source: place.source ?? {
    providerId, externalId: place.id, fetchedAt,
  } satisfies ProviderSource }));
}
