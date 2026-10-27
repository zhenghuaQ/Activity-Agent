import { describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessage } from "openevals";
import { createStressAgentApp, type StressAppAdapter } from "../eval/stress/app-adapter.js";
import { loadStressEvalConfig, missingModelCredential, StressConfigurationError } from "../eval/stress/config.js";
import { evaluateStressRun } from "../eval/stress/evaluators.js";
import { STRESS_SCENARIOS, stressScenarios } from "../eval/stress/scenarios.js";
import { buildSimulatedUserSystemPrompt, createStressSimulatedUser, type StressSimulatedUserFactory } from "../eval/stress/simulated-user.js";
import { runStressBatch, runStressScenario, summarizeStressRuns } from "../eval/stress/runner.js";
import type { DecisionScenarioSession, DecisionScenarioTurnSnapshot } from "../eval/decision/evaluators/conversation.js";
import type { StressEvalConfig } from "../eval/stress/config.js";

const config: StressEvalConfig = {
  runsPerScenario: 1,
  maxConcurrency: 2,
  simulatedUserModel: "fake:test-model",
  outputPath: "unused",
};

function createFakeSession(scenarioId: string): DecisionScenarioSession {
  const snapshots: DecisionScenarioTurnSnapshot[] = [];
  return {
    async runTurn(userInput) {
      const snapshot: DecisionScenarioTurnSnapshot = {
        turnIndex: snapshots.length + 1, userInput, userVisibleMessage: `reply:${userInput}`,
        durationMs: 1, toolCallSummary: [], replanCount: 0, runtimeErrors: [], candidateIds: [],
      };
      snapshots.push(snapshot);
      return snapshot;
    },
    toOutput() {
      return { scenarioId, turnSnapshots: structuredClone(snapshots), runtime: { completed: true, durationMs: snapshots.length, toolCalls: 0, replans: 0, errors: [] } };
    },
    dispose() {},
  };
}

function fakeUserFactory(responses: string[], captured?: { system?: string; fixed?: ChatCompletionMessage[] }): StressSimulatedUserFactory {
  return args => {
    if (captured) { captured.system = args.system; captured.fixed = args.fixedResponses; }
    return async ({ turnCounter }) => ({
      role: "user",
      content: turnCounter === 0 ? args.fixedResponses[0]!.content as string : responses[turnCounter - 1] ?? "继续",
    });
  };
}

