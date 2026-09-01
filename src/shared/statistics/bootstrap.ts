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
 * Reproducibility: CIs are **deterministic by default** — when no `seed` is passed,
 * a fixed `DEFAULT_BOOTSTRAP_SEED` is used, so the same eval run twice yields
 * byte-identical CIs (and a stable verdict near the significance boundary). This is
 * a measurement-validity requirement: an unseeded `Math.random()` would let the
 * `significant` flag flip between identical runs. Library callers (and specific paths
 * such as `eval gold compare --seed`) may pass an explicit `seed` to vary the draw; the
 * main `omk eval` deliberately exposes no seed knob — a fixed default also prevents
 * seed-shopping for significance.
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

export interface BootstrapMetricDraws {
  /** Point estimate over the original observations, before persistence rounding. */
  estimate: number;
  /** One metric value per requested pair-preserving bootstrap draw. */
  draws: number[];
}

/**
 * Default number of bootstrap resamples. Every eval path uses this unless
 * `--bootstrap-samples` overrides it. Single source of truth: the docs cite
 * it and `test/scripts/doc-constants-drift.test.ts` guards doc ↔ code parity.
 */
export const DEFAULT_BOOTSTRAP_SAMPLES = 1000;

/** Default significance level; 0.05 → 95% CI. */
export const DEFAULT_BOOTSTRAP_ALPHA = 0.05;

/**
 * Fixed default bootstrap seed → CIs are **deterministic by default** (omk default-strict:
 * reproducibility affects verdict validity, so it is on by default, not opt-in). The specific
 * value is arbitrary — only that it is **fixed** matters; it is an implementation detail, not a
 * user-facing constant, so unlike DEFAULT_BOOTSTRAP_SAMPLES / α it is neither cited in docs nor
 * guarded by `doc-constants-drift.test.ts`. Callers wanting a different draw pass an explicit `seed`.
 */
export const DEFAULT_BOOTSTRAP_SEED = 20260616;

/**
 * Confidence-level label for display: `(1 − α)·100%`. Multiple-comparison (Bonferroni) correction
 * shrinks a pairwise α to α/K and widens the CI accordingly — the label must track α so a corrected
 * (wider) interval is never mislabeled "95%". No alpha (single comparison / classic A-B) ⇒ nominal 95%.
 * Shared single source for the HTML renderer and the `omk eval` CLI verdict so both read one scale.
 */
