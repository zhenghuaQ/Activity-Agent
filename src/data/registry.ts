import type { ActivityDataProviderV1 } from "../../spec/datasource.js";

export type DataProviderFactory = () => ActivityDataProviderV1;

export class DataProviderRegistry {
  private readonly factories = new Map<string, DataProviderFactory>();

  register(id: string, factory: DataProviderFactory, options: { replace?: boolean } = {}): void {
    const normalized = id.trim().toLowerCase();
    if (!normalized) throw new Error("invalid_data_provider_id");
    if (this.factories.has(normalized) && !options.replace) throw new Error(`duplicate_data_provider:${normalized}`);
    this.factories.set(normalized, factory);
  }

  create(id: string): ActivityDataProviderV1 {
    const normalized = id.trim().toLowerCase();
    const provider = this.factories.get(normalized)?.();
    if (!provider) throw new Error(`unknown_data_provider:${normalized}`);
    if (provider.apiVersion !== 1) throw new Error(`unsupported_data_provider_version:${provider.apiVersion}`);
    return provider;
  }

  has(id: string): boolean { return this.factories.has(id.trim().toLowerCase()); }
  list(): string[] { return [...this.factories.keys()].sort(); }
}
