import type { ResolvedLocation } from "../../../spec/location.js";
import type { DietaryRequirement } from "../../../spec/dietary.js";
import type {
  Attraction,
  BreakPlace,
  LeadRole,
  Restaurant,
} from "../../../spec/types.js";
import type { GeoLocation } from "../../../spec/types.js";

export const DECISION_BENCHMARK_VERSION = "decision-v3.1" as const;

export interface DecisionTurn {
  user: string;
}

export interface DecisionScenarioDataFixture {
  attractions: Attraction[];
  restaurants: Restaurant[];
  breakPlaces: BreakPlace[];
  destinationCenters?: Record<string, GeoLocation>;
}

export interface DecisionScenarioEnvironment {
  location: ResolvedLocation;
  data: DecisionScenarioDataFixture;
}

export interface ConstraintExpectationProjection {
  destinationCity?: string;
  leadRole?: LeadRole;
  budget?: "low" | "medium" | "high";
  preferredCuisine?: string[];
  dietaryRestrictions?: DietaryRequirement[];
  hardMaxKm?: number;
  preferredMaxKm?: number;
}

export interface DecisionHardConstraintExpectation {
  destinationCity?: string;
  maxDistanceKm?: number;
  dietaryRestrictions?: DietaryRequirement[];
}

export interface DecisionPreferenceExpectation {
  preferredMaxKm?: number;
  preferredCuisine?: string[];
  dietaryRestrictions?: DietaryRequirement[];
  leadRole?: LeadRole;
  desiredTags?: string[];
}

export type PreservedConstraint =
  | "destination"
  | "leadRole"
  | "budget"
  | "preferredCuisine"
  | "dietaryRestrictions"
  | "distance";

export interface DecisionAdaptationExpectation {
  afterTurn: number;
  requiredConstraintChanges?: ConstraintExpectationProjection;
  requiredPreferenceChanges?: DecisionPreferenceExpectation;
  preserved?: PreservedConstraint[];
}

export interface DecisionExpectations {
  expectedFeasibility: "feasible" | "infeasible";
  finalConstraints?: ConstraintExpectationProjection;
  hardConstraints: DecisionHardConstraintExpectation;
  preferences: DecisionPreferenceExpectation;
  adaptations?: DecisionAdaptationExpectation[];
}

export interface DecisionScenario {
  id: string;
  description: string;
  domain: "activity";
  turns: DecisionTurn[];
  environment: DecisionScenarioEnvironment;
  expectations: DecisionExpectations;
  tags: string[];
}

/** The agent-visible portion of a benchmark scenario; deliberately excludes ground truth. */
export type DecisionScenarioExecutionInput = Omit<DecisionScenario, "expectations">;