export function ciLevelLabel(alpha?: number): string {
  const pct = (1 - (alpha ?? DEFAULT_BOOTSTRAP_ALPHA)) * 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(1))}%`;
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
  // 默认确定性:无显式 seed 时退 DEFAULT_BOOTSTRAP_SEED(而非 Math.random)——否则同一 eval 两跑会得到
  // 不同 CI,临界点 significant 翻转 → verdict 不可复现。见模块头 Reproducibility。
  return mulberry32(seed ?? DEFAULT_BOOTSTRAP_SEED);
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
  alpha = DEFAULT_BOOTSTRAP_ALPHA,
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
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
  alpha = DEFAULT_BOOTSTRAP_ALPHA,
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
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
 * Bootstrap CI for the *difference* of two means on **paired** observations — when A and B
 * are two measurements of the **same unit** (e.g. control vs treatment on the same sample,
 * or original vs alternate judge prompt on the same response). Resamples the **pair indices
 * jointly** and averages each pair's `b - a`, so the within-pair correlation is preserved.
 *
 * Why paired (vs `bootstrapDiffCI`'s independent resampling): when A and B move together
 * across units (the usual case — the same sample scored by two variants is positively
 * correlated), much of each group's variance is shared and cancels in the per-pair diff.
 * The independent (unpaired) bootstrap ignores that, over-states the diff's variance, and
 * widens the CI — *conservative*, costing real power. Use paired whenever the design is
 * paired; use `bootstrapDiffCI` only for genuinely independent groups (or where a deliberate
 * conservative bias is wanted). The point estimate is identical (mean of per-pair diffs =
 * difference of paired means); only the CI tightens.
 *
 * `significant` is derived from the **rounded** `low`/`high` (the persisted bounds), so the
 * flag never contradicts what is stored / displayed: a CI that rounds to include 0 reads as
 * not-significant. (Computing it on the unrounded bounds would let the JSON say `low: 0,
 * significant: true` — a self-contradictory `CI=[0, …]` that downstream `computeVerdict` and
 * external consumers cannot reconcile.) Matches `bootstrapDiffCI`.
 *
 * @param pairs    Aligned observations; `a` = control/baseline, `b` = treatment. diff = b - a.
 * @param alpha    Significance level. Default 0.05.
 * @param samples  Bootstrap resamples. Default 1000.
 * @param seed     Optional seed (deterministic by default — see module header).
 */
export function bootstrapPairedDiffCI(
  pairs: Array<{ a: number; b: number }>,
  alpha = DEFAULT_BOOTSTRAP_ALPHA,
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): BootstrapDiffCI {
  if (pairs.length === 0) {
    return { low: 0, high: 0, estimate: 0, samples: 0, significant: false };
  }
  const n = pairs.length;
  const diffs = pairs.map((p) => p.b - p.a);
  const rng = makeRng(seed);
  const resampleDiffMeans: number[] = new Array(samples);
  for (let s = 0; s < samples; s++) {
    const idx = resampleIndices(n, n, rng);
    let sum = 0;
    for (const i of idx) sum += diffs[i];
    resampleDiffMeans[s] = sum / n;
  }
  resampleDiffMeans.sort((a, b) => a - b);
  const low = round4(sortedQuantile(resampleDiffMeans, alpha / 2));
  const high = round4(sortedQuantile(resampleDiffMeans, 1 - alpha / 2));
  return {
    low,
    high,
    estimate: round4(mean(diffs)),
    samples,
    // significant 与持久化的(舍入)边界一致 —— 见函数头:绝不出现「low:0 但 significant:true」自相矛盾。
    significant: !(low <= 0 && 0 <= high),
  };
}

/**
 * Generic bootstrap CI for an arbitrary sample-level metric. Used by
 * saturation analysis to get CI on metrics like stddev or
 * agreement, not just mean.
 *
 * @param scores   Original sample.
 * @param metricFn Function reducing a resampled array to a scalar.
 */
export function bootstrapWithMetric(
  scores: number[],
  metricFn: (resampled: number[]) => number,
  alpha = DEFAULT_BOOTSTRAP_ALPHA,
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): BootstrapCI {
  if (scores.length === 0) return { low: 0, high: 0, estimate: 0, samples: 0 };
  const distribution = drawBootstrapMetric(scores, metricFn, samples, seed);
  return summarizeBootstrapMetric(
    distribution.estimate,
    distribution.draws,
    alpha,
    samples,
  );
}

/**
 * Generate the shared deterministic bootstrap draw stream without deciding how
 * undefined metric draws should be represented. Existing callers summarize every
 * draw unchanged; Core adapters may retain non-finite draw coverage as structured
 * missing evidence before summarization.
 */
export function drawBootstrapMetric(
  scores: number[],
  metricFn: (resampled: number[]) => number,
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): BootstrapMetricDraws {
  if (scores.length === 0) return { estimate: metricFn([]), draws: [] };
  const rng = makeRng(seed);
  const metricValues: number[] = new Array(samples);
  for (let b = 0; b < samples; b++) {
    const idx = resampleIndices(scores.length, scores.length, rng);
    const resampled = idx.map((i) => scores[i]);
    metricValues[b] = metricFn(resampled);
  }
  return { estimate: metricFn(scores), draws: metricValues };
}

/** Summarize an explicit draw set using OMK's frozen percentile and rounding rules. */
export function summarizeBootstrapMetric(
  estimate: number,
  draws: number[],
  alpha = DEFAULT_BOOTSTRAP_ALPHA,
  samples = draws.length,
): BootstrapCI {
  const metricValues = [...draws].sort((a, b) => a - b);
  return {
    low: round4(sortedQuantile(metricValues, alpha / 2)),
    high: round4(sortedQuantile(metricValues, 1 - alpha / 2)),
    estimate: round4(estimate),
    samples,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
