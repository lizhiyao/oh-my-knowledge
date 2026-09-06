/**
 * Human gold dataset agreement metrics.
 *
 * Why this module exists
 * ----------------------
 * Bootstrap CI gives us *precision* — how stable the judge is across
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
 *  - **Krippendorff's α (interval weights)** — primary. Distribution-free,
 *    doesn't assume coders are exchangeable (good fit when one "coder" is a model
 *    and the other a human annotator). Uses interval distance δ²=(c−k)² — a
 *    defensible choice for 1-5 Likert; an ordinal-distance variant would change α
 *    (BREAKING-COMPARABILITY) and is not implemented here.
 *  - **Quadratic-weighted Cohen's κ** — secondary. Familiar to many readers,
 *    useful as a sanity check. Reports lower than α when marginals diverge.
 *  - **Pearson r** — tertiary. Captures rank-order agreement only; doesn't
 *    penalize systematic offset (a judge that always scores 1 lower than gold
 *    has Pearson 1 but α < 1). Listed for completeness.
 *
 * All three are wrapped with a bootstrap CI on α (the primary) so the user can
 * see uncertainty on the agreement number itself when N is small.
 */

import {
  drawBootstrapMetric,
  summarizeBootstrapMetric,
} from '../analysis/bootstrap.js';

export interface RatingPair {
  /** Per-sample identifier; used only for diagnostics. */
  unitId: string;
  /** Score from coder A — convention: gold annotator goes here. */
  coderA: number;
  /** Score from coder B — convention: LLM judge goes here. */
  coderB: number;
}


export type AgreementStatisticEvidence =
  | Readonly<{ statisticStatus: 'observed'; value: number }>
  | Readonly<{
      statisticStatus: 'missing';
      reasonCode:
        | 'agreement-insufficient-pairs'
        | 'agreement-zero-expected-disagreement'
        | 'agreement-statistic-undefined';
    }>;

export type AgreementIntervalEvidence =
  | Readonly<{
      intervalStatus: 'observed';
      low: number;
      high: number;
      estimate: number;
      samples: number;
      confidenceLevel: number;
      drawCoverage: Readonly<{
        plannedDraws: number;
        observedDraws: number;
        missingDraws: 0;
      }>;
    }>
  | Readonly<{
      intervalStatus: 'missing';
      reasonCode:
        | 'agreement-point-unobserved'
        | 'agreement-bootstrap-not-applicable-perfect'
        | 'agreement-bootstrap-draws-incomplete';
      confidenceLevel: number;
      drawCoverage: Readonly<{
        plannedDraws: number;
        observedDraws: number;
        missingDraws: number;
      }>;
    }>;

/**
 * Structured agreement evidence for decision or projection boundaries.
 *
 * Unlike the historical convenience API, this follows Krippendorff's
 * recommended reliability bootstrap: each draw recomputes observed
 * disagreement while expected disagreement remains fixed from the original
 * data.
 * This avoids conditioning interval quantiles on only finite draws when a
 * resample collapses to one rating value. Perfect observed agreement is a
 * documented non-applicability case rather than a fabricated interval.
 */
