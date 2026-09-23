import { describe, expect, it } from "vitest";
import type { GeoLocation } from "../spec/types.js";
import type { ProviderContext } from "../spec/datasource.js";
import type { PlaceSearchRequest, PlaceSearchResult } from "../spec/place-search.js";
import { createAgentState } from "../spec/agent.js";
import { AgentRun } from "../src/runtime/agent-run.js";
import { ActivityPlanner } from "../src/planner/activity-planner.js";
import { parseIntent } from "../src/intent/parser.js";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { createToolRegistry } from "../src/tools/registry.js";

function makeRun(input: Parameters<typeof AgentRun.create>[0]): AgentRun {
  return AgentRun.create(input, {
    runId: `run_context_${Math.random().toString(36).slice(2)}`,
    sessionId: "session_context",
    traceId: `trace_context_${Math.random().toString(36).slice(2)}`,
  });
}

async function runPlanner(run: AgentRun, provider: MockProvider = new MockProvider()): Promise<Awaited<ReturnType<ActivityPlanner["run"]>>> {
  return new ActivityPlanner({ maxReplans: 0 }).run(run, {
    parseFn: parseIntent,
    toolRegistry: createToolRegistry({ dataProvider: provider }),
  });
}

class ThrowingGeocoder extends MockProvider {
  override async geocode(_address: string, _context?: ProviderContext): Promise<GeoLocation | null> {
    throw new Error("geocoder_down");
  }
}

class RecordingProvider extends MockProvider {
  readonly origins: GeoLocation[] = [];

  override async searchPlaces(query: PlaceSearchRequest, context?: ProviderContext) {
    this.origins.push({ ...query.spatial.origin });
    return super.searchPlaces(query, context);
  }
}

class EmptySearchProvider extends MockProvider {
  override async searchPlaces(_query: PlaceSearchRequest, _context?: ProviderContext): Promise<PlaceSearchResult> {
    return { places: [], total: 0 };
  }
}

