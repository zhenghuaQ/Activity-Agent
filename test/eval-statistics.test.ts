import { describe, expect, it } from "vitest";
import { bootstrapMean, pairedBootstrapDifference, wilsonInterval } from "../eval/statistics.js";

describe("evaluation statistics", () => {
  it("uses a bounded Wilson interval for small binomial samples", () => {
    const interval = wilsonInterval(4, 4);
    expect(interval.estimate).toBe(1);
    expect(interval.lower).toBeCloseTo(0.5101, 3);
    expect(interval.upper).toBe(1);
  });

  it("bootstraps task-level means reproducibly", () => {
    const first = bootstrapMean([100, 200, 300], { seed: 7, resamples: 1_000 });
    const second = bootstrapMean([100, 200, 300], { seed: 7, resamples: 1_000 });
    expect(first).toEqual(second);
    expect(first.estimate).toBe(200);
    expect(first.lower).toBeLessThanOrEqual(first.estimate);
    expect(first.upper).toBeGreaterThanOrEqual(first.estimate);
  });

  it("computes paired candidate-minus-baseline differences", () => {
    const interval = pairedBootstrapDifference([10, 20, 30], [12, 24, 36], { seed: 3, resamples: 1_000 });
    expect(interval.estimate).toBe(4);
    expect(() => pairedBootstrapDifference([1], [1, 2])).toThrow("paired_sample_size_mismatch");
  });
});
