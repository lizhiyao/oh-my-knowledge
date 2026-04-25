/**
 * Saturation curve analysis — answers "have I run enough samples?"
 *
 * Why this exists
 * ---------------
 * The most common omk-user question after "is the difference significant?"
 * is "is N=30 enough, or should I keep running?". Without a principled
 * answer, users either over-pay (running 200 when 50 was enough) or
 * under-pay (calling skill effects null at N=30 when N=80 would have
 * shown clearly significant — Bootstrap CI from Phase 1 just hasn't
 * converged yet).
 *
 * Saturation analysis fits the right tool to the question: track a
 * convergence-of-evidence metric across cumulative sample counts; when
 * the metric stops moving meaningfully, you've saturated. Three metric
 * choices are exposed because each has a failure mode:
 *
 *  - **slope** (simplest): mean's rate of change between consecutive
 *    checkpoints. Easy to explain. Fragile to outlier samples.
 *  - **bootstrap-ci-width** (default): CI shrinks as O(1/√N); when its
 *    decay rate flattens, more samples buy little. Statistically
 *    grounded; pairs naturally with Phase 1.
 *  - **plateau-height**: range of mean across the last K checkpoints.
 *    Conservative — slow to declare saturation, hard to fool.
 *
 * The function never says "saturated" off a single observation: a 3-
 * window run-of-success is required. This guards against random dips
 * that look like convergence but aren't.
 */

import { bootstrapMeanCI } from '../eval-core/bootstrap.js';

export type SaturationMethod = 'slope' | 'bootstrap-ci-width' | 'plateau-height';

/**
 * One observation in a saturation curve. `n` is the cumulative sample
 * count at this checkpoint; `mean` and (optional) `ciWidth` come from
 * applying the chosen metric to all samples up to and including `n`.
 */
export interface SaturationCheckpoint {
  n: number;
  mean: number;
  ciWidth?: number;
}

export interface SaturationResult {
  /** True only after threshold satisfied for `windowSize` consecutive transitions. */
  saturated: boolean;
  /** Sample count at which saturation was first declared. null if not saturated. */
  atN: number | null;
  /** 'high' for ≥ 50 cumulative samples; 'medium' for [20, 50); 'low' below 20. */
  confidence: 'high' | 'medium' | 'low';
  /** Method that produced the verdict. */
  method: SaturationMethod;
  /** Threshold used. */
  threshold: number;
  /** Per-checkpoint metric trace, useful for plotting. */
  trace: Array<{ n: number; metric: number }>;
  /** Human-readable explanation of why we said yes / no. */
  reason: string;
}

/**
 * Compute saturation from a sequence of cumulative score arrays.
 *
 * `cumulativeScores[i]` is the array of all scores observed by checkpoint i
 * (the i-th element is the LATEST cumulative slice; arrays grow). Each slice
 * is fed to bootstrapMeanCI to get a (mean, CI) pair. The metric trajectory
 * is then evaluated by the chosen method.
 *
 * @param cumulativeScores Cumulative score arrays in chronological order.
 * @param method           Detection algorithm (default 'bootstrap-ci-width').
 * @param threshold        Method-specific cutoff (defaults match the method).
 * @param windowSize       Number of consecutive transitions that must all
 *                          satisfy the threshold (default 3).
 * @param bootstrapSamples Used only by 'bootstrap-ci-width' (default 1000).
 * @param seed             Optional seed for reproducible CIs.
 */
