import { describe, expect, it } from "vitest";
import type { ProviderContext } from "../spec/datasource.js";
import type { PlaceSearchRequest, PlaceSearchResult } from "../spec/place-search.js";
import type { GeoLocation } from "../spec/types.js";
import type { StructuredConstraints } from "../spec/types.js";
import { parseIntent } from "../src/intent/parser.js";
import { ActivityPlanner } from "../src/planner/activity-planner.js";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { AgentRun } from "../src/runtime/agent-run.js";
import { classifyDecisionOutcome, runtimeCompletedWithoutInfrastructureFailure, runtimeEvidenceFromPlanResult } from "../eval/decision/outcome.js";

class RecoveringSearchProvider extends MockProvider {
  private firstExpandedSearch = true;
  readonly requestedRadii: number[] = [];

  override async searchPlaces(request: PlaceSearchRequest, context?: ProviderContext): Promise<PlaceSearchResult> {
    this.requestedRadii.push(request.spatial.maxKm);
    const categories = request.intent.categories ?? [];
    const planningCategory = categories.some((category) =>
      ["attraction", "museum", "park", "gallery", "restaurant"].includes(category));
    if (planningCategory && request.spatial.maxKm < 30) {
      return { places: [], total: 0 };
    }

    const result = await super.searchPlaces(request, context);
    if (!planningCategory) return result;

    if (this.firstExpandedSearch) {
      if (request.spatial.maxKm >= 30) this.firstExpandedSearch = false;
      return {
        total: result.total,
        places: result.places.map((candidate) => ({
          ...candidate,
          distanceKm: 45,
          detail: { ...candidate.detail, distanceKm: 45 },
        })),
      };
    }
    return result;
  }
}

