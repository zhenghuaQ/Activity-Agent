import { describe, expect, it, vi } from "vitest";
import type {
  DefaultLocationProvider,
  GeoIpProvider,
  GeocodingProvider,
  LocationRequest,
  ResolvedLocation,
} from "../spec/location.js";
import { createAgentState, type AgentState } from "../spec/agent.js";
import type { GeoLocation } from "../spec/types.js";
import { DefaultLocationResolver } from "../src/location/service.js";
import { GetUserLocationTool } from "../src/tools/location.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { ToolExecutor } from "../src/runtime/tool-executor.js";
import { AgentRuntime } from "../src/runtime/index.js";

const A: GeoLocation = { lat: 39.9, lng: 116.3, address: "A", city: "北京" };
const B: GeoLocation = { lat: 31.2, lng: 121.4, address: "B", city: "上海" };

class FixtureGeocoder implements GeocodingProvider {
  constructor(private readonly result: GeoLocation | null, private readonly error?: Error) {}
  geocode = vi.fn(async (_address: string): Promise<GeoLocation | null> => {
    if (this.error) throw this.error;
    return this.result;
  });
}

class FixtureIpProvider implements GeoIpProvider {
  constructor(private readonly result: GeoLocation | null, private readonly error?: Error) {}
  locateIp = vi.fn(async (_ip?: string): Promise<GeoLocation | null> => {
    if (this.error) throw this.error;
    return this.result;
  });
}

class FixtureDefaultProvider implements DefaultLocationProvider {
  calls = 0;
  async getDefaultLocation(): Promise<GeoLocation> {
    this.calls += 1;
    return { ...B };
  }
}

function resolver(overrides: Partial<{
  geocoder: GeocodingProvider;
  ip: GeoIpProvider;
  fallback: DefaultLocationProvider;
}> = {}) {
  return new DefaultLocationResolver({
    geocodingProvider: overrides.geocoder ?? new FixtureGeocoder(null),
    geoIpProvider: overrides.ip ?? new FixtureIpProvider(null),
    defaultLocationProvider: overrides.fallback ?? new FixtureDefaultProvider(),
  });
}

describe("LocationResolver dependency boundary", () => {
  it("coords bypasses every capability provider", async () => {
    const geocoder = new FixtureGeocoder(A);
    const ip = new FixtureIpProvider(A);
    const fallback = new FixtureDefaultProvider();
    const result = await resolver({ geocoder, ip, fallback }).resolve({ kind: "coords", lat: A.lat, lng: A.lng, city: A.city });
    expect(result).toMatchObject({ source: "coords", location: { lat: A.lat, lng: A.lng, city: A.city } });
    expect(geocoder.geocode).not.toHaveBeenCalled();
    expect(ip.locateIp).not.toHaveBeenCalled();
    expect(fallback.calls).toBe(0);
  });

  it("geocode success and no-result fallback are distinct", async () => {
    const fallback = new FixtureDefaultProvider();
    const success = await resolver({ geocoder: new FixtureGeocoder(A), fallback }).resolve({ kind: "address", address: "地址" });
    expect(success).toEqual({ source: "geocode", location: A });
    const noResult = await resolver({ geocoder: new FixtureGeocoder(null), fallback }).resolve({ kind: "address", address: "未知" });
    expect(noResult).toEqual({ source: "default", location: B });
    expect(fallback.calls).toBe(1);
  });

  it("geocode exceptions propagate instead of falling back", async () => {
    await expect(resolver({ geocoder: new FixtureGeocoder(null, new Error("geocoder_down")) })
      .resolve({ kind: "address", address: "地址" })).rejects.toThrow("geocoder_down");
  });

  it("IP success, no-result fallback, and exception preserve semantics", async () => {
    await expect(resolver({ ip: new FixtureIpProvider(A) }).resolve({ kind: "ip", ip: "203.0.113.1" }))
      .resolves.toEqual({ source: "ip", location: A });
    await expect(resolver({ ip: new FixtureIpProvider(null) }).resolve({ kind: "ip" }))
      .resolves.toMatchObject({ source: "default", location: B });
    await expect(resolver({ ip: new FixtureIpProvider(null, new Error("ip_down")) }).resolve({ kind: "ip" }))
      .rejects.toThrow("ip_down");
  });

  it("default requests only call the default provider", async () => {
    const geocoder = new FixtureGeocoder(A);
    const ip = new FixtureIpProvider(A);
    const fallback = new FixtureDefaultProvider();
    await expect(resolver({ geocoder, ip, fallback }).resolve({ kind: "default" }))
      .resolves.toEqual({ source: "default", location: B });
    expect(geocoder.geocode).not.toHaveBeenCalled();
    expect(ip.locateIp).not.toHaveBeenCalled();
    expect(fallback.calls).toBe(1);
  });

  it("GetUserLocationTool consumes an injected resolver and ToolExecutor classifies failures", async () => {
    const fixed: ResolvedLocation = { source: "coords", location: A };
    const injected = { resolve: vi.fn(async (_request: LocationRequest) => fixed) };
    const tool = new GetUserLocationTool(injected);
    const success = await tool.execute({ kind: "default" });
    expect(success.status).toBe("success");
    expect(injected.resolve).toHaveBeenCalledWith({ kind: "default" });

    const registry = createToolRegistry({ locationResolver: { resolve: async () => { throw new Error("resolver_down"); } } });
    const executor = new ToolExecutor(createAgentState({ rawText: "location" }), { registry, maxRetries: 1 });
    const response = await executor.execute("get_user_location", { kind: "default" });
    expect(response.status).toBe("error");
    if (response.status === "error") expect(response.errorInfo.code).toBe("E_EXECUTION_FAILED");
  });

  it("two injected Runtime registries keep location state isolated", async () => {
    const runtimeA = new AgentRuntime({
      toolRegistry: createToolRegistry({ locationResolver: { resolve: async () => ({ source: "coords", location: A }) } }),
    });
    const runtimeB = new AgentRuntime({
      toolRegistry: createToolRegistry({ locationResolver: { resolve: async () => ({ source: "coords", location: B }) } }),
    });
    const [a, b] = await Promise.all([
      runtimeA.submit("周末逛展", { sessionId: "location-a" }),
      runtimeB.submit("周末逛展", { sessionId: "location-b" }),
    ]);
    const stateA = (a.result as { agentState: AgentState }).agentState;
    const stateB = (b.result as { agentState: AgentState }).agentState;
    expect(stateA.environment.location?.location).toEqual(A);
    expect(stateB.environment.location?.location).toEqual(B);
    runtimeA.shutdown();
    runtimeB.shutdown();
  });
});
