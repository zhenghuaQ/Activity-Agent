import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/intent/parser.js";
import { mergeTurnConstraints } from "../src/conversation/memory.js";
import { evaluateRestaurantDietaryCompatibility } from "../src/constraints/dietary.js";
import type { Restaurant } from "../spec/types.js";

const restaurant = (overrides: Partial<Restaurant> = {}): Restaurant => ({
  id: "restaurant", name: "测试餐厅", type: "restaurant", address: "北京测试地址",
  location: { lat: 39.9, lng: 116.4, address: "北京测试地址", city: "北京" },
  distanceKm: 1, rating: 4.5, pricePerPerson: 100, crowdTags: [], localFeatures: [],
  cuisine: "日料", tags: [], avgDurationMinutes: 60, hasQueue: false, queueCount: 0,
  dietaryOptions: true, ...overrides,
});

describe("specific dietary compatibility", () => {
  it.each([
    ["不能吃海鲜", "免海鲜"],
    ["不要海鲜", "免海鲜"],
    ["不吃辣", "免辣"],
    ["不能吃辣", "免辣"],
  ])("canonicalizes %s to %s", (phrase, requirement) => {
    expect(parseIntent(`周末和朋友出去玩，${phrase}`).group.preferences.dietaryRestrictions).toContain(requirement);
  });

  it("keeps cuisine and dietary restriction as separate fields", () => {
    const parsed = parseIntent("周末和朋友出去玩，想吃日料，不能吃海鲜");
    expect(parsed.group.preferences.preferredCuisine).toContain("日料");
    expect(parsed.group.preferences.dietaryRestrictions).toEqual(["免海鲜"]);
  });

  it("uses explicit per-restriction evidence, reports unknown, and ANDs requirements", () => {
    expect(evaluateRestaurantDietaryCompatibility(restaurant(), ["免海鲜"]).requirements)
      .toEqual([{ requirement: "免海鲜", status: "unknown" }]);
    expect(evaluateRestaurantDietaryCompatibility(restaurant({ supportedDietaryRestrictions: ["免海鲜"] }), ["免海鲜", "免辣"]).passed).toBe(false);
    expect(evaluateRestaurantDietaryCompatibility(restaurant({ supportedDietaryRestrictions: ["免海鲜", "免辣"] }), ["免海鲜", "免辣"]).passed).toBe(true);
    expect(evaluateRestaurantDietaryCompatibility(restaurant({ unsupportedDietaryRestrictions: ["免海鲜"] }), ["免海鲜"]).requirements)
      .toEqual([{ requirement: "免海鲜", status: "unsupported" }]);
  });

  it("retains a prior canonical requirement through memory when a later turn adds cuisine", () => {
    const first = parseIntent("周末和朋友出去玩，不能吃海鲜");
    const merged = mergeTurnConstraints(first, parseIntent("想吃日料"), "想吃日料");
    expect(merged.group.preferences.dietaryRestrictions).toEqual(["免海鲜"]);
    expect(merged.group.preferences.preferredCuisine).toContain("日料");
  });
});