describe("ActivityPlanner Replan Recovery E2E", () => {
  it("uses a valid lower-rated alternative without replanning when the top raw candidate violates hard distance", async () => {
    class OneOutOfRangeCandidateProvider extends MockProvider {
      override async searchPlaces(request: PlaceSearchRequest, context?: ProviderContext): Promise<PlaceSearchResult> {
        const result = await super.searchPlaces(request, context);
        const categories = request.intent.categories ?? [];
        if (!categories.some(category => ["attraction", "museum", "park", "gallery"].includes(category))) return result;
        const [first, ...rest] = result.places;
        if (!first) return result;
        return {
          total: result.total,
          places: [
            { ...first, rating: 5, distanceKm: 45, detail: { ...first.detail, rating: 5, distanceKm: 45 } },
            ...rest,
          ],
        };
      }
    }

    const run = AgentRun.create({ rawText: "周末带孩子出去玩" });
    const result = await new ActivityPlanner({ maxReplans: 2 }).run(run, {
      parseFn: text => {
        const parsed = parseIntent(text);
        parsed.distance.hardMaxKm = 40;
        return parsed;
      },
      toolRegistry: createToolRegistry({ dataProvider: new OneOutOfRangeCandidateProvider() }),
    });

    expect(result.success).toBe(true);
    expect(run.state.replanCount ?? 0).toBe(0);
    expect(run.state.candidateHardEvaluationHistory?.some(evaluation =>
      evaluation.hardFailures.some(failure => failure.rule === "within_distance"))).toBe(true);
    expect(result.state.selectedPlan?.activities.every(activity => activity.place.distanceKm <= 40)).toBe(true);
    expect(result.state.decision?.pareto.every(candidate =>
      candidate.plan.activities.every(activity => activity.place.distanceKm <= 40))).toBe(true);
  });

  it("recovers from initial out-of-constraint candidates and ends with plan_selected", async () => {
    const rawText = "周末带孩子出去玩";
    const run = AgentRun.create({ rawText });
    const provider = new RecoveringSearchProvider();
    const result = await new ActivityPlanner({ maxReplans: 2 }).run(run, {
      parseFn: (text) => {
        const constraints = parseIntent(text);
        constraints.distance.hardMaxKm = 40;
        return constraints satisfies StructuredConstraints;
      },
      toolRegistry: createToolRegistry({ dataProvider: provider }),
    });

    expect(run.state.trace.filter((event) => event.type === "replan")).toHaveLength(1);
    expect(run.state.replanCount).toBe(1);
    expect(result.state.searchPolicy?.radiusKm).toBe(40);
    expect(provider.requestedRadii).toContain(40);
    expect(result.state.selectedPlan).toBeDefined();
    expect(result.state.selectedPlan!.activities.every((activity) => activity.place.distanceKm <= 40)).toBe(true);
    expect(run.state.candidateHardEvaluationHistory?.some((evaluation) =>
      !evaluation.passed && evaluation.hardFailures.some((failure) => failure.rule === "within_distance"))).toBe(true);
    expect(result.state.candidates?.every((candidate) => candidate.plan.activities.every((activity) => activity.place.distanceKm <= 40))).toBe(true);
    expect(result.state.termination).toEqual({ reason: "plan_selected", code: "PLAN_SELECTED" });

    const evidence = runtimeEvidenceFromPlanResult(result);
    expect(evidence && runtimeCompletedWithoutInfrastructureFailure(evidence)).toBe(true);
    expect(classifyDecisionOutcome({
      expectedFeasibility: "feasible",
      runtimeCompleted: true,
      planningTermination: result.state.termination,
      planGenerated: true,
      hardConstraintsPassed: true,
    })).toBe("feasible_plan");
  });

  it("ends as no_feasible_plan when every hard-invalid candidate remains invalid after the supported replan is exhausted", async () => {
    class AlwaysOutOfRangeProvider extends MockProvider {
      private sawFirstExpanded = false;

      override async searchPlaces(request: PlaceSearchRequest, context?: ProviderContext): Promise<PlaceSearchResult> {
        const categories = request.intent.categories ?? [];
        const planningCategory = categories.some(category =>
          ["attraction", "museum", "park", "gallery", "restaurant"].includes(category));
        if (planningCategory && request.spatial.maxKm < 30) return { places: [], total: 0 };
        const result = await super.searchPlaces(request, context);
        if (!planningCategory) return result;
        if (request.spatial.maxKm >= 30) this.sawFirstExpanded = true;
        if (!this.sawFirstExpanded) return result;
        return {
          total: result.total,
          places: result.places.map(candidate => ({
            ...candidate,
            distanceKm: 45,
            detail: { ...candidate.detail, distanceKm: 45 },
          })),
        };
      }
    }

    const run = AgentRun.create({ rawText: "周末带孩子出去玩" });
    const result = await new ActivityPlanner({ maxReplans: 2 }).run(run, {
      parseFn: text => {
        const parsed = parseIntent(text);
        parsed.distance.hardMaxKm = 40;
        return parsed;
      },
      toolRegistry: createToolRegistry({ dataProvider: new AlwaysOutOfRangeProvider() }),
    });

    expect(result.state.termination).toEqual({ reason: "no_feasible_plan", code: "NO_SELECTABLE_PLAN" });
    expect(result.state.selectedPlan).toBeUndefined();
    expect(result.state.decision).toBeUndefined();
    expect(run.state.candidateHardEvaluationHistory?.some(evaluation => !evaluation.passed)).toBe(true);
    expect(run.state.replanCount).toBeGreaterThan(0);
    const evidence = runtimeEvidenceFromPlanResult(result);
    expect(evidence && runtimeCompletedWithoutInfrastructureFailure(evidence)).toBe(true);
    expect(classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: true,
      planningTermination: result.state.termination,
      planGenerated: false,
      hardConstraintsPassed: true,
    })).toBe("no_feasible_plan");
  });

  it("returns normal no_feasible_plan when every complete plan exceeds the explicit duration limit", async () => {
    const rawText = "周末带孩子出去玩，我只有2小时";
    const run = AgentRun.create({ rawText });
    const result = await new ActivityPlanner({ maxReplans: 0 }).run(run, {
      parseFn: text => parseIntent(text),
      toolRegistry: createToolRegistry({ dataProvider: new MockProvider() }),
    });

    expect(result.state.termination).toEqual({ reason: "no_feasible_plan", code: "NO_SELECTABLE_PLAN" });
    expect(result.state.selectedPlan).toBeUndefined();
    expect(result.state.rejectedCandidates?.length).toBeGreaterThan(0);
    expect(result.state.rejectedCandidates?.every(candidate =>
      candidate.hardFailures.some(failure => failure.rule === "within_requested_duration"))).toBe(true);
    const evidence = runtimeEvidenceFromPlanResult(result)!;
    expect(runtimeCompletedWithoutInfrastructureFailure(evidence)).toBe(true);
    expect(classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: true,
      planningTermination: result.state.termination,
      planGenerated: false,
      hardConstraintsPassed: true,
    })).toBe("no_feasible_plan");
  });

  it("preserves search-provider failures as runtime_failure instead of no_feasible_plan", async () => {
    class ThrowingSearchProvider extends MockProvider {
      override async searchPlaces(_request: PlaceSearchRequest, _context?: ProviderContext): Promise<PlaceSearchResult> {
        throw new Error("search_provider_down");
      }
    }

    const run = AgentRun.create({ rawText: "周末带孩子出去玩" });
    const result = await new ActivityPlanner({ maxReplans: 2 }).run(run, {
      parseFn: parseIntent,
      toolRegistry: createToolRegistry({ dataProvider: new ThrowingSearchProvider() }),
    });
    const evidence = runtimeEvidenceFromPlanResult(result)!;

    expect(result.state.termination).toBeUndefined();
    expect(run.state.status).toBe("failed");
    expect(result.message).toContain("规划未能完成");
    expect(result.message).not.toContain("没有找到满足");
    expect(run.state.toolCalls.some(call => call.status === "error")).toBe(true);
    expect(runtimeCompletedWithoutInfrastructureFailure(evidence)).toBe(false);
    expect(classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: false,
      planningTermination: result.state.termination,
      planGenerated: false,
      hardConstraintsPassed: true,
    })).toBe("runtime_failure");
  });

  it("preserves location-provider failures as runtime_failure instead of no_feasible_plan", async () => {
    class ThrowingGeocoder extends MockProvider {
      override async geocode(_address: string, _context?: ProviderContext): Promise<GeoLocation | null> {
        throw new Error("location_provider_down");
      }
    }

    const run = AgentRun.create({
      rawText: "周末带孩子出去玩",
      context: { location: { kind: "address", address: "测试地址" } },
    });
    const result = await new ActivityPlanner({ maxReplans: 2 }).run(run, {
      parseFn: parseIntent,
      toolRegistry: createToolRegistry({ dataProvider: new ThrowingGeocoder() }),
    });
    const evidence = runtimeEvidenceFromPlanResult(result)!;

    expect(result.state.termination).toBeUndefined();
    expect(run.state.status).toBe("failed");
    expect(result.message).toContain("规划未能完成");
    expect(result.message).not.toContain("没有找到满足");
    expect(run.state.toolCalls.some(call => call.status === "error")).toBe(true);
    expect(runtimeCompletedWithoutInfrastructureFailure(evidence)).toBe(false);
    expect(classifyDecisionOutcome({
      expectedFeasibility: "infeasible",
      runtimeCompleted: false,
      planningTermination: result.state.termination,
      planGenerated: false,
      hardConstraintsPassed: true,
    })).toBe("runtime_failure");
  });
});
