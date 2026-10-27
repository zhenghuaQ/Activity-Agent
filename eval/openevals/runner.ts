import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateDecisionScenario } from "../decision/evaluators/conversation.js";
import { runDecisionEval } from "../decision/runner.js";
import { runScenarioOpenEvals } from "./scripted-runner.js";

export async function runOpenEvalsDecisionEval(): Promise<void> {
  await runDecisionEval(async (scenario, memoryEnabled) => {
    const { execution } = await runScenarioOpenEvals(scenario, memoryEnabled);
    return evaluateDecisionScenario(scenario, execution, memoryEnabled);
  });
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  runOpenEvalsDecisionEval().catch(error => {
    console.error("OpenEvals Decision evaluation failed:", error);
    process.exit(1);
  });
}
