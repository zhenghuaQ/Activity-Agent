import type { DecisionScenario } from "./schema.js";
import { haversineKm, roundKm } from "../../../src/core/geo.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`invalid_decision_scenario:${message}`);
}

function validCoordinate(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/** Necessary fixture-level feasibility check for this domain: a plan needs an attraction and a restaurant. */
export function scenarioHasFeasibleFixturePlan(scenario: DecisionScenario): boolean {
  const { data, location } = scenario.environment;
  const hard = scenario.expectations.hardConstraints;
  const destination = hard.destinationCity ?? scenario.expectations.finalConstraints?.destinationCity;
  const origin = destination
    ? Object.entries(data.destinationCenters ?? {}).find(([city]) =>
        city.includes(destination) || destination.includes(city))?.[1] ?? location.location
    : location.location;
  const maxDistanceKm = hard.maxDistanceKm ?? scenario.expectations.finalConstraints?.hardMaxKm;
  const attractions = data.attractions.filter(place =>
    (!destination || place.location.city.includes(destination) || destination.includes(place.location.city))
    && (maxDistanceKm === undefined || roundKm(haversineKm(origin, place.location)) <= maxDistanceKm));
  const restaurants = data.restaurants.filter(place =>
    (!destination || place.location.city.includes(destination) || destination.includes(place.location.city))
    && (maxDistanceKm === undefined || roundKm(haversineKm(origin, place.location)) <= maxDistanceKm)
    && (!hard.dietaryRestrictions?.length || place.dietaryOptions));
  return attractions.length > 0 && restaurants.length > 0;
}

export function validateDecisionScenario(scenario: DecisionScenario): DecisionScenario {
  assert(Boolean(scenario.id.trim()), "id_required");
  assert(scenario.domain === "activity", `${scenario.id}:domain`);
  assert(scenario.turns.length >= 2, `${scenario.id}:turns_minimum`);
  assert(Boolean(scenario.environment.location), `${scenario.id}:location_required`);
  assert(scenario.tags.length > 0, `${scenario.id}:tags_required`);
  assert(scenario.expectations.expectedFeasibility === "feasible"
    || scenario.expectations.expectedFeasibility === "infeasible", `${scenario.id}:expected_feasibility_required`);

  const fixture = scenario.environment.data;
  const places = [...fixture.attractions, ...fixture.restaurants, ...fixture.breakPlaces];
  assert(places.length > 0, `${scenario.id}:fixture_empty`);
  const ids = places.map((place) => place.id);
  assert(new Set(ids).size === ids.length, `${scenario.id}:duplicate_place_id`);
  for (const place of places) {
    assert(validCoordinate(place.location.lat, -90, 90), `${scenario.id}:invalid_lat:${place.id}`);
    assert(validCoordinate(place.location.lng, -180, 180), `${scenario.id}:invalid_lng:${place.id}`);
  }
  for (const [city, center] of Object.entries(fixture.destinationCenters ?? {})) {
    assert(validCoordinate(center.lat, -90, 90), `${scenario.id}:invalid_destination_lat:${city}`);
    assert(validCoordinate(center.lng, -180, 180), `${scenario.id}:invalid_destination_lng:${city}`);
  }

  const hard = scenario.expectations.hardConstraints;
  const final = scenario.expectations.finalConstraints;
  const preferredMax = scenario.expectations.preferences.preferredMaxKm ?? final?.preferredMaxKm;
  const hardMax = hard.maxDistanceKm ?? final?.hardMaxKm;
  if (preferredMax !== undefined) assert(preferredMax > 0, `${scenario.id}:preferred_max_invalid`);
  if (hardMax !== undefined) assert(hardMax > 0, `${scenario.id}:hard_max_invalid`);
  if (preferredMax !== undefined && hardMax !== undefined) {
    assert(preferredMax <= hardMax, `${scenario.id}:preferred_exceeds_hard`);
  }

  const destination = hard.destinationCity ?? final?.destinationCity;
  if (destination) {
    const fixtureCities = new Set(places.map((place) => place.location.city));
    assert([...fixtureCities].every((city) => city.includes(destination) || destination.includes(city)),
      `${scenario.id}:fixture_destination_mismatch`);
    assert(Object.keys(fixture.destinationCenters ?? {}).some((city) =>
      city.includes(destination) || destination.includes(city)), `${scenario.id}:destination_center_missing`);
  }

  if (scenario.expectations.expectedFeasibility === "infeasible") {
    assert(!scenarioHasFeasibleFixturePlan(scenario), `${scenario.id}:fixture_has_feasible_plan`);
  }

  const hasExpectation = Object.keys(scenario.expectations.hardConstraints).length > 0
    || Object.keys(scenario.expectations.preferences).length > 0
    || Boolean(scenario.expectations.finalConstraints)
    || (scenario.expectations.adaptations?.length ?? 0) > 0;
  assert(hasExpectation, `${scenario.id}:expectation_required`);

  for (const adaptation of scenario.expectations.adaptations ?? []) {
    assert(Number.isInteger(adaptation.afterTurn)
      && adaptation.afterTurn >= 1
      && adaptation.afterTurn <= scenario.turns.length,
    `${scenario.id}:invalid_adaptation_turn:${adaptation.afterTurn}`);
  }
  return scenario;
}

export function validateDecisionScenarios(scenarios: readonly DecisionScenario[]): DecisionScenario[] {
  const ids = scenarios.map((scenario) => scenario.id);
  assert(new Set(ids).size === ids.length, "duplicate_scenario_id");
  return scenarios.map(validateDecisionScenario);
}
