import "dotenv/config";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";
import { createLangSmithClient } from "./client.js";
import { loadLangSmithConfig, LangSmithConfigurationError } from "./config.js";
import { syncDecisionDataset } from "./dataset.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadLangSmithConfig();
  } catch (error) {
    if (error instanceof LangSmithConfigurationError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  try {
    const { DECISION_SCENARIOS } = await import("../decision/scenarios/cases.js");
    const result = await syncDecisionDataset({
      client: createLangSmithClient(config),
      scenarios: DECISION_SCENARIOS,
      datasetName: config.datasetName,
    });
    console.log(`Dataset: ${result.datasetName}`);
    console.log(`Benchmark version: ${DECISION_BENCHMARK_VERSION}`);
    console.log(`Local scenarios: ${result.localScenarios}`);
    console.log(`Created: ${result.created}`);
    console.log(`Updated: ${result.updated}`);
    console.log(`Unchanged: ${result.unchanged}`);
    console.log(`Stale remote: ${result.staleRemoteScenarioIds.length}`);
    for (const scenarioId of result.staleRemoteScenarioIds) console.warn(`STALE_REMOTE_EXAMPLE: ${scenarioId}`);
  } catch (error) {
    console.error(`LangSmith dataset sync failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

void main();
