import { runPaymentBenchmark } from "./benchmark.js";

const result = await runPaymentBenchmark();
console.log(JSON.stringify(result, null, 2));
if (result.cases.some(row => !row.expectedBehaviorPass)) process.exitCode = 1;
