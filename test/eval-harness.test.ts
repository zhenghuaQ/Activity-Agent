import { describe, expect, it } from "vitest";
import { parseIntent } from "../src/intent/parser.js";
import { runBaseline } from "../eval/runtime/baseline.js";
import { runRuntime } from "../eval/runtime/runtime.js";

const input = "周末带老婆孩子下午出去玩4个小时，预算适中";

describe("Runtime Regression Suite", () => {
  it("can run the baseline and runtime against the same deterministic input", async () => {
    const [baseline, runtime] = await Promise.all([
      runBaseline(input, parseIntent, "smoke"),
      runRuntime(input, "smoke"),
    ]);

    expect(baseline.caseName).toBe("smoke");
    expect(runtime.caseName).toBe("smoke");
    expect(runtime.runner).toBe("runtime");
    expect(runtime.runtimeEntry).toBe("agent_runtime");
    expect(runtime.terminalStatus).toBe("completed");
    expect(runtime.traceEvents).toBeGreaterThan(0);
    expect(runtime.toolCalls).toBeGreaterThan(0);
  });
});
