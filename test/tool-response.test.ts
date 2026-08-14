// ============================================================
// test/tool-response.test.ts — 工具响应协议测试
//
// 验证三态协议（success/partial/error）、信封字段注入
// （stats/context）、工厂函数与错误码转换。
// 注意：ToolResponse 是判别式联合，访问 data/errorInfo 前
// 必须先窄化 status —— 这正是类型安全的设计意图。
// ============================================================

import { describe, expect, test } from "vitest";
import { BaseTool, ok, partial, err } from "../src/tools/base.js";
import { ToolError } from "../src/tools/errors.js";
import { ERROR_CODE_META } from "../spec/errors.js";
import type { JsonSchemaObject } from "../spec/tools.js";

// ─── 测试工具 ──────────────────────────────────────────

class EchoTool extends BaseTool<{ word: string }, { word: string }> {
  name = "echo";
  description = "测试工具：回显输入";
  inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { word: { type: "string" } },
    required: ["word"],
  };

  protected async run(input: { word: string }) {
    return { word: input.word };
  }
}

class TextTool extends BaseTool<Record<string, never>, string> {
  name = "text_tool";
  description = "测试工具：返回纯字符串答案";
  inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  protected async run() {
    return "这是纯文本答案";
  }
}

class PartialTool extends BaseTool<Record<string, never>, { found: number; total: number }> {
  name = "partial_tool";
  description = "测试工具：返回部分成功";
  inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  protected async run() {
    return partial("只找到 2/5 个结果", { found: 2, total: 5 }, { notes: ["已扩大半径重搜"] });
  }
}

class NotFoundTool extends BaseTool<{ id: string }, never> {
  name = "not_found_tool";
  description = "测试工具：抛出资源不存在错误";
  inputSchema: JsonSchemaObject = {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };

  protected async run(input: { id: string }): Promise<never> {
    throw new ToolError("E_RESOURCE_NOT_FOUND", `资源 ${input.id} 不存在`);
  }
}

class CrashTool extends BaseTool<Record<string, never>, never> {
  name = "crash_tool";
  description = "测试工具：抛出未分类异常";
  inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  protected async run(): Promise<never> {
    throw new Error("boom");
  }
}

class HugeTool extends BaseTool<Record<string, never>, { big: string }> {
  name = "huge_tool";
  description = "测试工具：返回超长裸数据";
  inputSchema: JsonSchemaObject = { type: "object", properties: {} };

  protected async run() {
    return { big: "x".repeat(10000) };
  }
}

// ─── 测试 ──────────────────────────────────────────────

describe("ToolResponse 三态协议", () => {
  test("裸数据自动包装为 success 信封，注入 stats 与 context", async () => {
    const res = await new EchoTool().execute({ word: "hello" });

    expect(res).toMatchObject({
      status: "success",
      data: { word: "hello" },
      context: { toolName: "echo", input: { word: "hello" } },
    });
    expect(res.text).toContain("hello");
    expect(res.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.stats.startedAt).toBeGreaterThan(0);
  });

  test("字符串直返成为 success 信封的 text", async () => {
    const res = await new TextTool().execute({});

    expect(res.status).toBe("success");
    expect(res.text).toBe("这是纯文本答案");
  });

  test("partial 信封原样透传，notes 保留在 context", async () => {
    const res = await new PartialTool().execute({});

    expect(res).toMatchObject({
      status: "partial",
      data: { found: 2, total: 5 },
      context: { toolName: "partial_tool", notes: ["已扩大半径重搜"] },
    });
  });

  test("ToolError 转为 error 信封，携带精确错误码与元数据", async () => {
    const res = await new NotFoundTool().execute({ id: "att_1" });

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.errorInfo.code).toBe("E_RESOURCE_NOT_FOUND");
      expect(res.errorInfo.category).toBe("resource");
      expect(res.errorInfo.retryable).toBe(false);
      expect(res.errorInfo.message).toBe("资源 att_1 不存在");
      expect(res.text).toContain("E_RESOURCE_NOT_FOUND");
      expect(res.text).toContain("att_1");
    }
  });

  test("未分类异常转为 E_EXECUTION_FAILED", async () => {
    const res = await new CrashTool().execute({});

    expect(res.status).toBe("error");
    if (res.status === "error") {
      expect(res.errorInfo.code).toBe("E_EXECUTION_FAILED");
      expect(res.errorInfo.message).toBe("boom");
      expect(res.errorInfo.retryable).toBe(true);
    }
  });

  test("错误码表五分类齐全，每条码都有元数据", () => {
    const categories = new Set(Object.values(ERROR_CODE_META).map((m) => m.category));
    expect(categories).toEqual(new Set(["resource", "param", "execution", "state", "network"]));

    for (const [code, meta] of Object.entries(ERROR_CODE_META)) {
      expect(code.startsWith("E_"), `${code} 应为 E_ 前缀`).toBe(true);
      expect(meta.defaultMessage.length).toBeGreaterThan(0);
    }
  });

  test("工厂函数 ok / partial / err 构造正确", () => {
    const success = ok("成功", [1, 2, 3], { source: "mock" });
    expect(success).toMatchObject({
      status: "success",
      data: [1, 2, 3],
      context: { source: "mock" },
    });

    const part = partial("部分成功", { n: 1 });
    expect(part.status).toBe("partial");

    const e = err("E_PARAM_INVALID", "人数超出范围");
    expect(e).toMatchObject({
      status: "error",
      errorInfo: { code: "E_PARAM_INVALID", category: "param" },
    });
  });

  test("裸数据自动生成 text 时超长内容被截断（保护 transcript）", async () => {
    const res = await new HugeTool().execute({});

    expect(res.status).toBe("success");
    expect(res.text.length).toBeLessThan(10000);
    expect(res.text).toContain("已截断");
  });
});
