import { describe, expect, it } from "vitest";
import { createAgentState } from "../spec/agent.js";
import { createActivityRuntimePlan } from "../src/runtime/plan.js";
import { ActivityPlanner } from "../src/planner/activity-planner.js";

describe("Runtime → ActivityPlanner 边界", () => {
  it("Runtime Plan 应由 ActivityPlanner 创建并写入 AgentState", () => {
    const state = createAgentState(
      { rawText: "朋友下午逛展吃饭" },
      { runId: "run_test", sessionId: "sess_test", traceId: "trace_test" },
    );

    const defaultPlan = createActivityRuntimePlan();
    expect(defaultPlan.steps.map((step) => step.id)).toEqual([
      "context_resolution",
      "intent_parsing",
      "follow_up_questions",
      "candidate_generation",
      "feasibility_check",
      "fine_scheduling",
    ]);

    const planner = new ActivityPlanner({ maxReplans: 0 });
    expect(planner).toBeInstanceOf(ActivityPlanner);
    expect(state.runtimePlan).toBeUndefined();
  });
});