export function findSaturationPoint(
  cumulativeScores: number[][],
  method: SaturationMethod = 'bootstrap-ci-width',
  threshold?: number,
  windowSize = 3,
  bootstrapSamples = 1000,
  seed?: number,
): SaturationResult {
  const trace: SaturationResult['trace'] = [];
  const checkpoints: SaturationCheckpoint[] = [];

  for (const scores of cumulativeScores) {
    if (scores.length === 0) continue;
    const ci = bootstrapMeanCI(scores, 0.05, bootstrapSamples, seed);
    checkpoints.push({
      n: scores.length,
      mean: ci.estimate,
      ciWidth: ci.high - ci.low,
    });
  }

  // Default thresholds chosen for typical Likert-1-5 evaluations:
  //  - slope: |Δmean| / |ΔN| < 0.005 (5% of one rubric step over 100 samples)
  //  - bootstrap-ci-width: relative CI width shrink < 5% per checkpoint
  //  - plateau-height: max-min(mean) < 0.1 over the last 3 windows
  const t = threshold ?? defaultThreshold(method);
  const lastN = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].n : 0;
  const confidence: SaturationResult['confidence'] =
    lastN >= 50 ? 'high'
    : lastN >= 20 ? 'medium'
    : 'low';

  const baseShell = (overrides: Partial<SaturationResult>): SaturationResult => ({
    saturated: false,
    atN: null,
    confidence,
    method,
    threshold: t,
    trace,
    reason: '',
    ...overrides,
  });

  if (checkpoints.length < windowSize + 1) {
    return baseShell({
      reason: `数据点不足:有 ${checkpoints.length} 个,至少需要 ${windowSize + 1} 个`
        + ` (windowSize=${windowSize})`,
    });
  }

  // Compute per-method metric series. metric[i] is the "amount of change at
  // transition i" — how much the metric moved from checkpoint i-1 to i.
  // Rounded to 4 decimals to match bootstrap's precision and dodge IEEE-754
  // surprises (e.g. 4.0 - 3.9 = 0.10000000000000009 > 0.1).
  const round4 = (x: number): number =>
    Number.isFinite(x) ? Math.round(x * 10000) / 10000 : x;
  let metricSeries: Array<{ n: number; metric: number }>;
  let metricLabel: string;
  switch (method) {
    case 'slope': {
      metricSeries = checkpoints.slice(1).map((cp, i) => ({
        n: cp.n,
        metric: round4(Math.abs(cp.mean - checkpoints[i].mean) / Math.max(1, cp.n - checkpoints[i].n)),
      }));
      metricLabel = 'mean 变化斜率 |Δmean/ΔN|';
      break;
    }
    case 'bootstrap-ci-width': {
      metricSeries = checkpoints.slice(1).map((cp, i) => {
        const prev = checkpoints[i].ciWidth ?? 0;
        const curr = cp.ciWidth ?? 0;
        // Relative shrink: (prev - curr) / prev. Negative = CI grew (still finding signal).
        const rel = prev > 0 ? Math.abs(prev - curr) / prev : 0;
        return { n: cp.n, metric: round4(rel) };
      });
      metricLabel = 'CI 宽度相对衰减率';
      break;
    }
    case 'plateau-height': {
      // For each checkpoint i with i >= windowSize, compute max-min over the
      // last windowSize+1 means. Earlier checkpoints get a Number.POSITIVE
      // sentinel so they can never satisfy the threshold.
      metricSeries = checkpoints.map((cp, i) => {
        if (i < windowSize) return { n: cp.n, metric: Number.POSITIVE_INFINITY };
        const window = checkpoints.slice(i - windowSize, i + 1).map((c) => c.mean);
        const range = Math.max(...window) - Math.min(...window);
        return { n: cp.n, metric: round4(range) };
      });
      metricLabel = 'mean 极差 (最近 K 窗口)';
      break;
    }
  }

  trace.push(...metricSeries);

  // Saturated when the last `windowSize` consecutive metric values are all
  // <= threshold. Walk forward; record the earliest qualifying checkpoint.
  for (let i = windowSize - 1; i < metricSeries.length; i++) {
    let allBelow = true;
    for (let k = 0; k < windowSize; k++) {
      if (metricSeries[i - k].metric > t) { allBelow = false; break; }
    }
    if (allBelow) {
      const atN = metricSeries[i].n;
      return baseShell({
        saturated: true,
        atN,
        reason: `连续 ${windowSize} 个窗口 ${metricLabel} ≤ ${t},于 N=${atN} 判定饱和`,
      });
    }
  }

  return baseShell({
    reason: `${metricLabel} 尚未满足"连续 ${windowSize} 个窗口 ≤ ${t}"`,
  });
}

function defaultThreshold(method: SaturationMethod): number {
  switch (method) {
    case 'slope': return 0.005;
    case 'bootstrap-ci-width': return 0.05;
    case 'plateau-height': return 0.1;
  }
}

/**
 * Build cumulative score arrays from a per-run flat list. `runs[i]` is the
 * array of per-sample scores from the i-th repeat. Returns an array where
 * the j-th entry contains all scores from runs 0..j (concatenated).
 *
 * Use this when feeding `runMultiple` results to `findSaturationPoint`.
 */
export function buildCumulativeScores(runs: number[][]): number[][] {
  const acc: number[] = [];
  const out: number[][] = [];
  for (const r of runs) {
    acc.push(...r);
    out.push([...acc]);
  }
  return out;
}
