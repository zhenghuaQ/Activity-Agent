import type { Place, Restaurant, BreakPlace } from "../../spec/types.js";
import type {
  PlaceCandidate,
  PlaceSearchIntent,
  PlaceSearchRequest,
  PlaceSearchResult,
} from "../../spec/place-search.js";

function categoryHints(place: Place): string[] {
  const categories = new Set<string>();
  if (place.type === "restaurant") {
    categories.add("restaurant");
  } else if (place.type === "break") {
    categories.add("break");
    const subtype = (place as BreakPlace).breakSubtype;
    categories.add(subtype);
    if (subtype === "cafe") categories.add("cafe");
    if (subtype === "tea_house") categories.add("tea_house");
    if (subtype === "dessert_shop") categories.add("dessert");
    if (subtype === "kids_indoor_play") categories.add("kids_indoor_play");
  } else if (place.type === "attraction") {
    categories.add("attraction");
    const text = `${place.name} ${place.address}`;
    if (/公园/.test(text)) categories.add("park");
    if (/(馆|展览|艺术)/.test(text)) categories.add("museum");
    if (/画廊/.test(text)) categories.add("gallery");
  } else {
    categories.add(place.type);
  }
  return [...categories];
}

function tagsForPlace(place: Place): string[] {
  const tags = new Set<string>([
    ...place.crowdTags,
    ...place.localFeatures,
  ]);
  if (place.type === "restaurant") {
    const restaurant = place as Restaurant;
    restaurant.tags.forEach((tag) => tags.add(tag));
    tags.add(restaurant.dietaryOptions ? "dietary_options" : "no_dietary_options");
    tags.add(restaurant.cuisine);
  }
  if (place.type === "break") {
    const breakPlace = place as BreakPlace;
    if (breakPlace.accessible) tags.add("accessible");
    if (breakPlace.kidsFriendly) tags.add("kids_friendly");
  }
  return [...tags];
}

export function toPlaceCandidate(place: Place): PlaceCandidate {
  return {
    id: place.id,
    name: place.name,
    address: place.address,
    location: place.location,
    distanceKm: place.distanceKm,
    rating: place.rating,
    ...(place.pricePerPerson !== undefined ? { pricePerPerson: place.pricePerPerson } : {}),
    categories: categoryHints(place),
    tags: tagsForPlace(place),
    metadata: { domainType: place.type },
    detail: place,
    ...(place.source ? { source: place.source } : {}),
  };
}

function matchesCategories(candidate: PlaceCandidate, categories?: string[]): boolean {
  if (!categories || categories.length === 0) return true;
  return categories.some((category) => candidate.categories.includes(category));
}

function matchesFilters(candidate: PlaceCandidate, intent: PlaceSearchIntent): boolean {
  const filters = intent.filters;
  if (!filters) return true;
  if (filters.minRating !== undefined && candidate.rating < filters.minRating) return false;
  if (filters.cuisines && filters.cuisines.length > 0) {
    const cuisine = candidate.detail.type === "restaurant" ? (candidate.detail as Restaurant).cuisine : "";
    if (!filters.cuisines.some((item) => cuisine.includes(item) || item.includes(cuisine))) return false;
  }
  if (filters.priceLevels && filters.priceLevels.length > 0) {
    const price = candidate.pricePerPerson ?? 0;
    const level = price <= 100 ? 1 : price <= 200 ? 2 : 3;
    if (!filters.priceLevels.includes(level)) return false;
  }
  if (filters.openAt && candidate.detail.type === "attraction") {
    const available = (candidate.detail as import("../../spec/types.js").Attraction).availableSlots.some((slot) =>
      slot.start <= filters.openAt! && slot.end >= filters.openAt!
    );
    if (!available) return false;
  }
  return true;
}

function matchesIntent(candidate: PlaceCandidate, intent: PlaceSearchIntent): boolean {
  if (!matchesCategories(candidate, intent.categories)) return false;
  if (intent.requiredTags?.some((tag) => !candidate.tags.includes(tag))) return false;
  if (intent.excludedTags?.some((tag) => candidate.tags.includes(tag))) return false;
  if (intent.query) {
    const query = intent.query.toLowerCase();
    const haystack = [candidate.name, candidate.address, ...candidate.categories, ...candidate.tags]
      .join(" ").toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return matchesFilters(candidate, intent);
}

export function searchPlacePool(
  places: readonly Place[],
  request: PlaceSearchRequest,
): PlaceSearchResult {
  const candidates = places
    .map(toPlaceCandidate)
    .filter((candidate) => matchesIntent(candidate, request.intent))
    .sort((a, b) => {
      const preferred = request.intent.preferredTags ?? [];
      const score = (candidate: PlaceCandidate) => preferred.reduce(
        (sum, tag) => sum + (candidate.tags.includes(tag) ? 1 : 0), 0
      );
      return score(b) - score(a) || b.rating - a.rating || a.distanceKm - b.distanceKm;
    });
  const limited = request.limit !== undefined ? candidates.slice(0, request.limit) : candidates;
  return { places: limited, total: candidates.length };
}

export function detailPlaces(result: PlaceSearchResult): Place[] {
  return result.places.map((candidate) => candidate.detail);
}
