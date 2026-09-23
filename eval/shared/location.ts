import type {
  LocationRequest,
  LocationResolver,
  ResolvedLocation,
} from "../../spec/location.js";

/** Deterministic resolver seam for Evaluation; never used by production defaults. */
export class FixtureLocationResolver implements LocationResolver {
  constructor(private readonly resolved: ResolvedLocation) {}

  async resolve(_request: LocationRequest): Promise<ResolvedLocation> {
    return {
      source: this.resolved.source,
      location: { ...this.resolved.location },
    };
  }
}
