/**
 * Statistical functions via simple-statistics.
 */

import * as ss from 'simple-statistics';

export function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return ss.mean(arr);
}

export function stddev(arr) {
  if (!arr || arr.length < 2) return 0;
  return ss.sampleStandardDeviation(arr);
}

/**
 * Compute 95% confidence interval for the mean.
 */
export function confidenceInterval(arr, confidence = 0.95) {
  const m = mean(arr);
  const sd = stddev(arr);
  if (arr.length < 2) return { mean: m, lower: m, upper: m, stddev: sd };

  const se = sd / Math.sqrt(arr.length);
  const df = arr.length - 1;
  const tCrit = df <= 30 ? T_TABLE_95[df] || 1.96 : 1.96;

  return {
    mean: Number(m.toFixed(4)),
    lower: Number((m - tCrit * se).toFixed(4)),
    upper: Number((m + tCrit * se).toFixed(4)),
    stddev: Number(sd.toFixed(4)),
  };
}

// t-distribution critical values for 95% confidence (two-tailed)
const T_TABLE_95 = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
  6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
  16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
  21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
  26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
};

/**
 * Welch's t-test (unequal variance two-sample test).
 */
export function tTest(a, b) {
  if (a.length < 2 || b.length < 2) {
    return { tStatistic: 0, df: 0, significant: false };
  }

  const mA = ss.mean(a);
  const mB = ss.mean(b);
  const varA = ss.sampleVariance(a);
  const varB = ss.sampleVariance(b);

  const seA = varA / a.length;
  const seB = varB / b.length;
  const seDiff = Math.sqrt(seA + seB);

  if (seDiff === 0) return { tStatistic: 0, df: a.length + b.length - 2, significant: false };

  const t = (mA - mB) / seDiff;

  // Welch-Satterthwaite degrees of freedom
  const df = Math.floor(
    (seA + seB) ** 2 / (seA ** 2 / (a.length - 1) + seB ** 2 / (b.length - 1)),
  );

  // Check significance: |t| > t_critical
  const tc = df <= 30 ? (T_TABLE_95[df] || 1.96) : 1.96;
  const significant = Math.abs(t) > tc;

  return {
    tStatistic: Number(t.toFixed(4)),
    df,
    significant,
  };
}
