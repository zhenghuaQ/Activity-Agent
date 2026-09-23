import type { Attraction, BreakPlace, GeoLocation, Restaurant } from "../../../../spec/types.js";
import type { DecisionScenarioDataFixture } from "../schema.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function buildFixtureData(
  label: string,
  center: GeoLocation,
  attractions: readonly Attraction[],
  restaurants: readonly Restaurant[],
  breakPlaces: readonly BreakPlace[],
  cuisines: readonly string[] = ["日料", "火锅", "粤菜", "云南菜", "西餐", "素食"],
): DecisionScenarioDataFixture {
  const toLocation = (location: GeoLocation, index: number): GeoLocation => ({
    ...location,
    lat: center.lat + (index % 3 - 1) * 0.012,
    lng: center.lng + (Math.floor(index / 3) - 1) * 0.012,
    city: center.city,
    district: center.district,
    address: `${center.city}${center.district ?? ""}${label}演示区域${index + 1}`,
  });

  return {
    attractions: attractions.map((place, index) => {
      const next = clone(place);
      next.id = `${label.toLowerCase().replace(/\s+/g, "_")}_${place.id}`;
      next.name = `${label} ${place.name}`;
      next.location = toLocation(place.location, index);
      next.address = next.location.address;
      next.distanceKm = index + 1;
      return next;
    }),
    restaurants: restaurants.map((place, index) => {
      const next = clone(place);
      next.id = `${label.toLowerCase().replace(/\s+/g, "_")}_${place.id}`;
      next.name = `${label} ${place.name}`;
      next.location = toLocation(place.location, index + 10);
      next.address = next.location.address;
      next.distanceKm = index + 1;
      next.cuisine = cuisines[index % cuisines.length];
      next.tags = [...new Set([...next.tags, next.cuisine])];
      next.dietaryOptions = index !== restaurants.length - 1;
      return next;
    }),
    breakPlaces: breakPlaces.map((place, index) => {
      const next = clone(place);
      next.id = `${label.toLowerCase().replace(/\s+/g, "_")}_${place.id}`;
      next.name = `${label} ${place.name}`;
      next.location = toLocation(place.location, index + 20);
      next.address = next.location.address;
      next.distanceKm = index + 1;
      return next;
    }),
    destinationCenters: { [center.city]: center },
  };
}
