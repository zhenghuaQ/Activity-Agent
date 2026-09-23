import { afterEach, describe, expect, it } from "vitest";
import { AgentRuntime, createAgentInput } from "../src/runtime/index.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { resetDataSource, setDataProvider } from "../src/data/index.js";
import type { PlaceSearchRequest, PlaceSearchResult } from "../spec/place-search.js";
import type { ProviderContext } from "../spec/datasource.js";
import { ATTRACTIONS, BREAK_PLACES, RESTAURANTS } from "../src/data/mock.js";
import type { AgentState } from "../spec/agent.js";

function fixtureData(prefix: string) {
  return {
    attractions: ATTRACTIONS.slice(0, 2).map((place) => ({
      ...place,
      id: `${prefix}_${place.id}`,
      name: `${prefix}-${place.name}`,
      address: `${prefix}-${place.address}`,
    })),
    restaurants: RESTAURANTS.slice(0, 2).map((place) => ({
      ...place,
      id: `${prefix}_${place.id}`,
      name: `${prefix}-${place.name}`,
      address: `${prefix}-${place.address}`,
    })),
    breakPlaces: BREAK_PLACES.slice(0, 2).map((place) => ({
      ...place,
      id: `${prefix}_${place.id}`,
      name: `${prefix}-${place.name}`,
      address: `${prefix}-${place.address}`,
    })),
  };
}

class RecordingProvider extends MockProvider {
  readonly calls: string[] = [];
  destinationCalls = 0;
  geocodeCalls = 0;
  attractionLookupCalls = 0;

  constructor(readonly marker: string, prefix = marker) {
    super(fixtureData(prefix));
  }

  override async searchPlaces(
    request: PlaceSearchRequest,
    context?: ProviderContext,
  ): Promise<PlaceSearchResult> {
    this.calls.push(this.marker);
    return super.searchPlaces(request, context);
  }

  override async resolveDestination(...args: Parameters<MockProvider["resolveDestination"]>) {
    this.destinationCalls += 1;
    return super.resolveDestination(...args);
  }

  override async geocode(...args: Parameters<MockProvider["geocode"]>) {
    this.geocodeCalls += 1;
    return super.geocode(...args);
  }

  override async getAttractionById(...args: Parameters<MockProvider["getAttractionById"]>) {
    this.attractionLookupCalls += 1;
    return super.getAttractionById(...args);
  }
}

afterEach(() => resetDataSource());

describe("per-runtime activity data provider isolation", () => {
  it("keeps the no-argument registry construction compatible", () => {
    expect(createToolRegistry().get("search_places")).toBeDefined();
  });

  it("keeps concurrent Runtime A/B provider calls isolated", async () => {
    const providerA = new RecordingProvider("A");
    const providerB = new RecordingProvider("B");
    const runtimeA = new AgentRuntime({
      toolRegistry: createToolRegistry({ dataProvider: providerA }),
    });
    const runtimeB = new AgentRuntime({
      toolRegistry: createToolRegistry({ dataProvider: providerB }),
    });

    try {
      const [resultA, resultB] = await Promise.all([
        runtimeA.submit(createAgentInput("周末逛展"), { sessionId: "provider_isolation_a" }),
        runtimeB.submit(createAgentInput("周末逛展"), { sessionId: "provider_isolation_b" }),
      ]);

      expect(resultA.status).toBe("completed");
      expect(resultB.status).toBe("completed");
      expect(providerA.calls.length).toBeGreaterThan(0);
      expect(providerB.calls.length).toBeGreaterThan(0);
      expect(providerA.calls.every((marker) => marker === "A")).toBe(true);
      expect(providerB.calls.every((marker) => marker === "B")).toBe(true);
      const stateA = (resultA.result as { agentState: AgentState }).agentState;
      const stateB = (resultB.result as { agentState: AgentState }).agentState;
      const namesA = (stateA.planning.candidates ?? []).flatMap((candidate) =>
        candidate.plan.activities.map((activity) => activity.place.name));
      const namesB = (stateB.planning.candidates ?? []).flatMap((candidate) =>
        candidate.plan.activities.map((activity) => activity.place.name));
      expect(namesA.length).toBeGreaterThan(0);
      expect(namesB.length).toBeGreaterThan(0);
      expect(namesA.every((name) => name.startsWith("A-"))).toBe(true);
      expect(namesB.every((name) => name.startsWith("B-"))).toBe(true);
    } finally {
      runtimeA.shutdown();
      runtimeB.shutdown();
    }
  });

  it("does not let legacy global provider replace an explicit Runtime provider", async () => {
    const explicitProvider = new RecordingProvider("explicit");
    const legacyProvider = new RecordingProvider("legacy");
    setDataProvider(legacyProvider);
    const runtime = new AgentRuntime({
      toolRegistry: createToolRegistry({ dataProvider: explicitProvider }),
    });

    try {
      const result = await runtime.submit(createAgentInput("周末逛展"), {
        sessionId: "provider_isolation_explicit",
      });
      expect(result.status).toBe("completed");
      expect(explicitProvider.calls.length).toBeGreaterThan(0);
      expect(legacyProvider.calls).toEqual([]);
    } finally {
      runtime.shutdown();
    }
  });

  it("shares one injected provider across destination, geocoding, search, and availability", async () => {
    const provider = new RecordingProvider("shared");
    const registry = createToolRegistry({ dataProvider: provider });
    const destination = await registry.get("resolve_destination")!.execute({ destination: { city: "北京" } });
    const location = await registry.get("get_user_location")!.execute({
      kind: "address",
      address: "shared-北京市朝阳区望京西路",
    });
    const search = await registry.get("search_places")!.execute({
      spatial: { origin: { lat: 39.995, lng: 116.47, city: "北京" }, maxKm: 10 },
      intent: { categories: ["attraction"] },
    });
    const availability = await registry.get("check_attraction_availability")!.execute({
      attractionId: "shared_attr_001",
      arrivalTime: "14:00",
    });

    expect(destination.status).toBe("success");
    expect(location.status).toBe("success");
    expect(search.status).toBe("success");
    expect(availability.status).toBe("success");
    expect(provider.destinationCalls).toBe(1);
    expect(provider.geocodeCalls).toBe(1);
    expect(provider.calls.length).toBeGreaterThan(0);
    expect(provider.attractionLookupCalls).toBe(1);
  });
});
