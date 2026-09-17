import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentState } from "../spec/agent.js";
import type { GeoLocation } from "../spec/types.js";
import {
  CircuitBreakerRegistry,
  ToolExecutor,
} from "../src/runtime/index.js";
import { estimateTransitWithAmap } from "../src/transit/amap.js";

describe("runtime cancellation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("passes an already-aborted parent signal to the tool", async () => {
    const parent = new AbortController();
    parent.abort(new Error("cancelled_before_call"));
    let observed = false;
    const registry = {
      get: () => ({
        name: "slow",
        execute: async (_input: unknown, context?: { signal?: AbortSignal }) => {
          observed = context?.signal?.aborted === true;
          throw context?.signal?.reason;
        },
      }),
    };

    const executor = new ToolExecutor(createAgentState({ rawText: "x" }), {
      registry,
      signal: parent.signal,
    });

    await expect(executor.execute("slow", {})).rejects.toThrow("cancelled_before_call");
    expect(observed).toBe(true);
  });

  it("does not convert transit cancellation into a mock estimate", async () => {
    vi.stubEnv("AMAP_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort(new Error("user_cancelled"));
    const from: GeoLocation = {
      lat: 39.9,
      lng: 116.4,
      address: "北京",
      city: "北京",
    };
    const to: GeoLocation = {
      lat: 39.91,
      lng: 116.41,
      address: "目的地",
      city: "北京",
    };

    await expect(
      estimateTransitWithAmap(from, to, "14:00", controller.signal),
    ).rejects.toThrow("user_cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settles a half-open probe neutrally when cancellation wins", async () => {
    const breaker = new CircuitBreakerRegistry({
      failureThreshold: 1,
      cooldownMs: 0,
    });
    breaker.recordFailure("slow", 1_000);
    const parent = new AbortController();
    parent.abort(new Error("user_cancelled"));
    const executor = new ToolExecutor(createAgentState({ rawText: "x" }), {
      circuitBreaker: breaker,
      signal: parent.signal,
      registry: {
        get: () => ({
          name: "slow",
          execute: async (_input: unknown, context?: { signal?: AbortSignal }) => {
            throw context?.signal?.reason;
          },
        }),
      },
    });

    await expect(executor.execute("slow", {})).rejects.toThrow("user_cancelled");
    expect(breaker.getStatus("slow")).toMatchObject({
      consecutiveFailures: 1,
      halfOpenProbeInFlight: false,
    });
  });
});
