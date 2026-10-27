import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDecisionQualityAudit, renderDecisionQualityMarkdown } from "./report.js";
import { runDecisionQualityProbes } from "./probes.js";

export async function runDecisionQualityAudit(outputDirectory = "eval-results/diagnostics") {
  const result = await runDecisionQualityProbes();
  const audit = buildDecisionQualityAudit(result);
  const directory = path.resolve(outputDirectory);
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "decision-quality-audit.json");
  const markdownPath = path.join(directory, "decision-quality-audit.md");
  await Promise.all([
    fs.writeFile(jsonPath, JSON.stringify(audit, null, 2), "utf8"),
    fs.writeFile(markdownPath, renderDecisionQualityMarkdown(audit), "utf8"),
  ]);
  console.log(`Decision quality diagnostic audit written:\n- ${jsonPath}\n- ${markdownPath}`);
  console.log(`Deterministic probes: ${audit.probes.length + 1}; open findings: ${audit.defects.length}; audit changed production logic: no`);
  console.log(`DQ status: ${audit.recommendation.target}`);
  return audit;
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  runDecisionQualityAudit().catch(error => {
    console.error(`Decision quality diagnostic audit failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });
}
