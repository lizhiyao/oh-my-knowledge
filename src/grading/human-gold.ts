/**
 * Human gold dataset agreement metrics.
 *
 * Why this module exists
 * ----------------------
 * Bootstrap CI (Phase 1) gives us *precision* — how stable the judge is across
 * resampled evaluations. It does not give us *validity* — whether the judge is
 * scoring the right thing at all. A judge can be extremely consistent (CI very
 * narrow) and yet systematically biased; that's an undetected failure mode.
 *
 * Human gold (or stronger-model gold as a proxy) provides an external anchor.
 * We compute agreement between the LLM judge and the gold annotator, and report
 * the result alongside the Bootstrap CI. Both numbers must be acceptable for a
 * conclusion to be trustworthy.
 *
 * Three metrics are exported:
 *
 *  - **Krippendorff's α (interval)** — primary. Distribution-free, supports
 *    ordinal/interval scales naturally, doesn't assume coders are exchangeable
 *    (good fit when one "coder" is a model and the other a human annotator).
 *  - **Quadratic-weighted Cohen's κ** — secondary. Familiar to many readers,
 *    useful as a sanity check. Reports lower than α when marginals diverge.
 *  - **Pearson r** — tertiary. Captures rank-order agreement only; doesn't
 *    penalize systematic offset (a judge that always scores 1 lower than gold
 *    has Pearson 1 but α < 1). Listed for completeness.
 *
 * All three are wrapped with a bootstrap CI on α (the primary) so the user can
 * see uncertainty on the agreement number itself when N is small.
 */

import { bootstrapWithMetric, type BootstrapCI } from '../eval-core/bootstrap.js';

export interface RatingPair {
  /** Per-sample identifier; used only for diagnostics. */
  unitId: string;
  /** Score from coder A — convention: gold annotator goes here. */
  coderA: number;
  /** Score from coder B — convention: LLM judge goes here. */
  coderB: number;
}

export interface AgreementResult {
  /** Krippendorff α (interval weights). 1 = perfect, 0 = chance, < 0 = worse than chance. */
  alpha: number;
  /** 95% bootstrap CI on α — width signals uncertainty due to sample size. */
  alphaCI: BootstrapCI;
  /** Quadratic-weighted κ. */
  weightedKappa: number;
  /** Pearson product-moment correlation. NaN if either coder has zero variance. */
  pearson: number;
  /** How many rating pairs went into the calculation. */
  sampleCount: number;
}

/**
 * Krippendorff's α with interval weights for two coders.
 *
 * Implementation follows Krippendorff (2011), "Computing Krippendorff's
 * Alpha-Reliability". For interval scales the metric is δ²(c, k) = (c − k)².
 *
 * For two coders with one rating per unit:
 *   - Coincidence matrix entries o_{c,k} count both (a_u, b_u) and (b_u, a_u),
 *     so total mass n_·· = 2N.
 *   - D_o = Σ o_{c,k} · δ²(c,k) / n_··
 *   - D_e = Σ n_c · n_k · δ²(c,k) / (n_·· (n_·· − 1))
 *   - α   = 1 − D_o / D_e
 *
 * Returns NaN when D_e = 0 (e.g. all ratings identical across both coders) —
 * agreement is undefined when there is no variance to disagree about.
 */
export function computeKrippendorffAlpha(pairs: RatingPair[]): number {
  if (pairs.length === 0) return NaN;

  // Marginal counts: how many times each value appears across both coders.
  const marginal = new Map<number, number>();
  for (const p of pairs) {
    marginal.set(p.coderA, (marginal.get(p.coderA) ?? 0) + 1);
    marginal.set(p.coderB, (marginal.get(p.coderB) ?? 0) + 1);
  }
  const totalMass = 2 * pairs.length; // n_··

  // Observed disagreement: average squared distance within units, ×2 because
  // each unit contributes (a,b) and (b,a). Equivalent to mean (a-b)² over units.
  let observedSum = 0;
  for (const p of pairs) {
    observedSum += 2 * (p.coderA - p.coderB) ** 2;
  }
  const Do = observedSum / totalMass;

  // Expected disagreement under chance: pair every value with every other value
  // proportional to marginals.
  let expectedSum = 0;
  const values = [...marginal.keys()];
  for (const c of values) {
    const nc = marginal.get(c)!;
    for (const k of values) {
      const nk = marginal.get(k)!;
      expectedSum += nc * nk * (c - k) ** 2;
    }
  }
  const denom = totalMass * (totalMass - 1);
  if (denom === 0) return NaN;
  const De = expectedSum / denom;
  if (De === 0) return NaN; // no variance => agreement is undefined

  return 1 - Do / De;
}

