import { runDecisionEval } from "./decision/runner.js";
import { runRuntimeRegression } from "./runtime/runner.js";

/** Compatibility entry: primary Decision Eval first, Runtime Regression second. */
async function main(): Promise<void> {
  await runDecisionEval();
  console.log();
  await runRuntimeRegression();
}

main().catch((err) => {
  console.error("Evaluation failed:", err);
  process.exit(1);
});
