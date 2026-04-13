/**
 * Statistical functions for evaluation analysis.
 *
 * Assumptions:
 * - All inputs are independent observations from normally distributed populations
 * - Welch's t-test is used (does NOT assume equal variances)
 * - Confidence intervals use the t-distribution for small samples (df ≤ 30)
 *   and normal approximation (z = 1.96) for larger samples
 *
 * Dependencies: simple-statistics (for mean, sampleStandardDeviation, sampleVariance)
 */

import * as ss from 'simple-statistics';

/**
 * Arithmetic mean. Returns 0 for empty/null input.
 */
export function mean(arr: number[]): number {
  if (!arr || arr.length === 0) return 0;
  return ss.mean(arr);
}

/**
 * Sample standard deviation (Bessel's correction: n-1 denominator).
 * Returns 0 for arrays with fewer than 2 elements.
 */
export function stddev(arr: number[]): number {
  if (!arr || arr.length < 2) return 0;
  return ss.sampleStandardDeviation(arr);
}

// t-distribution critical values for two-tailed tests at p = 0.05, 0.01, 0.001.
// Source: standard statistical tables. Used both for the significance gate and
// for bucketed p-value reporting (see pValueCategory below).
const T_CRITICAL_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
  26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};

const T_CRITICAL_99: Record<number, number> = {
  1: 63.657, 2: 9.925, 3: 5.841, 4: 4.604, 5: 4.032,
  6: 3.707, 7: 3.499, 8: 3.355, 9: 3.250, 10: 3.169,
  11: 3.106, 12: 3.055, 13: 3.012, 14: 2.977, 15: 2.947,
  16: 2.921, 17: 2.898, 18: 2.878, 19: 2.861, 20: 2.845,
  21: 2.831, 22: 2.819, 23: 2.807, 24: 2.797, 25: 2.787,
  26: 2.779, 27: 2.771, 28: 2.763, 29: 2.756, 30: 2.750,
};

const T_CRITICAL_999: Record<number, number> = {
  1: 636.619, 2: 31.599, 3: 12.924, 4: 8.610, 5: 6.869,
  6: 5.959, 7: 5.408, 8: 5.041, 9: 4.781, 10: 4.587,
  11: 4.437, 12: 4.318, 13: 4.221, 14: 4.140, 15: 4.073,
  16: 4.015, 17: 3.965, 18: 3.922, 19: 3.883, 20: 3.850,
  21: 3.819, 22: 3.792, 23: 3.768, 24: 3.745, 25: 3.725,
  26: 3.707, 27: 3.690, 28: 3.674, 29: 3.659, 30: 3.646,
};

export type PValueCategory = '<0.001' | '<0.01' | '<0.05' | '≥0.05';

/**
 * Bucket a t-statistic into a p-value category by comparing |t| to standard
 * critical-value tables at α = 0.001 / 0.01 / 0.05 (two-tailed).
 *
 * Returns one of four buckets instead of a continuous p value. This avoids
 * implementing the regularized incomplete beta function for an exact CDF
 * while still giving readers enough resolution to distinguish
 * "barely significant" from "strongly significant".
 *
 * For df > 30 falls back to the normal-approximation critical values.
 */
export function pValueCategory(tStatistic: number, df: number): PValueCategory {
  if (!Number.isFinite(tStatistic) || df <= 0) return '≥0.05';
  const absT = Math.abs(tStatistic);
  const dfKey = Math.min(Math.max(1, Math.floor(df)), 30);
  const c999 = df > 30 ? 3.291 : (T_CRITICAL_999[dfKey] ?? 3.291);
  const c99 = df > 30 ? 2.576 : (T_CRITICAL_99[dfKey] ?? 2.576);
  const c95 = df > 30 ? 1.96 : (T_CRITICAL_95[dfKey] ?? 1.96);
  if (absT >= c999) return '<0.001';
  if (absT >= c99) return '<0.01';
  if (absT >= c95) return '<0.05';
  return '≥0.05';
}

/**
 * Get t-distribution critical value for given degrees of freedom (95% CI, two-tailed).
 * Uses lookup table for df ≤ 30, normal approximation (1.96) for df > 30.
 */
function tCritical(df: number): number {
  if (df <= 0) return Infinity;
  if (df <= 30) return T_CRITICAL_95[df] || T_CRITICAL_95[30];
  return 1.96;
}

/**
 * Compute 95% confidence interval for the population mean.
 *
 * Method: t-interval (appropriate for small samples from normal populations)
 * Formula: mean ± t(α/2, n-1) × (s / √n)
 */
export function confidenceInterval(arr: number[]): { mean: number; lower: number; upper: number; stddev: number } {
  const m = mean(arr);
  const sd = stddev(arr);

  if (!arr || arr.length < 2) {
    return { mean: m, lower: m, upper: m, stddev: sd };
  }

  const n = arr.length;
  const se = sd / Math.sqrt(n);        // Standard error of the mean
  const df = n - 1;                     // Degrees of freedom
  const tc = tCritical(df);             // Critical value
  const margin = tc * se;               // Margin of error

  return {
    mean: Number(m.toFixed(4)),
    lower: Number((m - margin).toFixed(4)),
    upper: Number((m + margin).toFixed(4)),
    stddev: Number(sd.toFixed(4)),
  };
}

