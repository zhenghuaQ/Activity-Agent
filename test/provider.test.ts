import { describe, it, expect, vi } from "vitest";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { AmapProvider } from "../src/data/providers/amap-provider.js";
import { HOME } from "../src/data/mock.js";
import type { GeoLocation } from "../spec/types.js";

const mock = new MockProvider();

describe("MockProvider", () => {
  it("以 HOME 为出发点，景点按距离升序且 distanceKm 已重算", async () => {
    const list = await mock.searchAttractions({ origin: HOME, radiusKm: 15 });
    expect(list.length).toBeGreaterThan(0);
    // 升序
    for (let i = 1; i < list.length; i++) {
      expect(list[i].distanceKm).toBeGreaterThanOrEqual(list[i - 1].distanceKm);
    }
  });

  it("换出发点后距离随之改变（证明动态计算）", async () => {
    const far: GeoLocation = { lat: 39.91, lng: 116.46, address: "国贸", city: "北京" };
    const fromHome = await mock.searchAttractions({ origin: HOME, radiusKm: 50 });
    const fromFar = await mock.searchAttractions({ origin: far, radiusKm: 50 });
    const sameId = fromHome[0].id;
    const a = fromHome.find((p) => p.id === sameId)!;
    const b = fromFar.find((p) => p.id === sameId)!;
    expect(a.distanceKm).not.toBe(b.distanceKm);
  });

  it("半径过滤生效", async () => {
    const tight = await mock.searchAttractions({ origin: HOME, radiusKm: 1 });
    const wide = await mock.searchAttractions({ origin: HOME, radiusKm: 50 });
    expect(wide.length).toBeGreaterThanOrEqual(tight.length);
  });

  it("按 id 取餐厅", async () => {
    const r = await mock.getRestaurantById("rest_001");
    expect(r?.name).toContain("望京");
  });

  it("does not convert cancellation into mock fallback", async () => {
    const fallback = new MockProvider();
    const fallbackSearch = vi.spyOn(fallback, "searchAttractions");
    const fetchMock = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new AmapProvider({ apiKey: "test-key", fallback });
    const controller = new AbortController();
    controller.abort(new Error("user_cancelled"));

    await expect(provider.searchAttractions({
      origin: { lat: 39.9, lng: 116.4, address: "北京", city: "北京" },
      radiusKm: 10,
    }, controller.signal)).rejects.toThrow("user_cancelled");
    expect(fallbackSearch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
