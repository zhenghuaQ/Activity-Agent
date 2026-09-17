import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server/app.js";
import { getProfileStore } from "../src/profile/store.js";
import { checkRateLimit, resetRateLimit } from "../src/server/ratelimit.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await getProfileStore().remove("test_profile_xyz");
  await app.close();
});

describe("GET /health", () => {
  it("返回状态与特性开关", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.flags).toBeDefined();
    expect(body.runtime).toBeDefined();
  });
});

describe("GET /api/segments", () => {
  it("返回全部分层", async () => {
    const res = await app.inject({ method: "GET", url: "/api/segments" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(7);
    expect(body[0]).toHaveProperty("segment");
    expect(body[0]).toHaveProperty("label");
  });
});

describe("POST /api/decide", () => {
  it("缺少 text 返回 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/decide", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("返回带帕累托与可解释的决策", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/decide",
      payload: { text: "朋友4人下午出去玩吃饭", segment: "quality_seeker" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.submissionId).toBeTruthy();
    expect(body.sessionId).toBeTruthy();
    expect(body.runId).toBeTruthy();
    expect(body.traceId).toBeTruthy();
    expect(body.decision).toBeDefined();
    expect(body.decision.recommended.objective).toBe("balanced");
    expect(body.selectedPlan.score.dimensions).toHaveLength(6);
  });
});

describe("SSE /api/decide/stream", () => {
  it("缺少 q 返回 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/decide/stream" });
    expect(res.statusCode).toBe(400);
  });
});

describe("画像 CRUD", () => {
  it("创建 → 获取 → 删除", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { id: "test_profile_xyz", name: "Tester", segment: "explorer" },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().segment).toBe("explorer");

    const get = await app.inject({ method: "GET", url: "/api/profiles/test_profile_xyz" });
    expect(get.statusCode).toBe(200);
    expect(get.json().name).toBe("Tester");

    const del = await app.inject({ method: "DELETE", url: "/api/profiles/test_profile_xyz" });
    expect(del.json().ok).toBe(true);

    const after = await app.inject({ method: "GET", url: "/api/profiles/test_profile_xyz" });
    expect(after.statusCode).toBe(404);
  });
});

describe("运行时降级开关", () => {
  it("可设置并读回", async () => {
    const set = await app.inject({
      method: "POST",
      url: "/api/admin/flags",
      payload: { forceMockIntent: true },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().forceMockIntent).toBe(true);

    const get = await app.inject({ method: "GET", url: "/api/admin/flags" });
    expect(get.json().forceMockIntent).toBe(true);
  });
});

describe("GET /api/metrics", () => {
  it("记录了请求量", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.json().requests).toBeGreaterThan(0);
  });
});

describe("GET /openapi.json", () => {
  it("返回 OpenAPI 文档", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\./);
    expect(res.json().paths["/api/decide"]).toBeDefined();
  });
});

describe("固定窗口限流", () => {
  it("超过上限即拦截（单元）", () => {
    resetRateLimit();
    const key = "unit-test-ip";
    let last = checkRateLimit(key, 3, 1000);
    expect(last.ok).toBe(true);
    checkRateLimit(key, 3, 1000);
    checkRateLimit(key, 3, 1000);
    last = checkRateLimit(key, 3, 1000); // 第 4 次
    expect(last.ok).toBe(false);
    expect(last.remaining).toBe(0);
  });

  it("HTTP 层：超限返回 429 且不破坏生命周期", async () => {
    resetRateLimit();
    const limited = buildServer({ rateLimitMax: 2, rateLimitWindowMs: 60_000 });
    await limited.ready();
    try {
      const r1 = await limited.inject({ method: "GET", url: "/health" });
      const r2 = await limited.inject({ method: "GET", url: "/health" });
      const r3 = await limited.inject({ method: "GET", url: "/health" });
      expect(r1.statusCode).toBe(200);
      expect(r2.statusCode).toBe(200);
      expect(r3.statusCode).toBe(429);
      expect(r3.json().error).toBe("rate_limited");
      expect(r1.headers["x-ratelimit-limit"]).toBe("2");
    } finally {
      await limited.close();
      resetRateLimit();
    }
  });
});