/**
 * Welch's t-test for two independent samples with unequal variances.
 *
 * Tests H₀: μ₁ = μ₂ (no difference in population means)
 * Uses Welch-Satterthwaite approximation for degrees of freedom.
 *
 * Requires at least 2 observations per group. Returns non-significant
 * result for insufficient data or zero variance in both groups.
 */
export interface EffectSizeResult {
  cohensD: number;
  hedgesG: number;
  primary: 'd' | 'g' | 'none';
  magnitude: 'negligible' | 'small' | 'medium' | 'large' | 'none';
  pooledStddev: number;
  n1: number;
  n2: number;
}

/**
 * Effect size for two independent samples.
 *
 * Cohen's d:   (mean_a - mean_b) / pooled_stddev
 * Hedges' g:   J * d, where J = 1 - 3 / (4 * (n1 + n2) - 9)
 *
 * Hedges' g corrects Cohen's d's small-sample bias (Hedges 1981) and is
 * preferred when n1 + n2 < 20. For n1 + n2 >= 20 the correction is < 5%
 * and Cohen's d is the conventional choice.
 *
 * `primary` indicates which to emphasize in UI based on total sample size.
 * `magnitude` uses standard thresholds (|effect| 0.2 / 0.5 / 0.8) applied
 * to the primary metric.
 *
 * Returns effect 0 with primary 'none' for insufficient data or zero variance.
 */
export function effectSize(a: number[], b: number[]): EffectSizeResult {
  const n1 = a?.length ?? 0;
  const n2 = b?.length ?? 0;

  if (n1 < 2 || n2 < 2) {
    return { cohensD: 0, hedgesG: 0, primary: 'none', magnitude: 'none', pooledStddev: 0, n1, n2 };
  }

  const mA = ss.mean(a);
  const mB = ss.mean(b);
  const varA = ss.sampleVariance(a);
  const varB = ss.sampleVariance(b);

  // Pooled standard deviation (assumes similar variances; acceptable for
  // effect-size reporting even when Welch's t-test is used for significance)
  const pooledVar = ((n1 - 1) * varA + (n2 - 1) * varB) / (n1 + n2 - 2);
  const pooledStddev = Math.sqrt(pooledVar);

  if (pooledStddev === 0) {
    return { cohensD: 0, hedgesG: 0, primary: 'none', magnitude: 'none', pooledStddev: 0, n1, n2 };
  }

  const d = (mA - mB) / pooledStddev;

  // Hedges' correction factor J. Denominator guard: 4*(n1+n2)-9 > 0 iff n1+n2 > 2.25,
  // which is already satisfied by the n1>=2, n2>=2 check above.
  const J = 1 - 3 / (4 * (n1 + n2) - 9);
  const g = J * d;

  const totalN = n1 + n2;
  const primary: 'd' | 'g' = totalN < 20 ? 'g' : 'd';
  const ref = primary === 'g' ? g : d;
  const abs = Math.abs(ref);
  const magnitude: 'negligible' | 'small' | 'medium' | 'large' =
    abs < 0.2 ? 'negligible' :
    abs < 0.5 ? 'small' :
    abs < 0.8 ? 'medium' : 'large';

  return {
    cohensD: Number(d.toFixed(4)),
    hedgesG: Number(g.toFixed(4)),
    primary,
    magnitude,
    pooledStddev: Number(pooledStddev.toFixed(4)),
    n1,
    n2,
  };
}

export function tTest(a: number[], b: number[]): { tStatistic: number; df: number; significant: boolean } {
  // Minimum sample size check
  if (!a || !b || a.length < 2 || b.length < 2) {
    return { tStatistic: 0, df: 0, significant: false };
  }

  const mA = ss.mean(a);
  const mB = ss.mean(b);
  const varA = ss.sampleVariance(a);
  const varB = ss.sampleVariance(b);

  // Estimated variances of sample means
  const seA = varA / a.length;
  const seB = varB / b.length;
  const seDiff = Math.sqrt(seA + seB);

  // Both groups have zero variance — means are exact, can't compute t
  if (seDiff === 0) {
    return {
      tStatistic: 0,
      df: a.length + b.length - 2,
      significant: mA !== mB, // Different constants are trivially significant
    };
  }

  // t-statistic
  const tStat = (mA - mB) / seDiff;

  // Welch-Satterthwaite degrees of freedom
  const dfNum = (seA + seB) ** 2;
  const dfDen = (seA ** 2 / (a.length - 1)) + (seB ** 2 / (b.length - 1));
  const df = Math.max(1, Math.floor(dfNum / dfDen));

  // Significance at α = 0.05 (two-tailed)
  const tc = tCritical(df);
  const significant = Math.abs(tStat) > tc;

  return {
    tStatistic: Number(tStat.toFixed(4)),
    df,
    significant,
  };
}
