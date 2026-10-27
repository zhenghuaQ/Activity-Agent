import "dotenv/config";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPairwiseConfig, missingPairwiseCredential, PairwiseConfigurationError } from "./config.js";
import { readDecisionArtifact, validateArtifactPair } from "./artifact-validation.js";
import { compareDecisionArtifacts } from "./comparison.js";
import { deterministicGate } from "./comparison.js";
import type { PairwiseJudgeFactory } from "./evaluator.js";
import type { PairwiseArtifact } from "./schema.js";

export interface PairwiseRunnerDependencies {
  factory?: PairwiseJudgeFactory;
  persist?: (artifact: PairwiseArtifact, outputPath: string) => Promise<void>;
  print?: (artifact: PairwiseArtifact) => void;
  beforeCall?: () => Promise<void>;
}

export async function runPairwiseEval(
  config = loadPairwiseConfig(),
  dependencies: PairwiseRunnerDependencies = {},
): Promise<PairwiseArtifact> {
  const [artifactA, artifactB] = await Promise.all([
    readDecisionArtifact(config.artifactAPath),
    readDecisionArtifact(config.artifactBPath),
  ]);
  validateArtifactPair(artifactA, artifactB);
  const bById = new Map(artifactB.scenarios.map(scenario => [scenario.scenarioId, scenario]));
  const needsJudge = artifactA.scenarios.some(a => {
    const gate = deterministicGate(a, bById.get(a.scenarioId)!);
    return !gate && !(a.deterministic.outcome === "runtime_failure" && bById.get(a.scenarioId)!.deterministic.outcome === "runtime_failure");
  });
  if (needsJudge) {
    const missing = missingPairwiseCredential(config.judgeModel);
    if (missing) throw new PairwiseConfigurationError(`Pairwise evaluation requires model credentials for PAIRWISE_JUDGE_MODEL (${missing}).`);
  }
  const result = await compareDecisionArtifacts({
    artifactA,
    artifactB,
    judgeModel: config.judgeModel,
    runsPerOrientation: config.runsPerOrientation,
    maxConcurrency: config.maxConcurrency,
    factory: dependencies.factory,
    beforeCall: dependencies.beforeCall,
  });
  await (dependencies.persist ?? persistPairwise)(result, config.outputPath);
  (dependencies.print ?? printPairwise)(result);
  return result;
}

async function persistPairwise(result: PairwiseArtifact, outputPath: string): Promise<void> {
  const directory = path.resolve(outputPath);
  await fs.mkdir(directory, { recursive: true });
  const filename = `pairwise-${result.pairwiseJudgeVersion}-${result.createdAt.replaceAll(":", "-")}-${randomUUID()}.json`;
  await fs.writeFile(path.join(directory, filename), JSON.stringify(result, null, 2), "utf8");
}

function printPairwise(result: PairwiseArtifact): void {
  const s = result.summary;
  console.log("Blind Pairwise Decision Comparison");
  console.log(`Benchmark: ${result.benchmarkVersion}; Judge: ${result.pairwiseJudgeVersion}; Model: ${result.judgeModel}`);
  console.log(`Scenarios compared: ${s.scenariosCompared}`);
  console.log(`Deterministic decisions: ${s.deterministicDecisions}; semantic judge decisions: ${s.semanticJudgeDecisions}`);
  console.log(`A wins: ${s.aWins}; B wins: ${s.bWins}; ties: ${s.ties}`);
  console.log(`Position inconsistent: ${s.positionInconsistent}; judge unstable: ${s.judgeUnstable}; failures: ${s.judgeFailures}; not comparable: ${s.notComparable}; judge calls: ${s.judgeCalls}`);
  if (result.artifactA.gitDirty || result.artifactB.gitDirty) console.log("Warning: artifact A or B was generated from a dirty working tree.");
  for (const row of result.scenarios) console.log(`${row.scenarioId}: ${row.status} winner=${row.winner ?? "none"}`);
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runPairwiseEval().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.startsWith("Pairwise evaluation requires") || message.startsWith("Pairwise Judge")
      ? message
      : `Pairwise evaluation failed: ${message}`);
    process.exit(1);
  });
}
