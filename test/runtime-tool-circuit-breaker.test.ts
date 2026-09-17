import { describe, expect, it } from "vitest";
import { createAgentState } from "../spec/agent.js";
import { err } from "../src/tools/base.js";
import { ToolExecutor } from "../src/runtime/tool-executor.js";
import { CircuitBreakerRegistry } from "../src/runtime/circuit-breaker.js";

function fakeRegistry(execute: () => Promise<unknown>) {
  let calls = 0;
  return {
    get: (name: string) => ({
      name,
      async execute() {
        calls += 1;
        return await execute() as never;
      },
      get calls() { return calls; },
    }),
  };
}

describe("Tool circuit breaker", () => {
  it("opens after 3 consecutive logical-call failures", async () => {
    const state = createAgentState({ rawText: "test" });
    const breaker = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 1000 });
    const registry = fakeRegistry(async () => err("E_NETWORK_UNAVAILABLE", "down"));
    const executor = new ToolExecutor(state, { registry, circuitBreaker: breaker, maxRetries: 1 });

    await executor.execute("fake", {});
    await executor.execute("fake", {});
    await executor.execute("fake", {});

    expect(breaker.getStatus("fake").state).toBe("open");
    expect((registry.get("fake") as { calls: number }).calls).toBe(6);

    const fourth = await executor.execute("fake", {});
    expect(fourth.status).toBe("error");
    if (fourth.status === "error") expect(fourth.errorInfo.code).toBe("E_CIRCUIT_OPEN");
    expect((registry.get("fake") as { calls: number }).calls).toBe(6);
  });

  it("lazily enters half-open after cooldown and closes on probe success", async () => {
    const breaker = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 10 });
    breaker.recordFailure("fake");
    breaker.recordFailure("fake");
    breaker.recordFailure("fake");
    expect(breaker.getStatus("fake").state).toBe("open");

    const now = Date.now() + 11;
    expect(breaker.beforeCall("fake", now).state).toBe("half_open");
    breaker.recordSuccess("fake");
    expect(breaker.getStatus("fake").state).toBe("closed");
  });

  it("non-retryable parameter errors do not trip the breaker", async () => {
    const breaker = new CircuitBreakerRegistry({ failureThreshold: 3, cooldownMs: 10 });
    const state = createAgentState({ rawText: "test" });
    const registry = fakeRegistry(async () => err("E_PARAM_INVALID", "bad"));
    const executor = new ToolExecutor(state, { registry, circuitBreaker: breaker });

    await executor.execute("fake", {});
    await executor.execute("fake", {});
    await executor.execute("fake", {});

    expect(breaker.getStatus("fake").state).toBe("closed");
  });

  it("settles a half-open probe after a neutral outcome", () => {
    const breaker = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 10 });
    breaker.recordFailure("fake", 1_000);
    expect(breaker.beforeCall("fake", 1_011)).toEqual({
      allowed: true,
      state: "half_open",
    });

    breaker.completeCall("fake", "neutral", 1_011);

    expect(breaker.getStatus("fake").halfOpenProbeInFlight).toBe(false);
    expect(breaker.beforeCall("fake", 1_012).allowed).toBe(true);
  });

  it("allows another call after a half-open probe returns a parameter error", async () => {
    const breaker = new CircuitBreakerRegistry({ failureThreshold: 1, cooldownMs: 0 });
    breaker.recordFailure("fake", Date.now() - 1);
    const state = createAgentState({ rawText: "test" });
    const registry = fakeRegistry(async () => err("E_PARAM_INVALID", "bad"));
    const executor = new ToolExecutor(state, { registry, circuitBreaker: breaker });

    const first = await executor.execute("fake", {});
    const second = await executor.execute("fake", {});

    expect(first.status).toBe("error");
    expect(second.status).toBe("error");
    if (second.status === "error") {
      expect(second.errorInfo.code).toBe("E_PARAM_INVALID");
    }
    expect((registry.get("fake") as { calls: number }).calls).toBe(2);
  });
});