/**
 * Cohen's quadratic-weighted κ for two coders on a numeric scale.
 *
 *   w(i,j)   = (i − j)² / (K − 1)²    (disagreement weight, scaled to [0,1])
 *   po_w     = mean over units of (1 − w(a_u, b_u))
 *   pe_w     = Σ_{i,j} marg_a(i) · marg_b(j) · (1 − w(i,j)) / N²
 *   κ_w      = (po_w − pe_w) / (1 − pe_w)
 *
 * For continuous (non-integer) scores we still need a scale range; the caller
 * passes (min, max). Default 1..5 fits omk's standard rubric.
 */
export function computeWeightedKappa(
  pairs: RatingPair[],
  scale: { min: number; max: number } = { min: 1, max: 5 },
): number {
  if (pairs.length === 0) return NaN;
  const range = scale.max - scale.min;
  if (range <= 0) return NaN;
  const denom2 = range * range;

  const margA = new Map<number, number>();
  const margB = new Map<number, number>();
  for (const p of pairs) {
    margA.set(p.coderA, (margA.get(p.coderA) ?? 0) + 1);
    margB.set(p.coderB, (margB.get(p.coderB) ?? 0) + 1);
  }
  const N = pairs.length;

  let poWeighted = 0;
  for (const p of pairs) {
    const w = ((p.coderA - p.coderB) ** 2) / denom2;
    poWeighted += 1 - w;
  }
  poWeighted /= N;

  let peWeighted = 0;
  for (const [i, ni] of margA) {
    for (const [j, nj] of margB) {
      const w = ((i - j) ** 2) / denom2;
      peWeighted += (ni * nj) * (1 - w);
    }
  }
  peWeighted /= N * N;

  if (peWeighted === 1) return NaN;
  return (poWeighted - peWeighted) / (1 - peWeighted);
}

/**
 * Pearson product-moment correlation. NaN when either coder has zero variance.
 */
export function computePearson(pairs: RatingPair[]): number {
  if (pairs.length < 2) return NaN;
  const n = pairs.length;
  let sumA = 0;
  let sumB = 0;
  for (const p of pairs) {
    sumA += p.coderA;
    sumB += p.coderB;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (const p of pairs) {
    const da = p.coderA - meanA;
    const db = p.coderB - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return NaN;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Compute α + κ + Pearson, with bootstrap CI on α.
 *
 * Bootstrap resamples pairs (units), not individual ratings — pairs are the
 * unit of replication; resampling individual ratings would break the (a,b) tie.
 */
export function computeAgreementWithCI(
  pairs: RatingPair[],
  options: { samples?: number; seed?: number; alpha?: number; scale?: { min: number; max: number } } = {},
): AgreementResult {
  const { samples = 1000, seed, alpha = 0.05, scale } = options;

  if (pairs.length === 0) {
    return {
      alpha: NaN,
      alphaCI: { low: NaN, high: NaN, estimate: NaN, samples: 0 },
      weightedKappa: NaN,
      pearson: NaN,
      sampleCount: 0,
    };
  }

  // Encode pairs as indices so bootstrapWithMetric can resample them.
  const indices = pairs.map((_, i) => i);
  const alphaCI = bootstrapWithMetric(
    indices,
    (resampledIdx) => computeKrippendorffAlpha(resampledIdx.map((i) => pairs[i])),
    alpha,
    samples,
    seed,
  );

  return {
    alpha: roundOrNaN(computeKrippendorffAlpha(pairs)),
    alphaCI,
    weightedKappa: roundOrNaN(computeWeightedKappa(pairs, scale)),
    pearson: roundOrNaN(computePearson(pairs)),
    sampleCount: pairs.length,
  };
}

function roundOrNaN(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return Math.round(x * 10000) / 10000;
}
