import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateDecisionEvaluationArtifact } from "./artifact.js";

export async function runDecisionArtifactCli(): Promise<void> {
  const result = await generateDecisionEvaluationArtifact({ variantLabel: process.env.DECISION_VARIANT_LABEL });
  console.log(`Decision artifact generated: ${result.filePath}`);
  console.log(`Artifact ID: ${result.artifact.provenance.artifactId}`);
  console.log(`Benchmark: ${result.artifact.benchmarkVersion}; scenarios: ${result.artifact.scenarios.length}; gitDirty: ${result.artifact.provenance.gitDirty}`);
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runDecisionArtifactCli().catch(error => {
    console.error(`Decision artifact generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
