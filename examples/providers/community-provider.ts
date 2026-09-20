import type { ActivityDataProviderV1, BreakPlaceQuery, DestinationQuery, PlaceQuery,
  ProviderCapabilities, ProviderContext, SearchArea } from "../../spec/datasource.js";
import type { Attraction, BreakPlace, GeoLocation, Restaurant } from "../../spec/types.js";
import { DataProviderError } from "../../src/data/provider-error.js";

/**
 * 最小社区 Provider 示例。实际项目可把 catalog 换成数据库、开放数据或自有 API。
 * 关键约束：不支持的城市必须抛错，不能返回另一个城市的数据。
 */
export class CommunityProvider implements ActivityDataProviderV1 {
  readonly apiVersion = 1 as const;
  readonly id = "community-example";
  readonly name = this.id;
  readonly capabilities: ProviderCapabilities = { destinationResolution: true, attractions: true,
    restaurants: true, breakPlaces: true, geocoding: false, lookupById: true };

  constructor(private readonly catalog: { center: GeoLocation; attractions: Attraction[];
    restaurants: Restaurant[]; breaks: BreakPlace[] }) {}

  async resolveDestination(query: DestinationQuery, _context?: ProviderContext): Promise<SearchArea> {
    if (query.city !== this.catalog.center.city) {
      throw new DataProviderError("destination_unsupported", `不支持目的地：${query.city}`, this.id);
    }
    return { destination: query, center: this.catalog.center, confidence: 1 };
  }
  async searchAttractions(query: PlaceQuery): Promise<Attraction[]> { return this.within(query, this.catalog.attractions); }
  async searchRestaurants(query: PlaceQuery): Promise<Restaurant[]> { return this.within(query, this.catalog.restaurants); }
  async searchBreakPlaces(query: BreakPlaceQuery): Promise<BreakPlace[]> { return this.within(query, this.catalog.breaks); }
  async getAttractionById(id: string): Promise<Attraction | undefined> { return this.catalog.attractions.find(item => item.id === id); }
  async getRestaurantById(id: string): Promise<Restaurant | undefined> { return this.catalog.restaurants.find(item => item.id === id); }
  async geocode(_address: string): Promise<GeoLocation | null> { return null; }

  private within<T extends Attraction | Restaurant | BreakPlace>(query: PlaceQuery, values: T[]): T[] {
    return values.filter(value => value.location.city === query.searchArea?.destination.city
      && value.distanceKm <= query.radiusKm).map(value => ({ ...value, source: {
        providerId: this.id, externalId: value.id, fetchedAt: Date.now(),
      } }));
  }
}
