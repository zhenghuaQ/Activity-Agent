import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/intent/parser.js";
import { createInitialSearchPolicy } from "../src/planner/search-policy.js";
import { createAgentState } from "../spec/agent.js";
import { decideReplan } from "../src/runtime/replanner.js";
import { constraintEngine } from "../src/constraints/engine.js";
import type { Plan } from "../spec/types.js";

describe("distance hard/soft semantics", () => {
  it("does not manufacture a user distance constraint", () => {
    expect(parseIntent("周末逛展").distance).toEqual({});
    expect(createInitialSearchPolicy(parseIntent("周末逛展")).radiusKm).toBe(25);
  });

  it("distinguishes hard and preferred distance language", () => {
    expect(parseIntent("5公里以内逛展").distance).toEqual({ hardMaxKm: 5 });
    expect(parseIntent("最好5公里左右逛展").distance).toEqual({ preferredMaxKm: 5 });
    expect(parseIntent("5公里以内，最好3公里").distance).toEqual({ hardMaxKm: 5, preferredMaxKm: 3 });
  });

  it("caps replan expansion at hardMaxKm", () => {
    const constraints = parseIntent("5公里以内逛展");
    const state = createAgentState({ rawText: "5公里以内逛展" });
    state.planning = { stage: "fine_scheduling", constraints, searchPolicy: { radiusKm: 5, maxRadiusKm: 5 }, errors: [] };
    const decision = decideReplan(state, [{ passed: false, rule: "within_distance", detail: "超出" }]);
    expect(decision.shouldReplan).toBe(false);
    expect(decision.reason).toBe("SEARCH_RADIUS_HARD_CAP_REACHED");
  });

  it("initializes retrieval radius below a hard cap and keeps soft preference expandable", () => {
    expect(createInitialSearchPolicy(parseIntent("5公里以内逛展"))).toMatchObject({ radiusKm: 5, maxRadiusKm: 5 });
    expect(createInitialSearchPolicy(parseIntent("最好5公里左右逛展"))).toMatchObject({ radiusKm: 5, maxRadiusKm: 30 });
  });

  it("does not treat preferred distance as a hard violation", () => {
    const constraints = parseIntent("最好5公里左右逛展");
    const plan = { activities: [], leadRole: "friends_group" } as unknown as Plan;
    const result = constraintEngine.evaluatePlan(plan, constraints);
    expect(result.checks.some((check) => check.rule === "within_distance")).toBe(false);
  });
});