export interface AgreementEvidenceResult {
  readonly krippendorffAlpha: AgreementStatisticEvidence;
  readonly alphaInterval: AgreementIntervalEvidence;
  readonly weightedKappa: AgreementStatisticEvidence;
  readonly pearson: AgreementStatisticEvidence;
  readonly sampleCount: number;
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
  const Do = observedDisagreement(pairs);
  const De = expectedDisagreement(pairs);
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

function statisticEvidence(
  value: number,
  insufficient: boolean,
  undefinedReason: 'agreement-zero-expected-disagreement' | 'agreement-statistic-undefined',
): AgreementStatisticEvidence {
  if (insufficient) {
    return { statisticStatus: 'missing', reasonCode: 'agreement-insufficient-pairs' };
  }
  return Number.isFinite(value)
    ? { statisticStatus: 'observed', value: roundOrNaN(value) }
    : { statisticStatus: 'missing', reasonCode: undefinedReason };
}

function expectedDisagreement(pairs: readonly RatingPair[]): number {
  const marginal = new Map<number, number>();
  for (const pair of pairs) {
    marginal.set(pair.coderA, (marginal.get(pair.coderA) ?? 0) + 1);
    marginal.set(pair.coderB, (marginal.get(pair.coderB) ?? 0) + 1);
  }

  const totalMass = 2 * pairs.length;
  let expectedSum = 0;
  for (const [coderA, coderACount] of marginal) {
    for (const [coderB, coderBCount] of marginal) {
      expectedSum += coderACount * coderBCount * (coderA - coderB) ** 2;
    }
  }
  return expectedSum / (totalMass * (totalMass - 1));
}

function observedDisagreement(pairs: readonly RatingPair[]): number {
  let observedSum = 0;
  for (const pair of pairs) {
    observedSum += (pair.coderA - pair.coderB) ** 2;
  }
  return observedSum / pairs.length;
}

export function computeAgreementEvidence(
  pairs: RatingPair[],
  options: {
    samples?: number;
    seed?: number;
    alpha?: number;
    scale?: { min: number; max: number };
  } = {},
): AgreementEvidenceResult {
  const { samples = 1000, seed, alpha = 0.05, scale } = options;
  if (!Number.isSafeInteger(samples) || samples <= 0) {
    throw new TypeError('Agreement bootstrap samples must be a positive safe integer.');
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new TypeError('Agreement alpha must be a finite number between 0 and 1.');
  }
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0)) {
    throw new TypeError('Agreement bootstrap seed must be a non-negative safe integer.');
  }
  const insufficient = pairs.length < 2;
  const rawAlpha = insufficient ? Number.NaN : computeKrippendorffAlpha(pairs);
  const krippendorffAlpha = statisticEvidence(
    rawAlpha,
    insufficient,
    'agreement-zero-expected-disagreement',
  );
  const weightedKappa = statisticEvidence(
    insufficient ? Number.NaN : computeWeightedKappa(pairs, scale),
    insufficient,
    'agreement-statistic-undefined',
  );
  const pearson = statisticEvidence(
    insufficient ? Number.NaN : computePearson(pairs),
    insufficient,
    'agreement-statistic-undefined',
  );
  const confidenceLevel = 1 - alpha;
  if (krippendorffAlpha.statisticStatus !== 'observed') {
    return {
      krippendorffAlpha,
      alphaInterval: {
        intervalStatus: 'missing',
        reasonCode: 'agreement-point-unobserved',
        confidenceLevel,
        drawCoverage: { plannedDraws: samples, observedDraws: 0, missingDraws: samples },
      },
      weightedKappa,
      pearson,
      sampleCount: pairs.length,
    };
  }

  if (rawAlpha === 1) {
    return {
      krippendorffAlpha,
      alphaInterval: {
        intervalStatus: 'missing',
        reasonCode: 'agreement-bootstrap-not-applicable-perfect',
        confidenceLevel,
        drawCoverage: { plannedDraws: samples, observedDraws: 0, missingDraws: samples },
      },
      weightedKappa,
      pearson,
      sampleCount: pairs.length,
    };
  }

  const originalExpectedDisagreement = expectedDisagreement(pairs);
  const indices = pairs.map((_, index) => index);
  const distribution = drawBootstrapMetric(
    indices,
    (resampled) => {
      const resampledObservedDisagreement = observedDisagreement(
        resampled.map((index) => pairs[index]),
      );
      return Math.max(
        -1,
        Math.min(1, 1 - resampledObservedDisagreement / originalExpectedDisagreement),
      );
    },
    samples,
    seed,
  );
  const finiteDraws = distribution.draws.filter(Number.isFinite);
  const missingDraws = samples - finiteDraws.length;
  if (missingDraws > 0) {
    return {
      krippendorffAlpha,
      alphaInterval: {
        intervalStatus: 'missing',
        reasonCode: 'agreement-bootstrap-draws-incomplete',
        confidenceLevel,
        drawCoverage: {
          plannedDraws: samples,
          observedDraws: finiteDraws.length,
          missingDraws,
        },
      },
      weightedKappa,
      pearson,
      sampleCount: pairs.length,
    };
  }

  const interval = summarizeBootstrapMetric(rawAlpha, finiteDraws, alpha, samples);
  return {
    krippendorffAlpha,
    alphaInterval: {
      intervalStatus: 'observed',
      low: interval.low,
      high: interval.high,
      estimate: interval.estimate,
      samples: interval.samples,
      confidenceLevel,
      drawCoverage: { plannedDraws: samples, observedDraws: samples, missingDraws: 0 },
    },
    weightedKappa,
    pearson,
    sampleCount: pairs.length,
  };
}

function roundOrNaN(x: number): number {
  if (Number.isNaN(x)) return NaN;
  return Math.round(x * 10000) / 10000;
}
