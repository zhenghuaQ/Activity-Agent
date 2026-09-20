// ============================================================
// test/tool-defs.test.ts — 工具 LLM 定义契约测试
//
// 第 2 课产物：验证每个工具都有 description + JSON Schema，
// 且与注册表一一对应（agent loop 的前提）。
// ============================================================

import { describe, expect, test } from "vitest";
import { toolRegistry } from "../src/tools/registry.js";
import { TOOL_DEFS } from "../spec/tools.js";

describe("工具 LLM 定义（Claude Code 式工具接口）", () => {
  test("spec 中 TOOL_DEFS 与 registry 注册的工具一一对应", () => {
    const names = toolRegistry.list().sort();
    expect(Object.keys(TOOL_DEFS).sort()).toEqual(names);
  });

  test("每个工具的 description 非空且足够具体", () => {
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
      expect(def.description.length, `${name} description 过短`).toBeGreaterThan(10);
    }
  });

  test("每个工具的 inputSchema 是合法的 object 类型", () => {
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
      expect(def.inputSchema.type, `${name} schema 缺失`).toBe("object");
      expect(typeof def.inputSchema.properties, `${name} properties 缺失`).toBe("object");
    }
  });

  test("registry.llmDefinitions() 输出 OpenAI 兼容的 function tool 格式", () => {
    const defs = toolRegistry.llmDefinitions();
    expect(defs).toHaveLength(9);

    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.name).toBeTruthy();
      expect(def.function.description.length).toBeGreaterThan(10);
      expect(def.function.parameters.type).toBe("object");
      expect(typeof def.function.parameters.properties).toBe("object");
    }

    const names = defs.map((d) => d.function.name).sort();
    expect(names).toEqual(toolRegistry.list().sort());
  });

  test("关键工具的 required 字段完整（模型必须传的核心参数）", () => {
    expect(TOOL_DEFS.search_attractions.inputSchema.required).toEqual([
      "crowdTags",
      "timeWindow",
      "distance",
    ]);
    expect(TOOL_DEFS.search_restaurants.inputSchema.required).toEqual([
      "group",
      "timeWindow",
      "distance",
    ]);
    expect(TOOL_DEFS.check_restaurant_availability.inputSchema.required).toEqual([
      "restaurantId",
      "diningTime",
      "partySize",
    ]);
    expect(TOOL_DEFS.estimate_transit.inputSchema.required).toEqual([
      "from",
      "to",
      "departureTime",
    ]);
  });
});
