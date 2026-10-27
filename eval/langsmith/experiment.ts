import "dotenv/config";
import { execFileSync } from "node:child_process";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";
import { validateDecisionScenarios } from "../decision/scenarios/validate.js";
import { loadLangSmithConfig, LangSmithConfigurationError } from "./config.js";

function gitMetadata(): { gitCommit?: string; gitDirty?: boolean } {
  try {
    const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { ...(gitCommit ? { gitCommit } : {}), gitDirty: Boolean(dirty) };
  } catch {
    return {};
  }
}

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
    const [{ evaluate }, { createLangSmithClient }, { langSmithDecisionEvaluators }, { runLangSmithDecisionTarget }, { DECISION_SCENARIOS }] = await Promise.all([
      import("langsmith/evaluation"),
      import("./client.js"),
      import("./evaluators.js"),
      import("./target.js"),
      import("../decision/scenarios/cases.js"),
    ]);
    const scenarios = validateDecisionScenarios(DECISION_SCENARIOS);
    const client = createLangSmithClient(config);
    console.log(`Benchmark version: ${DECISION_BENCHMARK_VERSION}`);
    console.log(`Dataset: ${config.datasetName}`);
    console.log(`Experiment prefix: ${config.experimentPrefix}`);
    console.log(`Scenario count: ${scenarios.length}`);
    console.log(`Concurrency: ${config.maxConcurrency}`);
    console.log(`Decision runner: ${config.decisionRunner}`);

    const result = await evaluate(runLangSmithDecisionTarget, {
      data: config.datasetName,
      client,
      evaluators: langSmithDecisionEvaluators,
      experimentPrefix: config.experimentPrefix,
      maxConcurrency: config.maxConcurrency,
      targetConcurrency: config.maxConcurrency,
      evaluationConcurrency: config.maxConcurrency,
      metadata: {
        benchmarkVersion: DECISION_BENCHMARK_VERSION,
        scenarioCount: scenarios.length,
        runner: config.decisionRunner === "manual" ? "manual-multiturn" : "openevals-scripted",
        environmentMode: "fixture",
        dataProvider: "scenario-fixture",
        locationResolver: "fixture",
        nodeVersion: process.version,
        ...(config.project ? { langsmithProject: config.project } : {}),
        ...gitMetadata(),
      },
      description: "Deterministic multi-turn Decision Agent experiment using synthetic fixture environments.",
    });

    let completedRuns = 0;
    for await (const _row of result) completedRuns += 1;
    console.log(`Experiment: ${result.experimentName}`);
    console.log(`Completed runs: ${completedRuns}`);
  } catch (error) {
    console.error(`LangSmith evaluation failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}

void main();
