export interface ConfidenceInterval { estimate: number; lower: number; upper: number; confidence: number; n: number }

/** 二项比例的 Wilson 区间；小样本下不使用会越界的 Wald 区间。 */
export function wilsonInterval(successes: number, n: number, z = 1.959963984540054): ConfidenceInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n < 0 || successes < 0 || successes > n) throw new Error("invalid_binomial_sample");
  if (n === 0) return { estimate: 0, lower: 0, upper: 1, confidence: 0.95, n };
  const p = successes / n; const z2 = z * z; const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) / n) + z2 / (4 * n * n)) / denominator;
  return { estimate: p, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), confidence: 0.95, n };
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}
function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0; const position = (sorted.length - 1) * p;
  const lower = Math.floor(position); const fraction = position - lower;
  return sorted[lower] + ((sorted[lower + 1] ?? sorted[lower]) - sorted[lower]) * fraction;
}

/** 任务为抽样单位的 percentile bootstrap，避免把同一对话中的 turn 当成独立样本。 */
export function bootstrapMean(values: readonly number[], options: { resamples?: number; seed?: number } = {}): ConfidenceInterval {
  if (!values.length || values.some(value => !Number.isFinite(value))) return { estimate: 0, lower: 0, upper: 0, confidence: 0.95, n: values.length };
  const random = rng(options.seed ?? 20260920); const resamples = options.resamples ?? 5000;
  const estimates = Array.from({ length: resamples }, () => {
    let sum = 0; for (let i = 0; i < values.length; i += 1) sum += values[Math.floor(random() * values.length)];
    return sum / values.length;
  }).sort((a, b) => a - b);
  const estimate = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { estimate, lower: quantile(estimates, 0.025), upper: quantile(estimates, 0.975), confidence: 0.95, n: values.length };
}

/** 相同任务的新旧版本配对差值；正数表示 candidate 较大。 */
export function pairedBootstrapDifference(baseline: readonly number[], candidate: readonly number[], options: { resamples?: number; seed?: number } = {}): ConfidenceInterval {
  if (baseline.length !== candidate.length) throw new Error("paired_sample_size_mismatch");
  return bootstrapMean(candidate.map((value, index) => value - baseline[index]), options);
}
