import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { SearchPlacesTool } from "../src/tools/places.js";
import { SearchRestaurantsTool } from "../src/tools/restaurants.js";
import type { PlaceSearchRequest } from "../spec/place-search.js";
import type { ProviderContext } from "../spec/datasource.js";
import type { PlaceSearchResult } from "../spec/place-search.js";
import type { GeoLocation } from "../spec/types.js";

const origin: GeoLocation = { lat: 39.98, lng: 116.31, address: "北京", city: "北京" };

describe("generic place search", () => {
  it("accepts an open multi-category request and returns candidates", async () => {
    const response = await new SearchPlacesTool(new MockProvider()).execute({
      spatial: { origin, maxKm: 10 },
      intent: { categories: ["cafe", "tea_house", "bookstore"] },
    });
    expect(response.status).toBe("success");
    if (response.status === "success") expect(Array.isArray(response.data.places)).toBe(true);
  });

  it("treats unknown categories as a valid empty result", async () => {
    const response = await new SearchPlacesTool(new MockProvider()).execute({
      spatial: { origin, maxKm: 5 }, intent: { categories: ["coworking"] },
    });
    expect(response.status).toBe("success");
    if (response.status === "success") expect(response.data.places).toEqual([]);
  });

  it("rejects invalid spatial coordinates without fallback", async () => {
    const response = await new SearchPlacesTool(new MockProvider()).execute({
      spatial: { origin: { ...origin, lat: 999 }, maxKm: 5 }, intent: { categories: ["restaurant"] },
    });
    expect(response.status).toBe("error");
    if (response.status === "error") expect(response.errorInfo.code).toBe("E_PARAM_INVALID");
  });

  it("legacy restaurant tool delegates to searchPlaces", async () => {
    class RecordingProvider extends MockProvider {
      called = false;
      override async searchPlaces(request: PlaceSearchRequest, context?: ProviderContext): Promise<PlaceSearchResult> {
        this.called = true;
        expect(request.intent.categories).toEqual(["restaurant"]);
        return super.searchPlaces(request, context);
      }
    }
    const provider = new RecordingProvider();
    const response = await new SearchRestaurantsTool(provider).execute({
      group: { scenario: "solo", totalPeople: 1, maleCount: 0, femaleCount: 0, leadRole: "solo_relax", ageGroup: { youngChildren: 0, teens: 0, adults: 1, seniors: 0 }, preferences: { dieting: false, budget: "medium", dietaryRestrictions: [], preferredCuisine: [], inferredDietary: { lowCalorie: false, lightDiet: false, softFood: false, kidsFriendly: false, restrictions: [] } } },
      timeWindow: { start: "10:00", end: "18:00", durationHours: 8 },
      distance: { hardMaxKm: 5 }, origin,
    });
    expect(response.status).toBe("success");
    expect(provider.called).toBe(true);
  });
});
