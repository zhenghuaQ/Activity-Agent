import { describe, expect, it } from "vitest";
import type { DecisionScenario } from "../eval/decision/scenarios/schema.js";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import { runConversationCase } from "../eval/decision/evaluators/conversation.js";
import { defaultDatasetName, loadLangSmithConfig, LangSmithConfigurationError } from "../eval/langsmith/config.js";
import {
  hashDecisionScenario,
  mapDecisionScenarioToExample,
  syncDecisionDataset,
  type LangSmithDatasetClient,
} from "../eval/langsmith/dataset.js";
import { evaluateLangSmithRun, LANGSMITH_DECISION_METRIC_KEYS, langSmithDecisionEvaluators } from "../eval/langsmith/evaluators.js";
import type { EvaluationResult } from "langsmith/evaluation";
import { runLangSmithDecisionTarget } from "../eval/langsmith/target.js";

class FakeLangSmithClient implements LangSmithDatasetClient {
  dataset?: { id: string };
  readonly examples: Array<{ id: string; inputs: unknown; outputs: unknown; metadata?: Record<string, unknown> }> = [];
  readonly deletedIds: string[] = [];
  private nextId = 0;

  async hasDataset(): Promise<boolean> { return Boolean(this.dataset); }
  async readDataset(): Promise<{ id: string }> {
    if (!this.dataset) throw new Error("dataset_missing");
    return this.dataset;
  }
  async createDataset(): Promise<{ id: string }> {
    this.dataset = { id: "dataset_1" };
    return this.dataset;
  }
  async *listExamples(): AsyncIterable<{ id: string; metadata?: Record<string, unknown> }> {
    for (const example of this.examples) yield example;
  }
  async createExample(input: { dataset_id: string; inputs: unknown; outputs: unknown; metadata: Record<string, unknown> }): Promise<void> {
    this.examples.push({ id: `example_${++this.nextId}`, ...input, metadata: { ...input.metadata } });
  }
  async updateExample(input: { id: string; dataset_id: string; inputs: unknown; outputs: unknown; metadata: Record<string, unknown> }): Promise<void> {
    const index = this.examples.findIndex((example) => example.id === input.id);
    if (index < 0) throw new Error("example_missing");
    this.examples[index] = { ...input, metadata: { ...input.metadata } };
  }
}

