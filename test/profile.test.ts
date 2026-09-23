import { describe, it, expect, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StructuredConstraints } from "../spec/types.js";
import {
  resolveWeights,
  inferSegment,
  applyProfileToConstraints,
  createProfile,
  touchProfileStats,
} from "../src/profile/profile.js";
import { ProfileStore } from "../src/profile/store.js";
import { runFullPipeline } from "../src/planner/engine.js";
import { parseIntent } from "../src/intent/parser.js";

function baseConstraints(overrides?: Partial<StructuredConstraints>): StructuredConstraints {
  return {
    group: {
      scenario: "friends",
      totalPeople: 4,
      maleCount: 2,
      femaleCount: 2,
      ageGroup: { youngChildren: 0, teens: 0, adults: 4, seniors: 0 },
      leadRole: "friends_group",
      preferences: {
        dieting: false,
        budget: "medium",
        dietaryRestrictions: [],
        preferredCuisine: [],
        inferredDietary: {
          lightDiet: false,
          kidsFriendly: false,
          lowCalorie: false,
          softFood: false,
          restrictions: [],
        },
      },
    },
    timeWindow: { start: "14:00", end: "18:00", durationHours: 4 },
    distance: { hardMaxKm: 25 },
    extraHints: [],
    ...overrides,
  };
}

describe("resolveWeights 权重先验", () => {
  it("归一化后和为 1", () => {
    const p = createProfile({ id: "u1", segment: "budget_conscious" });
    const w = resolveWeights(p);
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it("精打细算的预算权重高于品质党", () => {
    const budget = resolveWeights(createProfile({ id: "a", segment: "budget_conscious" }));
    const quality = resolveWeights(createProfile({ id: "b", segment: "quality_seeker" }));
    expect(budget.budget).toBeGreaterThan(quality.budget);
    expect(quality.preference).toBeGreaterThan(budget.preference);
  });

  it("自定义绝对权重覆盖分层先验", () => {
    const p = createProfile({
      id: "c",
      segment: "balanced",
      override: { weights: { transit: 0.9 } },
    });
    const w = resolveWeights(p);
    // transit 被显著抬高后，归一化仍应是最大维度
    const maxDim = Object.entries(w).sort((a, b) => b[1] - a[1])[0][0];
    expect(maxDim).toBe("transit");
  });
});

describe("inferSegment 自动分层", () => {
  it("有老人 → 舒适陪老", () => {
    const c = baseConstraints();
    c.group.ageGroup.seniors = 1;
    expect(inferSegment(c)).toBe("comfort_senior");
  });
  it("有幼儿 → 亲子优先", () => {
    const c = baseConstraints();
    c.group.ageGroup.youngChildren = 1;
    expect(inferSegment(c)).toBe("family_first");
  });
  it("低预算 → 精打细算", () => {
    const c = baseConstraints();
    c.group.preferences.budget = "low";
    expect(inferSegment(c)).toBe("budget_conscious");
  });
  it("打卡意图 → 尝鲜打卡", () => {
    const c = baseConstraints({ extraHints: ["拍照打卡"] });
    expect(inferSegment(c)).toBe("explorer");
  });
});

describe("applyProfileToConstraints 偏好合并", () => {
  it("自定义覆盖优先于请求与分层默认", () => {
    const c = baseConstraints();
    const p = createProfile({
      id: "u",
      segment: "quality_seeker",
      override: { budget: "low", maxDistanceKm: 8, preferredCuisine: ["云南菜"] },
    });
    const merged = applyProfileToConstraints(c, p);
    expect(merged.group.preferences.budget).toBe("low");
    expect(merged.distance.preferredMaxKm).toBe(8);
    expect(merged.group.preferences.preferredCuisine).toEqual(["云南菜"]);
  });

  it("分层距离默认作为上限收紧（只缩不放）", () => {
    const c = baseConstraints(); // 请求 25km
    // comfort_senior 默认 10km，无显式 override → 收紧到 10
    const senior = applyProfileToConstraints(
      c,
      createProfile({ id: "s", segment: "comfort_senior" })
    );
    expect(senior.distance.preferredMaxKm).toBe(10);

    // 请求已比默认更近时保持请求值（不放大）
    const near = applyProfileToConstraints(
      baseConstraints({ distance: { hardMaxKm: 6 } }),
      createProfile({ id: "s2", segment: "comfort_senior" })
    );
    expect(near.distance.hardMaxKm).toBe(6);

    // 无距离默认的分层（均衡）保持请求值
    const bal = applyProfileToConstraints(c, createProfile({ id: "b", segment: "balanced" }));
    expect(bal.distance.hardMaxKm).toBe(25);
  });

  it("忌口做并集", () => {
    const c = baseConstraints();
    c.group.preferences.dietaryRestrictions = ["免辣"];
    const p = createProfile({ id: "u", override: { dietaryRestrictions: ["低卡"] } });
    const merged = applyProfileToConstraints(c, p);
    expect(merged.group.preferences.dietaryRestrictions.sort()).toEqual(["低卡", "免辣"].sort());
  });
});

describe("touchProfileStats", () => {
  it("递增决策次数", () => {
    const p = createProfile({ id: "u" });
    const t = touchProfileStats(p);
    expect(t.stats.decisionCount).toBe(1);
    expect(t.updatedAt).toBeGreaterThanOrEqual(p.updatedAt);
  });
});

describe("ProfileStore 本地持久化", () => {
  const tmpFile = path.join(os.tmpdir(), `profiles-test-${Date.now()}.json`);

  afterAll(async () => {
    await fs.rm(tmpFile, { force: true });
  });

  it("upsert 后落盘，新实例可读回", async () => {
    const store = new ProfileStore(tmpFile);
    const p = createProfile({ id: "alice", name: "Alice", segment: "explorer" });
    await store.upsert(p);

    const reloaded = new ProfileStore(tmpFile);
    const got = await reloaded.get("alice");
    expect(got?.name).toBe("Alice");
    expect(got?.segment).toBe("explorer");
  });

  it("remove 删除画像", async () => {
    const store = new ProfileStore(tmpFile);
    await store.upsert(createProfile({ id: "bob" }));
    expect(await store.remove("bob")).toBe(true);
    expect(await store.get("bob")).toBeUndefined();
  });

  it("文件不存在时返回空集，不抛错", async () => {
    const store = new ProfileStore(path.join(os.tmpdir(), "no-such-dir-xyz", "p.json"));
    expect(await store.list()).toEqual([]);
  });
});

describe("pipeline 个性化差异", () => {
  it("不同画像导致权重侧重不同（预算维度权重）", async () => {
    const text = "朋友4人下午出去玩吃饭";
    const thrifty = await runFullPipeline(text, parseIntent, {
      profile: createProfile({ id: "t", segment: "budget_conscious" }),
    });
    const fancy = await runFullPipeline(text, parseIntent, {
      profile: createProfile({ id: "f", segment: "quality_seeker" }),
    });

    const budW = thrifty.state.selectedPlan?.score?.dimensions.find((d) => d.dimension === "budget")?.weight ?? 0;
    const budWFancy = fancy.state.selectedPlan?.score?.dimensions.find((d) => d.dimension === "budget")?.weight ?? 0;
    expect(budW).toBeGreaterThan(budWFancy);
  });
});