describe("stress evaluation v1", () => {
  it("has 6-8 independent scenarios, bounded turns, and no Decision expectations", () => {
    expect(STRESS_SCENARIOS).toHaveLength(8);
    for (const scenario of STRESS_SCENARIOS) {
      expect(scenario.maxTurns).toBeGreaterThanOrEqual(3);
      expect(scenario.maxTurns).toBeLessThanOrEqual(6);
      expect(scenario).not.toHaveProperty("expectations");
      expect(scenario.environment.data.attractions.length + scenario.environment.data.restaurants.length).toBeGreaterThan(0);
    }
    expect(stressScenarios).toBe(STRESS_SCENARIOS);
  });

  it("limits simulated-user prompt to profile and fixes its opening message", async () => {
    const scenario = STRESS_SCENARIOS[0]!;
    const captured: { system?: string; fixed?: ChatCompletionMessage[] } = {};
    const user = createStressSimulatedUser({ profile: scenario.user, model: "fake:model" }, fakeUserFactory([], captured));
    expect(captured.fixed).toEqual([{ role: "user", content: scenario.user.initialMessage }]);
    expect(captured.system).toContain(scenario.user.goal);
    expect(captured.system).not.toContain("fixtures");
    expect(captured.system).not.toContain("Stress Underspecified");
    expect(buildSimulatedUserSystemPrompt(scenario.user)).toContain(scenario.user.persona);
    await expect(user({ trajectory: [], turnCounter: 0 })).resolves.toMatchObject({ content: scenario.user.initialMessage });
  });

  it("reuses one stable session and passes only each current user message", async () => {
    const scenario = STRESS_SCENARIOS[0]!;
    const createSession = vi.fn(() => createFakeSession(scenario.id));
    const adapter = createStressAgentApp(scenario, "thread-a", createSession);
    await adapter.app({ inputs: { role: "user", content: "first" }, threadId: "thread-a" });
    await adapter.app({ inputs: { role: "user", content: "second" }, threadId: "thread-a" });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(adapter.sessionCount()).toBe(1);
    expect(adapter.getExecution("thread-a")?.turnSnapshots.map(turn => turn.userInput)).toEqual(["first", "second"]);
    expect(adapter.isolationFailure("thread-a")).toBe(false);
    adapter.disposeAll();
  });

  it("detects thread changes and disposes session state", async () => {
    const scenario = STRESS_SCENARIOS[0]!;
    const dispose = vi.fn();
    const adapter = createStressAgentApp(scenario, "stable", () => ({ ...createFakeSession(scenario.id), dispose }));
    await adapter.app({ inputs: { role: "user", content: "hello" }, threadId: "stable" });
    await expect(adapter.app({ inputs: { role: "user", content: "again" }, threadId: "other" })).rejects.toThrow("stress_thread_id_changed");
    expect(adapter.isolationFailure("stable")).toBe(true);
    adapter.disposeAll();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("cleans up Runtime when the simulator fails after a successful Agent turn", async () => {
    const scenario = STRESS_SCENARIOS[0]!;
    const dispose = vi.fn();
    const adapterFactory = (target: typeof scenario, threadId: string): StressAppAdapter => createStressAgentApp(
      target,
      threadId,
      () => ({ ...createFakeSession(target.id), dispose }),
    );
    const result = await runStressScenario(scenario, 1, config, {
      appAdapterFactory: adapterFactory,
      simulatedUserFactory: args => async ({ turnCounter }) => {
        if (turnCounter > 0) throw new Error("simulator_after_turn");
        return { role: "user", content: args.fixedResponses[0]!.content as string };
      },
    });
    expect(result.status).toBe("simulator_failure");
    expect(result.execution?.turnSnapshots).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("isolates concurrent executions of one scenario with unique thread IDs", async () => {
    const scenario = STRESS_SCENARIOS[0]!;
    const factory: StressSimulatedUserFactory = args => async ({ turnCounter }) => ({
      role: "user", content: turnCounter === 0 ? args.fixedResponses[0]!.content as string : "补充偏好",
    });
    const [first, second] = await Promise.all([
      runStressScenario(scenario, 1, config, { simulatedUserFactory: factory }),
      runStressScenario(scenario, 2, config, { simulatedUserFactory: factory }),
    ]);
    expect(first!.threadId).not.toBe(second!.threadId);
    expect(first!.status).toBe("completed");
    expect(second!.status).toBe("completed");
  });

  it("separates simulator failures from Agent failures", async () => {
    const simulator = await runStressScenario(STRESS_SCENARIOS[0]!, 1, config, {
      simulatedUserFactory: () => async () => { throw new Error("simulator_boom"); },
    });
    expect(simulator.status).toBe("simulator_failure");
    expect(simulator.simulatorError).toBe("simulator_boom");

    const scenario = STRESS_SCENARIOS[0]!;
    const factory: StressSimulatedUserFactory = args => async ({ turnCounter }) => ({
      role: "user", content: turnCounter === 0 ? args.fixedResponses[0]!.content as string : "继续",
    });
    const agent = await runStressScenario(scenario, 2, config, { simulatedUserFactory: factory });
    expect(agent.status).toBe("completed");
  });

  it("counts max-turn exhaustion separately and excludes simulator failures from Agent denominators", () => {
    const scenario = STRESS_SCENARIOS.find(item => item.id === "immutable_shanghai_distance")!;
    const metrics = evaluateStressRun({ scenario, status: "completed", observedTurnCount: scenario.maxTurns, isolationFailure: false });
    expect(metrics.turnExhausted).toBe(true);
    expect(metrics.immutableFactChecks).toBe(0);
    const summary = summarizeStressRuns([{
      stressBenchmarkVersion: "stress-v1.0", simulatedUserModel: "fake", scenarioId: scenario.id, runIndex: 1,
      maxTurns: scenario.maxTurns, threadId: "t", status: "simulator_failure", simulationDurationMs: 0,
      trajectory: [], metrics: { ...metrics, turnExhausted: false },
    }]);
    expect(summary.simulatorFailures).toBe(1);
    expect(summary.runtimeCompletionRate).toBe(0);
  });

  it("validates bounded settings and requires explicit OpenAI credentials", () => {
    expect(loadStressEvalConfig({}).runsPerScenario).toBe(1);
    expect(loadStressEvalConfig({}).maxConcurrency).toBe(1);
    expect(loadStressEvalConfig({}).simulatedUserModel).toBe("openai:gpt-4.1-mini");
    expect(() => loadStressEvalConfig({ STRESS_MAX_CONCURRENCY: "5" })).toThrow(StressConfigurationError);
    expect(missingModelCredential("openai:gpt-4.1-mini", {})).toBe("OPENAI_API_KEY");
    expect(missingModelCredential("fake:model", {})).toBeUndefined();
  });

  it("runs all concurrent batch tasks under the configured worker bound", async () => {
    const factory: StressSimulatedUserFactory = args => async ({ turnCounter }) => ({
      role: "user", content: turnCounter === 0 ? args.fixedResponses[0]!.content as string : "继续",
    });
    const results = await runStressBatch(STRESS_SCENARIOS.slice(0, 3), { ...config, maxConcurrency: 2 }, { simulatedUserFactory: factory });
    expect(results).toHaveLength(3);
    expect(new Set(results.map(run => run.threadId)).size).toBe(3);
  });
});
