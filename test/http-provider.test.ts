import { describe, expect, it, vi } from "vitest";
import { HttpDataProvider } from "../src/data/providers/http-provider.js";
import { DataProviderRegistry } from "../src/data/registry.js";
import { decisionFixture } from "./fixtures/decision.js";

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ apiVersion: 1, data }), { status, headers: { "Content-Type": "application/json" } });
}

describe("HttpDataProvider", () => {
  it("uses the language-neutral v1 protocol and adds provenance", async () => {
    const plan = decisionFixture().selectedPlan!;
    const place = { ...plan.activities[0].place, location: { ...plan.activities[0].place.location,
      city: "上海", address: "上海市黄浦区测试地址" } };
    const fetchFn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/resolve-destination")) return envelope({ destination: { city: "上海" },
        center: { lat: 31.23, lng: 121.47, address: "上海市", city: "上海" }, confidence: 0.9 });
      if (url.endsWith("/v1/places/attractions/search")) return envelope([place]);
      return envelope([]);
    });
    const provider = new HttpDataProvider({ id: "community", baseUrl: "https://provider.example", token: "test-token",
      fetchFn: fetchFn as typeof fetch });
    const area = await provider.resolveDestination({ city: "上海" });
    const places = await provider.searchAttractions({ origin: area.center, destination: area.destination,
      searchArea: area, radiusKm: 10 });
    expect(places[0].source).toMatchObject({ providerId: "community", externalId: place.id });
    const request = fetchFn.mock.calls[0];
    expect(String(request[0])).toBe("https://provider.example/v1/resolve-destination");
    expect((request[1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-token",
      "X-Activity-Provider-Version": "1" });
  });

  it("rejects incompatible envelopes", async () => {
    const provider = new HttpDataProvider({ baseUrl: "https://provider.example",
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as typeof fetch });
    await expect(provider.resolveDestination({ city: "上海" })).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("DataProviderRegistry", () => {
  it("registers community factories and rejects duplicates or unknown providers", () => {
    const registry = new DataProviderRegistry();
    registry.register("community", () => new HttpDataProvider({ baseUrl: "https://provider.example" }));
    expect(registry.create("COMMUNITY").id).toBe("http");
    expect(() => registry.register("community", () => new HttpDataProvider({ baseUrl: "https://other.example" }))).toThrow("duplicate_data_provider");
    expect(() => registry.create("missing")).toThrow("unknown_data_provider");
  });
});