describe("Runtime context_resolution", () => {
  it("resolves explicit coords through ToolExecutor and stores the full result", async () => {
    const run = makeRun({
      rawText: "周末逛展",
      context: { location: { kind: "coords", lat: 39.9, lng: 116.4, city: "北京" } },
    });
    const result = await runPlanner(run);

    expect(result.success).toBe(true);
    expect(result.state.termination).toEqual({ reason: "plan_selected", code: "PLAN_SELECTED" });
    expect(run.state.environment.location).toMatchObject({
      source: "coords",
      location: { lat: 39.9, lng: 116.4, city: "北京" },
    });
    expect(run.state.toolCalls.filter((call) => call.toolName === "get_user_location")).toHaveLength(1);
    expect(run.state.toolCalls[0].input).toMatchObject({ kind: "coords", coordinatesProvided: true });
    expect(run.state.trace.some((event) => event.type === "step_started" && event.payload.stepType === "context_resolution")).toBe(true);
    expect(run.state.trace.some((event) => event.type === "step_finished" && event.payload.stepType === "context_resolution")).toBe(true);
  });

  it("uses the resolved coords as Stage 3 search origin", async () => {
    const provider = new RecordingProvider();
    const run = makeRun({
      rawText: "周末逛展",
      context: { location: { kind: "coords", lat: 39.9, lng: 116.3, city: "北京" } },
    });
    const result = await runPlanner(run, provider);

    expect(result.success).toBe(true);
    expect(provider.origins.length).toBeGreaterThan(0);
    expect(provider.origins.every((origin) => origin.lat === 39.9 && origin.lng === 116.3)).toBe(true);
  });

  it("keeps parser output identical while different Runtime locations change search origin", async () => {
    const rawText = "周末逛展";
    expect(parseIntent(rawText)).toEqual(parseIntent(rawText));

    const providerA = new RecordingProvider();
    const runA = makeRun({
      rawText,
      context: { location: { kind: "coords", lat: 39.9, lng: 116.3, city: "北京" } },
    });
    await runPlanner(runA, providerA);

    const providerB = new RecordingProvider();
    const runB = makeRun({
      rawText,
      context: { location: { kind: "coords", lat: 39.98, lng: 116.5, city: "北京" } },
    });
    await runPlanner(runB, providerB);

    expect(runA.state.planning.constraints).toEqual(runB.state.planning.constraints);
    expect(providerA.origins[0]).toMatchObject({ lat: 39.9, lng: 116.3 });
    expect(providerB.origins[0]).toMatchObject({ lat: 39.98, lng: 116.5 });
    expect(providerA.origins[0]).not.toEqual(providerB.origins[0]);
  });

  it("uses Runtime default environment as Stage 3 origin, not parser output", async () => {
    const provider = new RecordingProvider();
    const run = makeRun({ rawText: "周末逛展" });
    const result = await runPlanner(run, provider);

    expect(result.success).toBe(true);
    expect(run.state.environment.location?.source).toBe("default");
    expect(provider.origins.length).toBeGreaterThan(0);
    expect(provider.origins.every((origin) =>
      origin.lat === run.state.environment.location!.location.lat
      && origin.lng === run.state.environment.location!.location.lng)).toBe(true);
  });

  it("prefers resolved destination center over the current environment location", async () => {
    const provider = new RecordingProvider();
    const run = makeRun({
      rawText: "周末去北京玩",
      context: { location: { kind: "coords", lat: 39.9, lng: 116.3, city: "北京" } },
    });
    const result = await runPlanner(run, provider);

    expect(result.success).toBe(true);
    expect(run.state.environment.location?.location.lat).toBe(39.9);
    expect(provider.origins.length).toBeGreaterThan(0);
    expect(provider.origins.every((origin) =>
      origin.lat !== 39.9 || origin.lng !== 116.3)).toBe(true);
    expect(run.state.planning.resolvedSearchArea?.center).toMatchObject({ city: "北京" });
  });

  it("redacts precise coordinates from the ordinary tool_call trace payload", async () => {
    const run = makeRun({
      rawText: "周末逛展",
      context: { location: { kind: "coords", lat: 39.912345, lng: 116.412345 } },
    });
    await runPlanner(run);

    const event = run.state.trace.find((item) => item.type === "tool_call" && item.toolName === "get_user_location");
    expect(event?.type).toBe("tool_call");
    if (event?.type === "tool_call") {
      expect(JSON.stringify(event.payload.input)).not.toContain("39.912345");
      expect(event.payload.input).toMatchObject({ kind: "coords", coordinatesProvided: true });
    }
    const toolMessage = run.state.messages.find((message) => message.kind === "tool_result");
    expect(toolMessage?.kind).toBe("tool_result");
    if (toolMessage?.kind === "tool_result") {
      expect(toolMessage.summary).not.toContain("39.912345");
    }
  });

  it("resolves a missing hint through explicit default and still succeeds", async () => {
    const run = makeRun({ rawText: "周末逛展" });
    const result = await runPlanner(run);

    expect(result.success).toBe(true);
    expect(run.state.environment.location?.source).toBe("default");
    expect(run.state.toolCalls[0].input).toEqual({ kind: "default" });
    expect(run.state.trace.some((event) => event.type === "step_finished"
      && event.payload.stepType === "context_resolution"
      && event.payload.status === "running")).toBe(true);
  });

  it("writes one no-feasible termination only after a normal full run", async () => {
    const run = makeRun({ rawText: "周末逛展" });
    const result = await runPlanner(run, new EmptySearchProvider());

    expect(result.success).toBe(false);
    expect(result.state.stage).toBe("fine_scheduling");
    expect(result.state.termination).toEqual({ reason: "no_feasible_plan", code: "NO_CANDIDATES" });
    expect(run.state.trace.filter(event => event.type === "final")).toHaveLength(1);
    expect(run.state.trace.filter(event => event.type === "step_finished")).toHaveLength(6);
  });

  it("treats a valid address with no geocode result as successful default fallback", async () => {
    const run = makeRun({
      rawText: "周末逛展",
      context: { location: { kind: "address", address: "不存在的地址" } },
    });
    const result = await runPlanner(run, new MockProvider());

    expect(result.success).toBe(true);
    expect(run.state.environment.location?.source).toBe("default");
    expect(run.state.status).toBe("completed");
  });

  it("blocks candidate generation on a provider hard failure", async () => {
    const run = makeRun({
      rawText: "周末逛展",
      context: { location: { kind: "address", address: "北京市朝阳区望京" } },
    });
    const result = await runPlanner(run, new ThrowingGeocoder());

    expect(result.success).toBe(false);
    expect(result.state.termination).toBeUndefined();
    expect(run.state.status).toBe("failed");
    expect(run.state.environment.location).toBeUndefined();
    expect(run.state.toolCalls[0].errorCode).toBe("E_EXECUTION_FAILED");
    expect(run.state.trace.some((event) => event.type === "step_finished"
      && event.payload.stepType === "context_resolution"
      && event.payload.status === "failed")).toBe(true);
    expect(run.state.trace.some((event) => event.type === "step_started"
      && event.payload.stepType === "candidate_generation")).toBe(false);
  });

  it("blocks candidate generation on invalid explicit coords without default fallback", async () => {
    const run = makeRun({
      rawText: "周末逛展",
      context: { location: { kind: "coords", lat: 999, lng: 116 } },
    });
    const result = await runPlanner(run);

    expect(result.success).toBe(false);
    expect(run.state.environment.location).toBeUndefined();
    expect(run.state.toolCalls[0].errorCode).toBe("E_PARAM_INVALID");
    expect(run.state.trace.some((event) => event.type === "step_started"
      && event.payload.stepType === "candidate_generation")).toBe(false);
  });

  it("initializes environment without inventing a location", () => {
    const state = createAgentState({ rawText: "test" });
    expect(state.environment).toEqual({});
  });
});
