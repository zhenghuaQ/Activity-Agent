import type { PlaceSearchRequest, PlaceSearchResult } from "../../spec/place-search.js";
import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import { randomUUID } from "node:crypto";
import type { GeoLocation, Place, Restaurant, StructuredConstraints } from "../../spec/types.js";
import { MockProvider } from "../../src/data/providers/mock-provider.js";
import { getCanonicalPlanIdentity } from "../../src/decision/plan-identity.js";
import { parseIntent } from "../../src/intent/parser.js";
import { AgentRuntime, InMemoryAgentEventBus, InMemorySessionStore, createAgentInput } from "../../src/runtime/index.js";
import { createToolRegistry } from "../../src/tools/registry.js";
import { FixtureLocationResolver } from "../shared/location.js";
import { runtimeCompletedWithoutInfrastructureFailure, runtimeEvidenceFromPlanResult } from "../decision/outcome.js";
import type { DecisionScenarioEnvironment } from "../decision/scenarios/schema.js";
import type { DecisionScenarioDataFixture } from "../decision/scenarios/schema.js";
import type { DiagnosticCandidate, DiagnosticRun, SearchObservation } from "./types.js";

function candidateProjection(place: Place): DiagnosticCandidate {
  const restaurant = place.type === "restaurant" ? place as Restaurant : undefined;
  return {
    id: place.id,
    type: place.type,
    name: place.name,
    city: place.location.city,
    distanceKm: place.distanceKm,
    rating: place.rating,
    ...(restaurant ? { cuisine: restaurant.cuisine, dietaryOptions: restaurant.dietaryOptions } : {}),
    tags: restaurant ? [...restaurant.tags] : [...place.crowdTags],
    localFeatures: [...place.localFeatures],
  };
}

class CapturingMockProvider extends MockProvider implements ActivityDataProviderV1 {
  readonly searches: SearchObservation[] = [];

  constructor(fixture: DecisionScenarioDataFixture) {
    super(fixture);
  }

  override async searchPlaces(request: PlaceSearchRequest, context?: { signal?: AbortSignal }): Promise<PlaceSearchResult> {
    const result = await super.searchPlaces(request, context);
    this.searches.push({
      categories: [...(request.intent.categories ?? [])],
      radiusKm: request.spatial.maxKm,
      requiredTags: [...(request.intent.requiredTags ?? [])],
      preferredTags: [...(request.intent.preferredTags ?? [])],
      cuisineFilter: [...(request.intent.filters?.cuisines ?? [])],
      dietaryRequirements: [...(request.intent.dietaryRequirements ?? [])],
      returnedIds: result.places.map(candidate => candidate.id),
      candidates: result.places.map(candidate => candidateProjection(candidate.detail)),
    });
    return result;
  }
}

export interface DiagnosticRunInput {
  label: string;
  turns: string[];
  environment: DecisionScenarioEnvironment;
  fixture?: DecisionScenarioDataFixture;
  transformConstraints?: (constraints: StructuredConstraints, turnIndex: number) => StructuredConstraints;
}

