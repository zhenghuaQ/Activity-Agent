import { describe, expect, it, vi } from "vitest";
import { createAgentState } from "../spec/agent.js";
import { err, ok } from "../src/tools/base.js";
import { ToolExecutor, classifyFailure } from "../src/runtime/tool-executor.js";

function fakeRegistry(execute: (input: unknown) => Promise<unknown>) {
  return {
    get: (name: string) => ({
      name,
      async execute(input: unknown) {
        return await execute(input) as never;
      },
    }),
  };
}

describe("ToolExecutor recovery policy", () => {
  it("classifies retryable and non-retryable failures consistently with error metadata", () => {
    expect(classifyFailure("E_NETWORK_UNAVAILABLE", "network down")).toMatchObject({
      kind: "network",
      retryable: true,
    });
    expect(classifyFailure("E_PARAM_INVALID", "bad input")).toMatchObject({
      kind: "parameter",
      retryable: false,
    });
    expect(classifyFailure("E_EXECUTION_TIMEOUT", "timed out")).toMatchObject({
      kind: "timeout",
      retryable: true,
    });
  });

  it("retries a retryable error and records the recovery attempt", async () => {
    const state = createAgentState({ rawText: "test" });
    let calls = 0;
    const registry = fakeRegistry(async () => {
      calls += 1;
      return calls === 1
        ? err("E_NETWORK_UNAVAILABLE", "temporary network error")
        : ok("recovered", { recovered: true });
    });

    const executor = new ToolExecutor(state, {
      maxRetries: 1,
      registry,
    });

    const result = await executor.execute("fake", {});

    expect(result.status).toBe("success");
    expect(calls).toBe(2);
    expect(state.toolCalls).toHaveLength(2);
    expect(state.toolCalls[0].recovery).toBe("retry");
    expect(state.toolCalls[1].status).toBe("success");
  });

  it("uses fallback only after retries are exhausted", async () => {
    const state = createAgentState({ rawText: "test" });
    const execute = vi.fn(async () => err("E_NETWORK_UNAVAILABLE", "upstream unavailable"));
    const fallback = vi.fn(async () => ok("fallback", { source: "fallback" }));

    const executor = new ToolExecutor(state, {
      maxRetries: 1,
      registry: fakeRegistry(execute),
      fallbacks: { fake: fallback },
    });

    const result = await executor.execute("fake", {});

    expect(result.status).toBe("success");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(state.toolCalls.at(-1)?.recovery).toBe("fallback");
  });
});
