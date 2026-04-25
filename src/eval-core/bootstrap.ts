/**
 * Bootstrap confidence intervals — replaces / supplements t-test for LLM eval.
 *
 * Why bootstrap instead of t-test for LLM scores?
 *
 * 1. **No distribution assumption** — t-test assumes scores are normally
 *    distributed. LLM scores on a 1-5 ordinal scale violate this; bootstrap
 *    only requires that the sample is representative.
 * 2. **Small N robustness** — t-test's small-sample correction (df-adjusted)
 *    breaks down with N < 10. Bootstrap is consistent at any N >= 2.
 * 3. **Difference-of-means is the actual question** — In A/B eval the user
 *    asks "is variant B better than A?" — this is a 2-sample comparison and
 *    needs CI on the *difference*, not on each variant's mean separately.
 *
 * This module exports:
 *   - bootstrapMeanCI: CI for a single variant's mean
 *   - bootstrapDiffCI: CI for the difference (B - A); 0 outside the CI = significant
 *   - bootstrapWithMetric: generic interface so saturation analysis can reuse
 *
 * Reproducibility: pass a fixed `seed` to get deterministic CIs across runs.
 * Without a seed we use Math.random() — fine for production but not for tests.
 */

export interface BootstrapCI {
  /** Lower bound of the CI. */
  low: number;
  /** Upper bound of the CI. */
  high: number;
  /** The point estimate (mean of original sample, or whatever metric was passed). */
  estimate: number;
  /** Number of bootstrap resamples performed. */
  samples: number;
}

export interface BootstrapDiffCI extends BootstrapCI {
  /** Whether 0 is inside the CI — when false, the difference is statistically significant. */
  significant: boolean;
}

/** Mulberry32 PRNG — seedable, deterministic for tests. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed?: number): () => number {
  if (seed == null) return Math.random;
  return mulberry32(seed);
}

/** Sample n indices with replacement from [0, length) using the given PRNG. */
function resampleIndices(length: number, n: number, rng: () => number): number[] {
  const indices: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    indices[i] = Math.floor(rng() * length);
  }
  return indices;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const x of arr) sum += x;
  return sum / arr.length;
}

/** Quantile of a sorted array using linear interpolation. */
function sortedQuantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Bootstrap confidence interval for the mean of a single sample.
 *
 * @param scores  Sample observations (e.g., scores from N evaluation samples).
 * @param alpha   Significance level. 0.05 = 95% CI. Default 0.05.
 * @param samples Number of bootstrap resamples. Default 1000.
 * @param seed    Optional seed for deterministic CIs (tests).
 * @returns       { low, high, estimate, samples }; all numbers rounded to 4 decimals.
 */
export function bootstrapMeanCI(
  scores: number[],
  alpha = 0.05,
  samples = 1000,
  seed?: number,
): BootstrapCI {
  if (scores.length === 0) {
    return { low: 0, high: 0, estimate: 0, samples: 0 };
  }
  if (scores.length === 1) {
    return { low: scores[0], high: scores[0], estimate: scores[0], samples: 0 };
  }
  const rng = makeRng(seed);
  const resampleMeans: number[] = new Array(samples);
  for (let b = 0; b < samples; b++) {
    const idx = resampleIndices(scores.length, scores.length, rng);
    let sum = 0;
    for (const i of idx) sum += scores[i];
    resampleMeans[b] = sum / scores.length;
  }
  resampleMeans.sort((a, b) => a - b);
  return {
    low: round4(sortedQuantile(resampleMeans, alpha / 2)),
    high: round4(sortedQuantile(resampleMeans, 1 - alpha / 2)),
    estimate: round4(mean(scores)),
    samples,
  };
}

/**
 * Bootstrap confidence interval for the *difference* of two sample means
 * (treatment - control). Each bootstrap iteration resamples both groups
 * independently and computes mean(B) - mean(A).
 *
 * The `significant` flag is true when 0 falls outside the CI — a clean
 * proxy for "treatment differs from control at the alpha level".
 *
 * @param scoresA  Control / baseline sample (scoresA → first group, the subtrahend in the diff).
 * @param scoresB  Treatment sample.
 * @param alpha    Significance level. Default 0.05.
 * @param samples  Bootstrap resamples. Default 1000.
 * @param seed     Optional seed.
 * @returns        BootstrapDiffCI with low/high of (B - A) and significant flag.
 */
export function bootstrapDiffCI(
  scoresA: number[],
  scoresB: number[],
  alpha = 0.05,
  samples = 1000,
  seed?: number,
): BootstrapDiffCI {
  if (scoresA.length === 0 || scoresB.length === 0) {
    return { low: 0, high: 0, estimate: 0, samples: 0, significant: false };
  }
  const rng = makeRng(seed);
  const diffMeans: number[] = new Array(samples);
  for (let b = 0; b < samples; b++) {
    const idxA = resampleIndices(scoresA.length, scoresA.length, rng);
    const idxB = resampleIndices(scoresB.length, scoresB.length, rng);
    let sumA = 0;
    let sumB = 0;
    for (const i of idxA) sumA += scoresA[i];
    for (const i of idxB) sumB += scoresB[i];
    diffMeans[b] = sumB / scoresB.length - sumA / scoresA.length;
  }
  diffMeans.sort((a, b) => a - b);
  const low = round4(sortedQuantile(diffMeans, alpha / 2));
  const high = round4(sortedQuantile(diffMeans, 1 - alpha / 2));
  return {
    low,
    high,
    estimate: round4(mean(scoresB) - mean(scoresA)),
    samples,
    significant: !(low <= 0 && 0 <= high),
  };
}

/**
 * Generic bootstrap CI for an arbitrary sample-level metric. Used by
 * saturation analysis (Phase 4) to get CI on metrics like stddev or
 * agreement, not just mean.
 *
 * @param scores   Original sample.
 * @param metricFn Function reducing a resampled array to a scalar.
 */
export function bootstrapWithMetric(
  scores: number[],
  metricFn: (resampled: number[]) => number,
  alpha = 0.05,
  samples = 1000,
  seed?: number,
): BootstrapCI {
  if (scores.length === 0) return { low: 0, high: 0, estimate: 0, samples: 0 };
  const rng = makeRng(seed);
  const metricValues: number[] = new Array(samples);
  for (let b = 0; b < samples; b++) {
    const idx = resampleIndices(scores.length, scores.length, rng);
    const resampled = idx.map((i) => scores[i]);
    metricValues[b] = metricFn(resampled);
  }
  metricValues.sort((a, b) => a - b);
  return {
    low: round4(sortedQuantile(metricValues, alpha / 2)),
    high: round4(sortedQuantile(metricValues, 1 - alpha / 2)),
    estimate: round4(metricFn(scores)),
    samples,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
