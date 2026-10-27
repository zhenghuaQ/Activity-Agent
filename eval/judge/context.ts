import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import type { DecisionScenario } from "../decision/scenarios/schema.js";

export interface JudgeReferenceContext {
  userGoal: string;
  destination?: string;
  group?: { leadRole?: string; size?: number };
  hardConstraints: { maxDistanceKm?: number; dietaryRestrictions: string[] };
  softPreferences: { preferredMaxKm?: number; preferredCuisine: string[]; desiredTags: string[] };
  expectedFeasibility: "feasible" | "infeasible";
  adaptationRequirements: Array<{
    afterTurn: number;
    requiredConstraintChanges?: object;
    requiredPreferenceChanges?: object;
    preserved?: string[];
  }>;
}

export interface JudgeDecisionContext {
  userVisibleConversation: Array<{ role: "user" | "assistant"; content: string }>;
  finalConstraints?: {
    destination?: string;
    leadRole?: string;
    groupSize?: number;
    budget?: string;
    preferredCuisine: string[];
    dietaryRestrictions: string[];
    hardMaxKm?: number;
    preferredMaxKm?: number;
  };
  planningTermination?: { reason: string; explanation?: string };
  selectedPlan?: {
    summary?: string;
    explanation?: string;
    activities: Array<{
      sequence: number;
      type: string;
      name: string;
      city: string;
      distanceKm: number;
      priceLevel?: number;
      cuisine?: string;
      tags: string[];
      startTime?: string;
      durationMinutes?: number;
    }>;
  };
  decisionExplanation?: string;
  finalResponse?: string;
}

export function buildJudgeReferenceContext(scenario: DecisionScenario): JudgeReferenceContext {
  const expected = scenario.expectations;
  const final = expected.finalConstraints;
  return {
    userGoal: scenario.turns.map(turn => turn.user).join("\n"),
    destination: final?.destinationCity ?? expected.hardConstraints.destinationCity,
    group: {
      leadRole: final?.leadRole ?? expected.preferences.leadRole,
    },
    hardConstraints: {
      maxDistanceKm: expected.hardConstraints.maxDistanceKm ?? final?.hardMaxKm,
      dietaryRestrictions: [...(expected.hardConstraints.dietaryRestrictions ?? final?.dietaryRestrictions ?? [])],
    },
    softPreferences: {
      preferredMaxKm: expected.preferences.preferredMaxKm ?? final?.preferredMaxKm,
      preferredCuisine: [...(expected.preferences.preferredCuisine ?? final?.preferredCuisine ?? [])],
      desiredTags: [...(expected.preferences.desiredTags ?? [])],
    },
    expectedFeasibility: expected.expectedFeasibility,
    adaptationRequirements: (expected.adaptations ?? []).map(adaptation => ({
      afterTurn: adaptation.afterTurn,
      ...(adaptation.requiredConstraintChanges ? { requiredConstraintChanges: structuredClone(adaptation.requiredConstraintChanges) } : {}),
      ...(adaptation.requiredPreferenceChanges ? { requiredPreferenceChanges: structuredClone(adaptation.requiredPreferenceChanges) } : {}),
      ...(adaptation.preserved ? { preserved: [...adaptation.preserved] } : {}),
    })),
  };
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function buildJudgeDecisionContext(result: DecisionScenarioRunOutput): JudgeDecisionContext {
  const selectedPlan = result.selectedPlan;
  return {
    userVisibleConversation: result.turnSnapshots.flatMap(turn => [
      { role: "user" as const, content: turn.userInput },
      ...(turn.userVisibleMessage ? [{ role: "assistant" as const, content: turn.userVisibleMessage }] : []),
    ]),
    ...(result.finalConstraints ? {
      finalConstraints: {
        destination: result.finalConstraints.destination?.city,
        leadRole: result.finalConstraints.group.leadRole,
        groupSize: result.finalConstraints.group.totalPeople,
        budget: result.finalConstraints.group.preferences.budget,
        preferredCuisine: [...(result.finalConstraints.group.preferences.preferredCuisine ?? [])],
        dietaryRestrictions: [...result.finalConstraints.group.preferences.dietaryRestrictions],
        hardMaxKm: result.finalConstraints.distance.hardMaxKm,
        preferredMaxKm: result.finalConstraints.distance.preferredMaxKm,
      },
    } : {}),
    ...(result.planningTermination ? {
      planningTermination: {
        reason: result.planningTermination.reason,
      },
    } : {}),
    ...(selectedPlan ? {
      selectedPlan: {
        summary: selectedPlan.summary,
        explanation: safeString(JSON.stringify(selectedPlan.explanation)),
        activities: selectedPlan.activities.map((activity, index) => ({
          sequence: activity.order || index + 1,
          type: activity.place.type,
          name: activity.place.name,
          city: activity.place.location.city,
          distanceKm: activity.place.distanceKm,
          priceLevel: activity.place.pricePerPerson,
          cuisine: "cuisine" in activity.place ? String(activity.place.cuisine) : undefined,
          tags: [...activity.place.crowdTags, ...activity.place.localFeatures],
          startTime: activity.scheduledStart,
          durationMinutes: Math.round((Date.parse(`1970-01-01T${activity.scheduledEnd}:00Z`) - Date.parse(`1970-01-01T${activity.scheduledStart}:00Z`)) / 60000),
        })),
      },
    } : {}),
    decisionExplanation: safeString(result.finalDecision?.recommended.reason),
    finalResponse: result.turnSnapshots.at(-1)?.userVisibleMessage,
  };
}
