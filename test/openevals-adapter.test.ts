import { describe, expect, it } from "vitest";
import { runMultiturnSimulation, type ChatCompletionMessage } from "openevals";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import type { DecisionScenarioExecutionInput } from "../eval/decision/scenarios/schema.js";
import {
  createDecisionScenarioSession,
  evaluateDecisionScenario,
  runScenarioManual,
  type DecisionScenarioSession,
} from "../eval/decision/evaluators/conversation.js";
import { createOpenEvalsApp, type OpenEvalsAppAdapter } from "../eval/openevals/app-adapter.js";
import { runScenarioOpenEvals } from "../eval/openevals/scripted-runner.js";
import { scenarioScriptedResponses } from "../eval/openevals/scripted-user.js";

describe("OpenEvals fixed scripted adapter", () => {
  it.each([2, 4])("invokes the app exactly %i times for a scenario with that many user turns", async turnCount => {
    const scenario = DECISION_SCENARIOS.find(item => item.turns.length === turnCount)!;
    const sessionIds: string[] = [];
    const adapter = createOpenEvalsApp(scenario, true, (input, memoryEnabled, sessionId) => {
      sessionIds.push(sessionId!);
      return createDecisionScenarioSession(input, memoryEnabled, sessionId);
    });
    const calls: Array<{ input: unknown; threadId: string; keys: string[] }> = [];
    const threadId = `count-test-${turnCount}`;
    try {
      await runMultiturnSimulation({
        app: async args => {
          calls.push({ input: args.inputs, threadId: args.threadId, keys: Object.keys(args).sort() });
          return adapter.app(args);
        },
        user: scenarioScriptedResponses(scenario),
        maxTurns: scenario.turns.length,
        threadId,
      });
      expect(calls).toHaveLength(turnCount);
      expect(calls.map(call => (call.input as ChatCompletionMessage).content))
        .toEqual(scenario.turns.map(turn => turn.user));
      expect(calls.map(call => call.threadId)).toEqual(Array(turnCount).fill(threadId));
      expect(calls.every(call => JSON.stringify(call.keys) === JSON.stringify(["inputs", "threadId"]))).toBe(true);
      expect(sessionIds).toEqual([threadId]);
      expect(adapter.activeSessionCount()).toBe(1);
    } finally {
      adapter.disposeAll();
    }
    expect(adapter.activeSessionCount()).toBe(0);
  });

  it("uses one session for all turns and rejects a replayed or out-of-order scripted turn", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.turns.length === 2)!;
    let sessionsCreated = 0;
    const adapter = createOpenEvalsApp(scenario, true, (...args) => {
      sessionsCreated += 1;
      return createDecisionScenarioSession(...args);
    });
    const first = scenario.turns[0]!.user;
    const threadId = "stable-thread";
    try {
      await adapter.app({ inputs: { role: "user", content: first }, threadId });
      await expect(adapter.app({ inputs: { role: "user", content: first }, threadId }))
        .rejects.toThrow("openevals_scripted_turn_mismatch:2");
      expect(sessionsCreated).toBe(1);
      expect(adapter.activeSessionCount()).toBe(1);
    } finally {
      adapter.disposeAll();
    }
  });

  it("isolates distinct thread IDs within one app adapter", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.turns.length === 2)!;
    const adapter = createOpenEvalsApp(scenario);
    try {
      const [a, b] = await Promise.all([
        adapter.app({ inputs: { role: "user", content: scenario.turns[0]!.user }, threadId: "thread-a" }),
        adapter.app({ inputs: { role: "user", content: scenario.turns[0]!.user }, threadId: "thread-b" }),
      ]);
      expect(a.content).toBe(b.content);
      expect(adapter.activeSessionCount()).toBe(2);
      expect(adapter.getExecution("thread-a")?.turnSnapshots).toHaveLength(1);
      expect(adapter.getExecution("thread-b")?.turnSnapshots).toHaveLength(1);
    } finally {
      adapter.disposeAll();
    }
  });

  it("cleans up a session after an app exception", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.turns.length === 2)!;
    let disposed = 0;
    const brokenSession = {
      async runTurn(): Promise<never> { throw new Error("provider_fixture_failure"); },
      toOutput: () => ({
        scenarioId: scenario.id,
        turnSnapshots: [],
        runtime: { completed: false, durationMs: 0, toolCalls: 0, replans: 0, errors: ["provider_fixture_failure"] },
      }),
      dispose: () => { disposed += 1; },
    } as unknown as DecisionScenarioSession;
    const adapter = createOpenEvalsApp(scenario, true, () => brokenSession);
    await expect(adapter.app({
      inputs: { role: "user", content: scenario.turns[0]!.user },
      threadId: "failure-thread",
    })).rejects.toThrow("provider_fixture_failure");
    expect(adapter.activeSessionCount()).toBe(1);
    adapter.disposeAll();
    expect(disposed).toBe(1);
    expect(adapter.activeSessionCount()).toBe(0);
  });

  it("cleans up the session after a successful simulation", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.turns.length === 2)!;
    let adapter: OpenEvalsAppAdapter | undefined;
    const result = await runScenarioOpenEvals(scenario, true, "cleanup-success", (input, memoryEnabled) => {
      adapter = createOpenEvalsApp(input, memoryEnabled);
      return adapter;
    });
    expect(result.execution.runtime.completed).toBe(true);
    expect(adapter?.activeSessionCount()).toBe(0);
  });

  it("maps an infrastructure exception to runtime_failure instead of no-feasible", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.id === "hard_distance_limit")!;
    let disposed = 0;
    let adapter: OpenEvalsAppAdapter | undefined;
    const failingAdapterFactory = (input: DecisionScenarioExecutionInput, memoryEnabled?: boolean) => {
      adapter = createOpenEvalsApp(input, memoryEnabled, () => ({
        async runTurn(): Promise<never> { throw new Error("location_provider_crash"); },
        toOutput: () => ({
          scenarioId: scenario.id,
          turnSnapshots: [],
          runtime: { completed: false, durationMs: 0, toolCalls: 0, replans: 0, errors: ["location_provider_crash"] },
        }),
        dispose: () => { disposed += 1; },
      } as unknown as DecisionScenarioSession));
      return adapter;
    };
    const result = await runScenarioOpenEvals(scenario, true, "provider-error", failingAdapterFactory);
    expect(disposed).toBe(1);
    expect(adapter?.activeSessionCount()).toBe(0);
    expect(result.execution.runtime.completed).toBe(false);
    expect(result.execution.runtime.errors).toContain("location_provider_crash");
    expect(evaluateDecisionScenario(scenario, result.execution, true).outcome).toBe("runtime_failure");
  });

  it("matches all 12 manual scenarios on evaluator-relevant state and outcomes", async () => {
    for (const scenario of DECISION_SCENARIOS) {
      const manual = await runScenarioManual(scenario, true);
      const scripted = await runScenarioOpenEvals(scenario, true, `compare-${scenario.id}`);
      const manualEval = evaluateDecisionScenario(scenario, manual, true);
      const scriptedEval = evaluateDecisionScenario(scenario, scripted.execution, true);
      expect(scripted.execution.finalConstraints, scenario.id).toEqual(manual.finalConstraints);
      expect(scripted.execution.planningTermination, scenario.id).toEqual(manual.planningTermination);
      expect(scripted.execution.selectedPlan?.activities.map(item => item.place.id), scenario.id)
        .toEqual(manual.selectedPlan?.activities.map(item => item.place.id));
      expect(scripted.execution.turnSnapshots.length, scenario.id).toBe(scenario.turns.length);
      expect(scriptedEval, scenario.id).toMatchObject({
        outcome: manualEval.outcome,
        taskSuccess: manualEval.taskSuccess,
        hardConstraintChecks: manualEval.hardConstraintChecks,
        hardConstraintViolations: manualEval.hardConstraintViolations,
        adaptationChecks: manualEval.adaptationChecks,
        adaptationErrors: manualEval.adaptationErrors,
        preferenceChecks: manualEval.preferenceChecks,
        preferenceMatches: manualEval.preferenceMatches,
        planningTermination: manualEval.planningTermination,
        runtimeCompleted: manualEval.runtimeCompleted,
        planGenerated: manualEval.planGenerated,
        turns: manualEval.turns,
      });
      expect(scriptedEval.candidateIds, scenario.id).toEqual(manualEval.candidateIds);
    }
  }, 120_000);

  it("retains constraints across turns and applies corrected preferences", async () => {
    const retention = DECISION_SCENARIOS.find(item => item.id === "destination_retention_shanghai")!;
    const correction = DECISION_SCENARIOS.find(item => item.id === "preference_correction")!;
    const retentionRun = await runScenarioOpenEvals(retention, true, "retention");
    const correctionRun = await runScenarioOpenEvals(correction, true, "correction");
    expect(retentionRun.execution.finalConstraints?.destination?.city).toBe("上海");
    expect(correctionRun.execution.finalConstraints?.group.preferences.preferredCuisine).toEqual(["火锅"]);
    expect(correctionRun.execution.turnSnapshots[0]?.constraints?.group.preferences.preferredCuisine).toEqual(["日料"]);
  });

  it("completes a no-feasible scenario normally and preserves its structured termination", async () => {
    const scenario = DECISION_SCENARIOS.find(item => item.id === "hard_distance_limit")!;
    const result = await runScenarioOpenEvals(scenario, true, "no-feasible");
    expect(result.execution.runtime.completed).toBe(true);
    expect(result.execution.planningTermination?.reason).toBe("no_feasible_plan");
    expect(evaluateDecisionScenario(scenario, result.execution, true).outcome).toBe("no_feasible_plan");
  });

  it("is deterministic across reruns and isolates concurrent executions of the same scenario", async () => {
    const scenario = DECISION_SCENARIOS[0]!;
    const [first, second] = await Promise.all([
      runScenarioOpenEvals(scenario, true, "rerun-one"),
      runScenarioOpenEvals(scenario, true, "rerun-two"),
    ]);
    expect(first.threadId).not.toBe(second.threadId);
    expect(first.trajectory.trajectory.filter(message => message.role === "user").map(message => message.content))
      .toEqual(scenario.turns.map(turn => turn.user));
    expect(second.trajectory.trajectory.filter(message => message.role === "user").map(message => message.content))
      .toEqual(scenario.turns.map(turn => turn.user));
    expect(first.execution.finalConstraints).toEqual(second.execution.finalConstraints);
    expect(first.execution.planningTermination).toEqual(second.execution.planningTermination);
    expect(first.execution.selectedPlan?.activities.map(item => item.place.id))
      .toEqual(second.execution.selectedPlan?.activities.map(item => item.place.id));
    expect(first.execution.runtime.completed).toBe(second.execution.runtime.completed);
  });

  it("isolates concurrently executed scenarios with different location/data fixtures", async () => {
    const shanghai = DECISION_SCENARIOS.find(item => item.id === "destination_retention_shanghai")!;
    const beijing = DECISION_SCENARIOS.find(item => item.id === "elderly_dietary_retention")!;
    const [shanghaiRun, beijingRun] = await Promise.all([
      runScenarioOpenEvals(shanghai, true, "parallel-shanghai"),
      runScenarioOpenEvals(beijing, true, "parallel-beijing"),
    ]);
    expect(shanghaiRun.threadId).not.toBe(beijingRun.threadId);
    expect(shanghaiRun.execution.finalConstraints?.destination?.city).toBe("上海");
    expect(shanghaiRun.execution.selectedPlan?.activities.every(activity => activity.place.location.city === "上海")).toBe(true);
    expect(beijingRun.execution.runtime.completed).toBe(true);
    expect(beijingRun.execution.planningTermination?.reason).toBe("plan_selected");
    expect(beijingRun.execution.finalConstraints?.group.preferences.dietaryRestrictions).toContain("免海鲜");
    const selectedRestaurant = beijingRun.execution.selectedPlan?.activities.find(activity => activity.place.type === "restaurant")?.place;
    expect(selectedRestaurant?.type).toBe("restaurant");
    if (selectedRestaurant?.type !== "restaurant") throw new Error("expected_selected_restaurant");
    expect((selectedRestaurant as import("../spec/types.js").Restaurant).supportedDietaryRestrictions).toContain("免海鲜");
  });

  it("returns only user-visible messages in the OpenEvals trajectory", async () => {
    const scenario = DECISION_SCENARIOS[0]!;
    const result = await runScenarioOpenEvals(scenario, true, "visible-only");
    expect(result.trajectory.trajectory).toHaveLength(scenario.turns.length * 2);
    expect(result.trajectory.trajectory.filter(message => message.role === "assistant").map(message => message.content))
      .toEqual(result.execution.turnSnapshots.map(snapshot => snapshot.userVisibleMessage));
    expect(JSON.stringify(result.trajectory.trajectory)).not.toContain("constraints");
    expect(JSON.stringify(result.trajectory.trajectory)).not.toContain("referenceOutputs");
  });
});
