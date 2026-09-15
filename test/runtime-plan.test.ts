import { describe, expect, it } from "vitest";
import { createAgentState } from "../spec/agent.js";
import {
  canRunConcurrently,
  createActivityRuntimePlan,
  getReadySteps,
  validateRuntimePlan,
} from "../src/runtime/plan.js";
import { executePlan } from "../src/runtime/executor.js";

describe("Runtime Plan / Executor", () => {
  it("default activity plan exposes the existing five stages in order", () => {
    const plan = createActivityRuntimePlan();

    expect(plan.steps.map((s) => s.type)).toEqual([
      "intent_parsing",
      "follow_up_questions",
      "candidate_generation",
      "feasibility_check",
      "fine_scheduling",
    ]);

    expect(plan.steps[1].dependsOn).toEqual(["intent_parsing"]);
    expect(plan.steps[4].dependsOn).toEqual(["feasibility_check"]);
    expect(plan.steps[2].writes).toEqual(["planning.candidates"]);
  });

  it("validates a DAG and rejects missing dependencies", () => {
    const valid = validateRuntimePlan({
      id: "dag",
      steps: [
        { id: "parse", type: "intent_parsing" },
        { id: "places", type: "candidate_generation", dependsOn: ["parse"] },
        { id: "restaurants", type: "candidate_generation", dependsOn: ["parse"] },
      ],
    });

    expect(valid.valid).toBe(true);
    expect(valid.errors).toEqual([]);

    const invalid = validateRuntimePlan({
      id: "missing-dependency",
      steps: [
        { id: "parse", type: "intent_parsing" },
        { id: "places", type: "candidate_generation", dependsOn: ["does-not-exist"] },
      ],
    });

    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.includes("does-not-exist"))).toBe(true);
  });

  it("rejects self-dependency and cycles", () => {
    const selfDependency = validateRuntimePlan({
      id: "self",
      steps: [{ id: "parse", type: "intent_parsing", dependsOn: ["parse"] }],
    });

    expect(selfDependency.valid).toBe(false);
    expect(selfDependency.errors.some((error) => error.includes("自身"))).toBe(true);

    const cycle = validateRuntimePlan({
      id: "cycle",
      steps: [
        { id: "a", type: "intent_parsing", dependsOn: ["b"] },
        { id: "b", type: "candidate_generation", dependsOn: ["a"] },
      ],
    });

    expect(cycle.valid).toBe(false);
    expect(cycle.errors.some((error) => error.includes("循环依赖"))).toBe(true);
  });

  it("computes the ready set from dependency completion", () => {
    const plan = {
      id: "parallel-ready-set",
      steps: [
        { id: "parse", type: "intent_parsing" as const },
        { id: "places", type: "candidate_generation" as const, dependsOn: ["parse"] },
        { id: "restaurants", type: "candidate_generation" as const, dependsOn: ["parse"] },
        {
          id: "decision",
          type: "fine_scheduling" as const,
          dependsOn: ["places", "restaurants"],
        },
      ],
    };

    expect(getReadySteps(plan, new Set()).map((step) => step.id)).toEqual(["parse"]);
    expect(getReadySteps(plan, new Set(["parse"])).map((step) => step.id)).toEqual([
      "places",
      "restaurants",
    ]);
    expect(getReadySteps(plan, new Set(["parse"]), new Set(["places"])).map((step) => step.id)).toEqual([
      "restaurants",
    ]);
    expect(getReadySteps(plan, new Set(["parse", "places", "restaurants"])).map((step) => step.id)).toEqual([
      "decision",
    ]);
  });

  it("detects resource conflicts for future parallel scheduling", () => {
    const readOnlyA = {
      id: "a",
      type: "candidate_generation" as const,
      reads: ["weather"],
    };
    const readOnlyB = {
      id: "b",
      type: "candidate_generation" as const,
      reads: ["weather"],
    };
    const writer = {
      id: "writer",
      type: "candidate_generation" as const,
      writes: ["weather"],
    };

    expect(canRunConcurrently(readOnlyA, readOnlyB)).toBe(true);
    expect(canRunConcurrently(readOnlyA, writer)).toBe(false);
    expect(canRunConcurrently(writer, writer)).toBe(false);
  });

  it("executor follows dependencies instead of relying on array order", async () => {
    const state = createAgentState({ rawText: "test" });
    const executed: string[] = [];
    const plan = {
      id: "out-of-order",
      steps: [
        {
          id: "decision",
          type: "fine_scheduling" as const,
          dependsOn: ["places", "restaurants"],
        },
        { id: "restaurants", type: "candidate_generation" as const, dependsOn: ["parse"] },
        { id: "parse", type: "intent_parsing" as const },
        { id: "places", type: "candidate_generation" as const, dependsOn: ["parse"] },
      ],
    };

    const next = await executePlan(plan, state, {
      handlers: {
        intent_parsing: async (current) => {
          executed.push("parse");
          return current;
        },
        follow_up_questions: async (current) => current,
        candidate_generation: async (current, step) => {
          executed.push(step.id);
          return current;
        },
        feasibility_check: async (current) => current,
        fine_scheduling: async (current) => {
          executed.push("decision");
          return current;
        },
      },
    });

    expect(executed).toEqual(["parse", "restaurants", "places", "decision"]);
    expect(next.currentStep).toBe("decision");
  });
});
