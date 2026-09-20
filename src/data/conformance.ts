import type { ActivityDataProviderV1, DestinationQuery } from "../../spec/datasource.js";

export interface ProviderConformanceIssue { check: string; message: string }
export interface ProviderConformanceReport { providerId: string; apiVersion: number; passed: boolean; checks: number; issues: ProviderConformanceIssue[] }
export interface ProviderConformanceOptions { destination?: DestinationQuery; radiusKm?: number; requireResults?: boolean }

/** 社区 Provider 可直接调用的黑盒合规检查；不会修改数据。 */
export async function runProviderConformance(provider: ActivityDataProviderV1,
  options: ProviderConformanceOptions = {}): Promise<ProviderConformanceReport> {
  const destination = options.destination ?? { city: "北京" };
  const radiusKm = options.radiusKm ?? 30;
  const issues: ProviderConformanceIssue[] = [];
  let checks = 0;
  const check = (condition: boolean, name: string, message: string) => {
    checks++; if (!condition) issues.push({ check: name, message });
  };
  check(provider.apiVersion === 1, "apiVersion", "apiVersion 必须为 1");
  check(Boolean(provider.id?.trim()), "id", "Provider id 不能为空");
  check(Boolean(provider.capabilities), "capabilities", "必须声明 capabilities");
  try {
    const area = await provider.resolveDestination(destination);
    check(Boolean(area.center?.city), "resolveDestination.center", "目的地必须返回带城市的中心点");
    check(area.destination.city === destination.city, "resolveDestination.city", "不得静默替换目的地城市");
    check(area.confidence >= 0 && area.confidence <= 1, "resolveDestination.confidence", "confidence 必须处于 0..1");
    const query = { origin: area.center, destination, searchArea: area, radiusKm };
    const searches = [
      ["attractions", provider.capabilities.attractions, () => provider.searchAttractions(query)],
      ["restaurants", provider.capabilities.restaurants, () => provider.searchRestaurants(query)],
      ["breakPlaces", provider.capabilities.breakPlaces, () => provider.searchBreakPlaces(query)],
    ] as const;
    for (const [name, supported, execute] of searches) {
      if (!supported) continue;
      const places = await execute();
      check(Array.isArray(places), `${name}.array`, `${name} 必须返回数组`);
      if (options.requireResults !== false) check(places.length > 0, `${name}.results`, `${name} 合规样本应至少返回一项`);
      for (const place of places) {
        check(place.location.city.includes(destination.city) || destination.city.includes(place.location.city),
          `${name}.city`, `${place.name} 不属于 ${destination.city}`);
        check(place.distanceKm <= radiusKm, `${name}.radius`, `${place.name} 超出查询半径`);
        check(place.source?.providerId === provider.id, `${name}.source`, `${place.name} 缺少正确的数据来源`);
      }
    }
  } catch (error) {
    issues.push({ check: "execution", message: error instanceof Error ? error.message : String(error) });
  }
  return { providerId: provider.id, apiVersion: provider.apiVersion, passed: issues.length === 0, checks, issues };
}
