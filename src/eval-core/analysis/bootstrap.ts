import {
  arithmeticMean,
  bootstrapDistribution,
  mulberry32,
  percentileBounds,
  type BootstrapGroup,
} from './bootstrap-kernel.js';

/**
 * Bootstrap confidence intervals — replaces / supplements t-test for LLM eval.
 *
 * Why bootstrap instead of t-test for LLM scores?
 *
 * 1. **No normality assumption** — the resampling distribution comes from the
 *    observed units instead of assuming normally distributed raw scores.
 * 2. **Explicit finite-sample limits** — the empirical distribution still has
 *    to represent the population. Percentile intervals can undercover for
 *    discrete 1-5 scores and small N; deterministic conformance simulations
 *    pin that limitation instead of treating the nominal level as a guarantee.
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
 *
 * Scope: this Core API configures the shared bootstrap kernel for the frozen
 * product profile used by omk.bootstrap-family-table nodes. Core bootstrap.* /v1
 * configures that same kernel with plan-derived SHA draws, unrounded bounds, and
 * explicit sampling strata. Profiles share the implementation and estimands, not
 * byte-identical intervals. Changing profiles requires a new measurement identity; the paired
 * reference vectors in test/eval-core/conformance/statistics.test.ts guard this
 * boundary. See docs/specs/evaluation-scoring-equivalence.md.
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

export interface BootstrapDifferenceDraws extends BootstrapMetricDraws {
  /** Whether every possible resample has a strictly positive or negative difference. */
  exactSign: 'positive' | 'negative' | null;
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

function makeRng(seed?: number): () => number {
  // 默认确定性:无显式 seed 时退 DEFAULT_BOOTSTRAP_SEED(而非 Math.random)——否则同一 eval 两跑会得到
  // 不同 CI,临界点 significant 翻转 → verdict 不可复现。见模块头 Reproducibility。
  return mulberry32(seed ?? DEFAULT_BOOTSTRAP_SEED);
}

function productGroup(values: readonly number[], rng: () => number): BootstrapGroup {
  return { values, indexFor: () => Math.floor(rng() * values.length) };
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : arithmeticMean(values);
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
  const distribution = drawBootstrapMetric(scores, mean, samples, seed);
  return summarizeBootstrapMetric(distribution.estimate, distribution.draws, alpha, samples);
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
  const distribution = drawBootstrapIndependentDifferences(scoresA, scoresB, samples, seed);
  const bounds = percentileBounds(distribution.draws, alpha);
  const low = round4(bounds.lower);
  const high = round4(bounds.upper);
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
  const distribution = drawBootstrapPairedDifferences(pairs, samples, seed);
  const bounds = percentileBounds(distribution.draws, alpha);
  const low = round4(bounds.lower);
  const high = round4(bounds.upper);
  return {
    low,
    high,
    estimate: round4(distribution.estimate),
    samples,
    // significant 与持久化的(舍入)边界一致 —— 见函数头:绝不出现「low:0 但 significant:true」自相矛盾。
    significant: !(low <= 0 && 0 <= high),
  };
}

/** Generate deterministic independent-group difference draws without persistence rounding. */
export function drawBootstrapIndependentDifferences(
  scoresA: readonly number[],
  scoresB: readonly number[],
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): BootstrapDifferenceDraws {
  if (scoresA.length === 0 || scoresB.length === 0) {
    return { estimate: 0, draws: [], exactSign: null };
  }
  const rng = makeRng(seed);
  const draws = bootstrapDistribution(
    [productGroup(scoresA, rng), productGroup(scoresB, rng)],
    samples,
    ([control, treatment]) => arithmeticMean(treatment) - arithmeticMean(control),
  );
  let minimumA = Number.POSITIVE_INFINITY;
  let maximumA = Number.NEGATIVE_INFINITY;
  let minimumB = Number.POSITIVE_INFINITY;
  let maximumB = Number.NEGATIVE_INFINITY;
  for (const score of scoresA) {
    minimumA = Math.min(minimumA, score);
    maximumA = Math.max(maximumA, score);
  }
  for (const score of scoresB) {
    minimumB = Math.min(minimumB, score);
    maximumB = Math.max(maximumB, score);
  }
  const minimumDifference = minimumB - maximumA;
  const maximumDifference = maximumB - minimumA;
  return {
    estimate: mean(scoresB) - mean(scoresA),
    draws,
    exactSign: minimumDifference > 0
      ? 'positive'
      : maximumDifference < 0 ? 'negative' : null,
  };
}

/** Generate deterministic pair-preserving difference draws without persistence rounding. */
export function drawBootstrapPairedDifferences(
  pairs: readonly Readonly<{ a: number; b: number }>[],
  samples = DEFAULT_BOOTSTRAP_SAMPLES,
  seed?: number,
): BootstrapDifferenceDraws {
  if (pairs.length === 0) return { estimate: 0, draws: [], exactSign: null };
  const differences = pairs.map((pair) => pair.b - pair.a);
  const rng = makeRng(seed);
  const draws = bootstrapDistribution(
    [productGroup(differences, rng)], samples, ([sample]) => arithmeticMean(sample),
  );
  return {
    estimate: mean(differences),
    draws,
    exactSign: differences.every((difference) => difference > 0)
      ? 'positive'
      : differences.every((difference) => difference < 0) ? 'negative' : null,
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
  const metricValues = bootstrapDistribution(
    [productGroup(scores, rng)], samples, ([sample]) => metricFn(sample),
  );
  return { estimate: metricFn(scores), draws: metricValues };
}

/** Summarize an explicit draw set using OMK's frozen percentile and rounding rules. */
export function summarizeBootstrapMetric(
  estimate: number,
  draws: number[],
  alpha = DEFAULT_BOOTSTRAP_ALPHA,
  samples = draws.length,
): BootstrapCI {
  const bounds = percentileBounds(draws, alpha);
  return {
    low: round4(bounds.lower),
    high: round4(bounds.upper),
    estimate: round4(estimate),
    samples,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
