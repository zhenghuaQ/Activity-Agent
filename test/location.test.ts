import { afterEach, describe, it, expect, vi } from "vitest";
import { resolveLocation } from "../src/location/service.js";
import { HOME } from "../src/data/mock.js";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { resetDataSource, setDataProvider } from "../src/data/index.js";
import { resetAppConfig } from "../src/core/config.js";
import { GetUserLocationTool } from "../src/tools/location.js";
import { ToolExecutor } from "../src/runtime/tool-executor.js";
import { createAgentState } from "../spec/agent.js";

afterEach(() => {
  resetDataSource();
  resetAppConfig();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveLocation", () => {
  it("coords 直接透传经纬度", async () => {
    const r = await resolveLocation({ kind: "coords", lat: 31.23, lng: 121.47, city: "上海" });
    expect(r.source).toBe("coords");
    expect(r.location.lat).toBe(31.23);
    expect(r.location.city).toBe("上海");
  });

  it("default 回落 HOME", async () => {
    const r = await resolveLocation({ kind: "default" });
    expect(r.source).toBe("default");
    expect(r.location.address).toBe(HOME.address);
  });

  it("无 Key 时 address 经 Mock 名称匹配或降级，不抛错", async () => {
    const r = await resolveLocation({ kind: "address", address: "望京" });
    expect(r.location).toBeTruthy();
    expect(["geocode", "default"]).toContain(r.source);
  });

  it("coords input returns the complete ResolvedLocation", async () => {
    const response = await new GetUserLocationTool().execute({
      kind: "coords", lat: 31.23, lng: 121.47, city: "上海",
    });
    expect(response.status).toBe("success");
    if (response.status === "success") {
      expect(response.data.source).toBe("coords");
      expect(response.data.location).toMatchObject({ lat: 31.23, lng: 121.47, city: "上海" });
    }
  });

  it.each([
    [{ kind: "coords" as const, lat: 1000, lng: 116 }, "coords.lat"],
    [{ kind: "coords" as const, lat: 39.9 }, "coords.lng"],
  ])("rejects invalid coords input: %j", async (input, expectedMessage) => {
    const response = await new GetUserLocationTool().execute(input);
    expect(response.status).toBe("error");
    if (response.status === "error") {
      expect(response.errorInfo.code).toBe("E_PARAM_INVALID");
      expect(response.errorInfo.message).toContain(expectedMessage);
    }
  });

  it("address resolution returns geocode source on mock success", async () => {
    setDataProvider(new MockProvider());
    const response = await new GetUserLocationTool().execute({
      kind: "address", address: "北京市朝阳区望京西路",
    });
    expect(response.status).toBe("success");
    if (response.status === "success") expect(response.data.source).toBe("geocode");
  });

  it("address resolution keeps service default fallback on mock failure", async () => {
    setDataProvider(new MockProvider());
    const response = await new GetUserLocationTool().execute({
      kind: "address", address: "不存在的地址",
    });
    expect(response.status).toBe("success");
    if (response.status === "success") {
      expect(response.data.source).toBe("default");
      expect(response.data.location).toEqual(HOME);
    }
  });

  it("IP resolution returns ip source when the resolver succeeds", async () => {
    vi.stubEnv("AMAP_API_KEY", "test-key");
    vi.stubEnv("FEATURE_AMAP", "on");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({ status: "1", city: "上海市", rectangle: "121,30;122,31" }),
    })));
    const response = await new GetUserLocationTool().execute({ kind: "ip", ip: "203.0.113.1" });
    expect(response.status).toBe("success");
    if (response.status === "success") expect(response.data.source).toBe("ip");
  });

  it("IP provider exceptions remain infrastructure failures", async () => {
    vi.stubEnv("AMAP_API_KEY", "test-key");
    vi.stubEnv("FEATURE_AMAP", "on");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const response = await new GetUserLocationTool().execute({ kind: "ip" });
    expect(response.status).toBe("error");
    if (response.status === "error") expect(response.errorInfo.code).toBe("E_EXECUTION_FAILED");
  });

  it("default and legacy empty inputs resolve to default", async () => {
    const tool = new GetUserLocationTool();
    const explicit = await tool.execute({ kind: "default" });
    const legacy = await tool.execute({});
    expect(explicit.status).toBe("success");
    expect(legacy.status).toBe("success");
    if (explicit.status === "success" && legacy.status === "success") {
      expect(explicit.data.source).toBe("default");
      expect(legacy.data.source).toBe("default");
    }
  });

  it("is discoverable and records success/invalid failures through ToolExecutor", async () => {
    const state = createAgentState({ rawText: "location" });
    const executor = new ToolExecutor(state);
    const success = await executor.execute("get_user_location", {
      kind: "coords", lat: 39.9, lng: 116.4,
    });
    const failure = await executor.execute("get_user_location", {
      kind: "coords", lat: 1000, lng: 116.4,
    });
    expect(success.status).toBe("success");
    expect(failure.status).toBe("error");
    if (failure.status === "error") expect(failure.errorInfo.code).toBe("E_PARAM_INVALID");
    expect(state.toolCalls).toHaveLength(2);
    expect(state.toolCalls[0].input).toMatchObject({ kind: "coords", coordinatesProvided: true });
  });
});
