// ============================================================
// src/data/index.ts — Provider Registry + 配置选择
// ============================================================

import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import { getAppConfig } from "../core/config.js";
import { childLogger } from "../core/logger.js";
import { AmapProvider } from "./providers/amap-provider.js";
import { HttpDataProvider } from "./providers/http-provider.js";
import { MockProvider } from "./providers/mock-provider.js";
import { DataProviderRegistry, type DataProviderFactory } from "./registry.js";

const log = childLogger("data:factory");
const registry = new DataProviderRegistry();
let active: ActivityDataProviderV1 | null = null;

registry.register("mock", () => new MockProvider());
registry.register("amap", () => {
  const apiKey = process.env.AMAP_API_KEY;
  if (!apiKey) throw new Error("AMAP_API_KEY is required for provider amap");
  return new AmapProvider({ apiKey, fallback: new MockProvider() });
});
registry.register("http", () => {
  const baseUrl = process.env.ACTIVITY_DATA_PROVIDER_URL;
  if (!baseUrl) throw new Error("ACTIVITY_DATA_PROVIDER_URL is required for provider http");
  return new HttpDataProvider({ id: process.env.ACTIVITY_DATA_PROVIDER_ID || "http", baseUrl,
    token: process.env.ACTIVITY_DATA_PROVIDER_TOKEN,
    timeoutMs: Number(process.env.ACTIVITY_DATA_PROVIDER_TIMEOUT_MS || 10_000) });
});

function configuredProviderId(): string {
  const selected = (process.env.ACTIVITY_DATA_PROVIDER || "auto").trim().toLowerCase();
  if (selected !== "auto") return selected;
  return getAppConfig().flags.amap && process.env.AMAP_API_KEY ? "amap" : "mock";
}

/**
 * Creates one provider instance at application composition time.
 * This is the preferred API for isolated Runtime/ToolRegistry instances.
 */
export function createDefaultDataProvider(): ActivityDataProviderV1 {
  const id = configuredProviderId();
  const provider = registry.create(id);
  log.info({ providerId: provider.id, apiVersion: provider.apiVersion }, "地点数据 Provider 已创建");
  return provider;
}

/** @deprecated Legacy process-global provider API. Prefer explicit injection. */
export function getDataProvider(): ActivityDataProviderV1 {
  if (!active) active = createDefaultDataProvider();
  return active;
}

/** @deprecated 使用 getDataProvider。 */
export const getDataSource = getDataProvider;

/** 社区接入点：在首次 getDataProvider() 或 createDefaultDataProvider() 前注册工厂。 */
export function registerDataProvider(id: string, factory: DataProviderFactory,
  options: { replace?: boolean } = {}): void {
  registry.register(id, factory, options);
}

export function listDataProviders(): string[] { return registry.list(); }

/** @deprecated Legacy process-global provider API. Prefer createToolRegistry({ dataProvider }). */
export function setDataProvider(provider: ActivityDataProviderV1): void { active = provider; }
/** @deprecated Legacy process-global provider API. */
export function resetDataSource(): void { active = null; }

export { MockProvider } from "./providers/mock-provider.js";
export { AmapProvider } from "./providers/amap-provider.js";
export { HttpDataProvider } from "./providers/http-provider.js";
export { DataProviderRegistry } from "./registry.js";
export { DataProviderError } from "./provider-error.js";
export { runProviderConformance } from "./conformance.js";
export { predictCrowd } from "./crowd.js";
