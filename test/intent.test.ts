// ============================================================
// test/intent.test.ts — 意图解析：场景与角色识别（回归保护）
// 时间窗一致性见 test/timewindow.test.ts
// ============================================================

import { describe, it, expect } from "vitest";
import { parseIntent } from "../src/intent/parser.js";

describe("意图解析 - 场景与角色", () => {
  it("女朋友约会 → couple/partner", () => {
    const c = parseIntent("想和女朋友出去约会");
    expect(c.group.scenario).toBe("couple");
    expect(c.group.leadRole).toBe("partner");
  });

  it("带5岁孩子 → family/kids，且识别幼儿", () => {
    const c = parseIntent("和老婆孩子出去玩，孩子5岁");
    expect(c.group.scenario).toBe("family");
    expect(c.group.leadRole).toBe("kids");
    expect(c.group.ageGroup.youngChildren).toBeGreaterThan(0);
  });

  it("只解析距离约束，不凭空制造当前位置", () => {
    const c = parseIntent("下午出去玩，附近一点");
    expect(c.distance.preferredMaxKm).toBe(15);
    expect(c.distance).not.toHaveProperty("homeLocation");
    expect(JSON.stringify(c)).not.toContain("lat");
    expect(JSON.stringify(c)).not.toContain("lng");
  });
});