export async function runDiagnostic(input: DiagnosticRunInput): Promise<DiagnosticRun> {
  const fixture = input.fixture ?? input.environment.data;
  const provider = new CapturingMockProvider(structuredClone(fixture));
  const eventBus = new InMemoryAgentEventBus();
  const sessionStore = new InMemorySessionStore();
  const runtime = new AgentRuntime({
    eventBus,
    sessionStore,
    toolRegistry: createToolRegistry({
      dataProvider: provider,
      locationResolver: new FixtureLocationResolver(structuredClone(input.environment.location)),
    }),
    runOptions: { weather: "unknown", date: new Date("2026-09-26T12:00:00.000Z") },
  });
  const sessionId = `diagnostic-${input.label}-${randomUUID()}`;
  let memory: StructuredConstraints | undefined;
  let lastResult: import("../../src/planner/engine.js").PlanResult | undefined;
  let lastSubmissionStatus: import("../../src/runtime/submission.js").SubmissionStatus | undefined;
  const runtimeErrors: string[] = [];
  const turnSearches: SearchObservation[][] = [];
  const turnSnapshots: DiagnosticRun["turnSnapshots"] = [];
  try {
    for (const [turnIndex, userText] of input.turns.entries()) {
      const searchesBeforeTurn = provider.searches.length;
      const parsed = input.transformConstraints?.(parseIntent(userText), turnIndex) ?? parseIntent(userText);
      const submission = await runtime.submit(createAgentInput(userText, {
        config: {
          parseFn: () => structuredClone(parsed),
          ...(memory ? { baseConstraints: structuredClone(memory) } : {}),
          weather: "unknown",
          date: new Date("2026-09-26T12:00:00.000Z"),
        },
        context: { location: {
          kind: "coords",
          lat: input.environment.location.location.lat,
          lng: input.environment.location.location.lng,
          address: input.environment.location.location.address,
          city: input.environment.location.location.city,
        } },
      }), { sessionId, sessionRetention: "retained" });
      lastSubmissionStatus = submission.status;
      if (submission.result && typeof submission.result === "object" && "state" in submission.result) {
        lastResult = submission.result as import("../../src/planner/engine.js").PlanResult;
        memory = lastResult.state.constraints;
        const evidence = runtimeEvidenceFromPlanResult(lastResult);
        if (!evidence || !runtimeCompletedWithoutInfrastructureFailure(evidence)) {
          runtimeErrors.push(lastResult.message);
          if (submission.status !== "completed") runtimeErrors.push(submission.error ?? `submission_${submission.status}`);
        }
      } else {
        runtimeErrors.push(submission.error ?? "submission_result_missing");
      }
      turnSearches.push(structuredClone(provider.searches.slice(searchesBeforeTurn)));
      const turnSelectedPlan = lastResult?.state.selectedPlan;
      turnSnapshots.push({
        ...(lastResult ? { constraints: structuredClone(lastResult.state.constraints) } : {}),
        selectedPlanIds: turnSelectedPlan?.activities.map(activity => activity.place.id).sort() ?? [],
        pareto: (lastResult?.state.decision?.pareto ?? []).map(candidate => ({ id: getCanonicalPlanIdentity(candidate.plan), score: candidate.plan.score?.total, objective: candidate.objective })),
        ...(turnSelectedPlan?.score ? { scoreDimensions: turnSelectedPlan.score.dimensions.map(({ dimension, score, weight, weighted, reason }) => ({ dimension, score, weight, weighted, reason })) } : {}),
      });
    }
    const selected = lastResult?.state.selectedPlan;
    const finalEvidence = runtimeEvidenceFromPlanResult(lastResult);
    const activities = selected?.activities.map(activity => candidateProjection(activity.place)) ?? [];
    const decision = lastResult?.state.decision;
    return {
      label: input.label,
      userTurns: [...input.turns],
      runtimeStatus: lastResult?.agentState.status ?? lastSubmissionStatus,
      submissionStatus: lastSubmissionStatus,
      runtimeCompleted: Boolean(finalEvidence && runtimeCompletedWithoutInfrastructureFailure(finalEvidence)),
      businessMessage: lastResult?.message,
      constraints: memory ? structuredClone(memory) : undefined,
      hardMaxDurationMinutes: memory?.hardMaxDurationMinutes,
      searches: structuredClone(provider.searches),
      turnSearches,
      turnSnapshots,
      selectedPlan: selected ? {
        id: selected.id,
        summary: selected.summary,
        activities,
        totalTransitMinutes: selected.totalTransitMinutes,
        totalDurationHours: selected.totalDurationHours,
        ...(selected.score ? { score: {
          total: selected.score.total,
          confidence: selected.score.confidence,
          dimensions: selected.score.dimensions.map(({ dimension, score, weight, weighted, reason }) => ({ dimension, score, weight, weighted, reason })),
        } } : {}),
      } : undefined,
      pareto: (decision?.pareto ?? []).map(candidate => ({ id: getCanonicalPlanIdentity(candidate.plan), score: candidate.plan.score?.total, objective: candidate.objective })),
      candidateIds: [...new Set((lastResult?.state.candidates ?? []).flatMap(candidate => candidate.plan.activities.map(activity => activity.place.id)))].sort(),
      planningTermination: lastResult?.state.termination?.reason,
      hardRejectedCandidates: (lastResult?.state.rejectedCandidates ?? []).map(candidate => ({
        candidateId: candidate.candidateId,
        failures: candidate.hardFailures.map(check => ({
          rule: check.rule,
          ...(check.actualMinutes !== undefined ? { actualMinutes: check.actualMinutes } : {}),
          ...(check.limitMinutes !== undefined ? { limitMinutes: check.limitMinutes } : {}),
          ...(check.dietaryEvidence ? { dietaryEvidence: structuredClone(check.dietaryEvidence) } : {}),
        })),
      })),
      runtimeErrors,
      replanCount: lastResult?.agentState.replanCount ?? 0,
    };
  } finally {
    runtime.shutdown();
    sessionStore.clear();
  }
}

export function combineFixtures(...fixtures: DecisionScenarioDataFixture[]): DecisionScenarioDataFixture {
  return {
    attractions: fixtures.flatMap(fixture => fixture.attractions.map(item => structuredClone(item))),
    restaurants: fixtures.flatMap(fixture => fixture.restaurants.map(item => structuredClone(item))),
    breakPlaces: fixtures.flatMap(fixture => fixture.breakPlaces.map(item => structuredClone(item))),
    destinationCenters: Object.assign({}, ...fixtures.map(fixture => fixture.destinationCenters ?? {})),
  };
}

export function environmentAt(location: GeoLocation, data: DecisionScenarioDataFixture): DecisionScenarioEnvironment {
  return { location: { source: "coords", location: structuredClone(location) }, data: structuredClone(data) };
}