describe("LangSmith Decision Eval adapter", () => {
  const scenario = DECISION_SCENARIOS.find((item) => item.id === "shanghai_couple_japanese")!;

  it("maps a local scenario to agent inputs, reference outputs, and sync metadata", () => {
    const mapped = mapDecisionScenarioToExample(scenario);
    expect(mapped.inputs).toMatchObject({
      schemaVersion: 1,
      benchmarkVersion: "decision-v3.1",
      scenarioId: scenario.id,
      turns: scenario.turns,
      environment: scenario.environment,
    });
    expect(mapped.outputs).toEqual({ expectations: scenario.expectations });
    expect(mapped.metadata).toMatchObject({
      scenarioId: scenario.id,
      benchmarkVersion: "decision-v3.1",
      tags: scenario.tags,
      scenarioHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("hashes the same scenario identically regardless of object property insertion order", () => {
    const reordered = {
      tags: [...scenario.tags],
      expectations: structuredClone(scenario.expectations),
      environment: {
        data: {
          destinationCenters: structuredClone(scenario.environment.data.destinationCenters),
          breakPlaces: structuredClone(scenario.environment.data.breakPlaces),
          restaurants: structuredClone(scenario.environment.data.restaurants),
          attractions: structuredClone(scenario.environment.data.attractions),
        },
        location: structuredClone(scenario.environment.location),
      },
      turns: structuredClone(scenario.turns),
      domain: scenario.domain,
      description: scenario.description,
      id: scenario.id,
    } as DecisionScenario;
    expect(hashDecisionScenario(reordered)).toBe(hashDecisionScenario(scenario));
  });

  it("creates once, then syncs as a no-op for identical hashes", async () => {
    const client = new FakeLangSmithClient();
    const first = await syncDecisionDataset({ client, scenarios: [scenario] });
    const second = await syncDecisionDataset({ client, scenarios: [scenario] });
    expect(first).toMatchObject({ created: 1, updated: 0, unchanged: 0 });
    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    expect(client.examples).toHaveLength(1);
  });

  it("updates changed scenarios by stable scenarioId and reports stale remote examples without deleting", async () => {
    const client = new FakeLangSmithClient();
    const mapped = mapDecisionScenarioToExample(scenario);
    client.dataset = { id: "dataset_1" };
    client.examples.push({ id: "existing", inputs: mapped.inputs, outputs: mapped.outputs, metadata: mapped.metadata });
    client.examples.push({ id: "stale", inputs: {}, outputs: {}, metadata: { scenarioId: "removed_scenario" } });
    const changed = structuredClone(scenario);
    changed.description += " (changed)";

    const result = await syncDecisionDataset({ client, scenarios: [changed] });
    expect(result).toMatchObject({ created: 0, updated: 1, unchanged: 0, staleRemoteScenarioIds: ["removed_scenario"] });
    expect(client.examples).toHaveLength(2);
    expect(client.deletedIds).toEqual([]);
  });

  it("runs the target from inputs only and returns JSON-safe data", async () => {
    const example = mapDecisionScenarioToExample(scenario);
    const output = await runLangSmithDecisionTarget(example.inputs);
    expect(output).toMatchObject({
      scenarioId: scenario.id,
      benchmarkVersion: "decision-v3.1",
      planningTermination: { reason: "plan_selected" },
      runtime: { completed: true },
    });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
    await expect(runLangSmithDecisionTarget({ ...example.inputs, referenceOutputs: example.outputs }))
      .rejects.toThrow("invalid_langsmith_decision_input:ground_truth_not_allowed");
  });

  it("matches local deterministic evaluator metrics for the same scenario execution", async () => {
    const example = mapDecisionScenarioToExample(scenario);
    const [local, targetOutput] = await Promise.all([
      runConversationCase(scenario, true),
      runLangSmithDecisionTarget(example.inputs),
    ]);
    const remoteCore = evaluateLangSmithRun({
      inputs: example.inputs,
      outputs: targetOutput,
      referenceOutputs: example.outputs,
    });
    expect(remoteCore).toMatchObject({
      taskSuccess: local.taskSuccess,
      outcome: local.outcome,
      runtimeCompleted: local.runtimeCompleted,
      planGenerated: local.planGenerated,
      hardConstraintChecks: local.hardConstraintChecks,
      hardConstraintViolations: local.hardConstraintViolations,
      adaptationChecks: local.adaptationChecks,
      adaptationErrors: local.adaptationErrors,
      preferenceChecks: local.preferenceChecks,
      preferenceMatches: local.preferenceMatches,
    });
  });

  it("adapts a local outcome into a single LangSmith feedback score with a diagnostic comment", async () => {
    const example = mapDecisionScenarioToExample(scenario);
    const outputs = await runLangSmithDecisionTarget(example.inputs);
    const evaluator = langSmithDecisionEvaluators[0] as (args: {
      inputs: unknown;
      outputs: unknown;
      referenceOutputs?: unknown;
    }) => EvaluationResult;
    const feedback = evaluator({
      inputs: example.inputs,
      outputs,
      referenceOutputs: example.outputs,
    });
    expect(feedback).toMatchObject({
      key: "decision_task_success",
      score: 1,
      comment: "actual_outcome=feasible_plan",
    });
  });

  it("publishes recommendation-scoped preference feedback and omits not-applicable scenarios", async () => {
    expect(LANGSMITH_DECISION_METRIC_KEYS).toContain("recommendation_preference_coverage");
    expect(LANGSMITH_DECISION_METRIC_KEYS).not.toContain("preference_coverage");
    const feasibleExample = mapDecisionScenarioToExample(scenario);
    const feasibleOutput = await runLangSmithDecisionTarget(feasibleExample.inputs);
    const preferenceEvaluator = langSmithDecisionEvaluators.at(-1) as (args: {
      inputs: unknown;
      outputs: unknown;
      referenceOutputs?: unknown;
    }) => EvaluationResult | EvaluationResult[];
    const feedback = preferenceEvaluator({ inputs: feasibleExample.inputs, outputs: feasibleOutput, referenceOutputs: feasibleExample.outputs });
    expect(feedback).toMatchObject({
      key: "recommendation_preference_coverage",
      evaluatorInfo: { evaluatorVersion: "decision-evaluator-v1.0", scope: "selectedPlan" },
    });

    const infeasible = DECISION_SCENARIOS.find(item => item.id === "hard_distance_limit")!;
    const infeasibleExample = mapDecisionScenarioToExample(infeasible);
    const noPlanOutput = await runLangSmithDecisionTarget(infeasibleExample.inputs);
    expect(preferenceEvaluator({ inputs: infeasibleExample.inputs, outputs: noPlanOutput, referenceOutputs: infeasibleExample.outputs })).toEqual([]);
  });

  it("requires an explicit API key and derives experiment defaults from the benchmark version", () => {
    expect(() => loadLangSmithConfig({})).toThrowError(
      new LangSmithConfigurationError("LangSmith evaluation requires LANGSMITH_API_KEY"),
    );
    expect(defaultDatasetName()).toBe("activity-agent-decision-v3.1");
    expect(loadLangSmithConfig({ LANGSMITH_API_KEY: "test-key" })).toMatchObject({
      datasetName: "activity-agent-decision-v3.1",
      experimentPrefix: "activity-agent-decision-v3.1",
      maxConcurrency: 2,
      decisionRunner: "manual",
    });
    expect(loadLangSmithConfig({
      LANGSMITH_API_KEY: "test-key",
      LANGSMITH_DATASET_NAME: "dataset-override",
      LANGSMITH_EXPERIMENT_PREFIX: "run-override",
      LANGSMITH_EVAL_MAX_CONCURRENCY: "4",
      LANGSMITH_DECISION_RUNNER: "openevals-scripted",
    })).toMatchObject({
      datasetName: "dataset-override",
      experimentPrefix: "run-override",
      maxConcurrency: 4,
      decisionRunner: "openevals-scripted",
    });
  });
});
