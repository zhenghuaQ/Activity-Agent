import { createHash } from "node:crypto";
import type { Client } from "langsmith/client";
import { DECISION_BENCHMARK_VERSION, type DecisionScenario } from "../decision/scenarios/schema.js";
import { DECISION_SCENARIOS } from "../decision/scenarios/cases.js";
import { validateDecisionScenarios } from "../decision/scenarios/validate.js";
import { defaultDatasetName } from "./config.js";
import type { DecisionScenarioExample } from "./schema.js";
import { LANGSMITH_INPUT_SCHEMA_VERSION } from "./schema.js";

const DATASET_DESCRIPTION = [
  "Activity-Agent Decision Benchmark",
  `Benchmark version: ${DECISION_BENCHMARK_VERSION}`,
  "Domain: activity",
  "Fixed multi-turn scenarios",
  "Synthetic deterministic environment fixtures",
].join("\n");

// Keep the v3.0 hash namespace stable across the fixture-only v3.1 migration so
// unchanged scenarios retain their hashes; benchmarkVersion is validated separately.
const SCENARIO_HASH_COMPAT_VERSION = "decision-v3.0" as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function canonicalScenarioJson(scenario: DecisionScenario): string {
  return JSON.stringify(canonicalize({
    scenarioId: scenario.id,
    description: scenario.description,
    domain: scenario.domain,
    benchmarkVersion: SCENARIO_HASH_COMPAT_VERSION,
    tags: scenario.tags,
    turns: scenario.turns,
    environment: scenario.environment,
    expectations: scenario.expectations,
  }));
}

export function hashDecisionScenario(scenario: DecisionScenario): string {
  return createHash("sha256").update(canonicalScenarioJson(scenario), "utf8").digest("hex");
}

export function mapDecisionScenarioToExample(scenario: DecisionScenario): DecisionScenarioExample {
  return {
    inputs: {
      schemaVersion: LANGSMITH_INPUT_SCHEMA_VERSION,
      benchmarkVersion: DECISION_BENCHMARK_VERSION,
      scenarioId: scenario.id,
      description: scenario.description,
      domain: scenario.domain,
      turns: structuredClone(scenario.turns),
      environment: structuredClone(scenario.environment),
      tags: [...scenario.tags],
    },
    outputs: { expectations: structuredClone(scenario.expectations) },
    metadata: {
      scenarioId: scenario.id,
      benchmarkVersion: DECISION_BENCHMARK_VERSION,
      tags: [...scenario.tags],
      scenarioHash: hashDecisionScenario(scenario),
    },
  };
}

export interface LangSmithDatasetClient {
  hasDataset(input: { datasetName: string }): Promise<boolean>;
  readDataset(input: { datasetName: string }): Promise<{ id: string }>;
  createDataset(name: string, options: { description: string; metadata: Record<string, unknown> }): Promise<{ id: string }>;
  listExamples(input: { datasetId: string }): AsyncIterable<{
    id: string;
    metadata?: Record<string, unknown>;
  }>;
  createExample(input: {
    dataset_id: string;
    inputs: DecisionScenarioExample["inputs"];
    outputs: DecisionScenarioExample["outputs"];
    metadata: DecisionScenarioExample["metadata"];
  }): Promise<unknown>;
  updateExample(input: {
    id: string;
    dataset_id: string;
    inputs: DecisionScenarioExample["inputs"];
    outputs: DecisionScenarioExample["outputs"];
    metadata: DecisionScenarioExample["metadata"];
  }): Promise<unknown>;
}

export interface DatasetSyncResult {
  datasetName: string;
  localScenarios: number;
  created: number;
  updated: number;
  unchanged: number;
  staleRemoteScenarioIds: string[];
}

export async function syncDecisionDataset(options: {
  client: LangSmithDatasetClient | Pick<Client, "hasDataset" | "readDataset" | "createDataset" | "listExamples" | "createExample" | "updateExample">;
  scenarios?: readonly DecisionScenario[];
  datasetName?: string;
}): Promise<DatasetSyncResult> {
  const scenarios = validateDecisionScenarios(options.scenarios ?? DECISION_SCENARIOS);
  const datasetName = options.datasetName ?? defaultDatasetName();
  const client = options.client as LangSmithDatasetClient;
  const dataset = await client.hasDataset({ datasetName })
    ? await client.readDataset({ datasetName })
    : await client.createDataset(datasetName, {
        description: DATASET_DESCRIPTION,
        metadata: { benchmarkVersion: DECISION_BENCHMARK_VERSION, domain: "activity", environmentMode: "fixture" },
      });

  const remoteExamples = [] as Array<{ id: string; metadata?: Record<string, unknown> }>;
  for await (const example of client.listExamples({ datasetId: dataset.id })) remoteExamples.push(example);
  const remoteByScenarioId = new Map<string, { id: string; metadata?: Record<string, unknown> }>();
  for (const example of remoteExamples) {
    const scenarioId = example.metadata?.scenarioId;
    if (typeof scenarioId === "string" && !remoteByScenarioId.has(scenarioId)) {
      remoteByScenarioId.set(scenarioId, example);
    }
  }

  const localIds = new Set(scenarios.map((scenario) => scenario.id));
  const staleRemoteScenarioIds = [...remoteByScenarioId.keys()]
    .filter((scenarioId) => !localIds.has(scenarioId)).sort();
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const scenario of scenarios) {
    const example = mapDecisionScenarioToExample(scenario);
    const remote = remoteByScenarioId.get(scenario.id);
    if (!remote) {
      await client.createExample({
        dataset_id: dataset.id,
        inputs: example.inputs,
        outputs: example.outputs,
        metadata: example.metadata,
      });
      created += 1;
      continue;
    }
    if (remote.metadata?.scenarioHash === example.metadata.scenarioHash) {
      unchanged += 1;
      continue;
    }
    await client.updateExample({
      id: remote.id,
      dataset_id: dataset.id,
      inputs: example.inputs,
      outputs: example.outputs,
      metadata: example.metadata,
    });
    updated += 1;
  }

  return { datasetName, localScenarios: scenarios.length, created, updated, unchanged, staleRemoteScenarioIds };
}
