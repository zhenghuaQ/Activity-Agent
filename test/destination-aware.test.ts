import { afterEach, describe, expect, it } from "vitest";
import { parseIntent } from "../src/intent/parser.js";
import { stage3_generateCandidates } from "../src/planner/stages.js";
import { resetDataSource, setDataProvider } from "../src/data/index.js";
import { MockProvider } from "../src/data/providers/mock-provider.js";
import { constraintEngine } from "../src/constraints/engine.js";
import { decisionFixture } from "./fixtures/decision.js";

afterEach(() => resetDataSource());

describe("destination-aware candidate generation", () => {
  it("does not silently substitute Beijing mock data for Shanghai", async () => {
    setDataProvider(new MockProvider());
    const constraints = parseIntent("这周末去上海玩");
    const state = await stage3_generateCandidates({ stage: "candidate_generation", constraints, errors: [] });
    expect(state.candidates).toEqual([]);
    expect(state.errors.join(" ")).toContain("不支持");
  });

  it("keeps local Beijing planning operational", async () => {
    setDataProvider(new MockProvider());
    const constraints = parseIntent("这周末在北京和朋友出去玩");
    const state = await stage3_generateCandidates({ stage: "candidate_generation", constraints, errors: [] });
    expect(state.resolvedSearchArea?.center.city).toBe("北京");
    expect(state.candidates?.length).toBeGreaterThan(0);
    expect(state.candidates?.every(candidate => candidate.plan.activities.every(activity => activity.place.location.city === "北京"))).toBe(true);
  });

  it("treats a cross-city candidate as a hard constraint failure", () => {
    const constraints = parseIntent("这周末去上海玩");
    const plan = decisionFixture().selectedPlan!;
    const evaluation = constraintEngine.evaluatePlan(plan, constraints);
    expect(evaluation.checks.some(check => check.rule === "within_destination" && !check.passed)).toBe(true);
    expect(evaluation.passed).toBe(false);
  });
});
