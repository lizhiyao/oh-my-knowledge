/**
 * Verdict — turn a finished report into a one-line ship/no-ship recommendation.
 *
 * Why this exists
 * ---------------
 * v0.21 makes the data trustworthy. v0.22 closes the last mile: senior
 * engineers' #1 complaint is "the report has all the right numbers but I
 * still need 30 minutes to read it before I can decide". This module
 * aggregates the four data sources omk already produces — Bootstrap CI on
 * the pairwise diff, three-layer CI gate, saturation curve, and (when
 * available) Krippendorff α against gold — and emits one of four verdicts:
 *
 *  - **PROGRESS**     diff CI shows real positive shift, no layer regressed
 *  - **CAUTIOUS**     positive shift but at least one layer broke its gate,
 *                     or saturation says we're not powered yet
 *  - **REGRESS**      diff CI clearly negative, or a layer dropped a gate
 *  - **NOISE**        diff CI contains 0 — can't separate from noise
 *  - **UNDERPOWERED** N too small / saturation low confidence and no signal
 *  - **SOLO**         single-variant report; nothing to compare against
 *
 * The output is intentionally text-template-driven so the same rule engine
 * powers both `omk bench verdict` (CLI, terse) and the HTML report's
 * top-of-page "verdict pill" (Phase v0.22.2). Both surfaces must agree.
 *
 * Subjectivity caveat: the ship recommendation is rule-based, not statistically
 * proven optimal. Each rule's source (NIST AI 800-3 / Krippendorff thresholds /
 * empirical) is documented inline so users can audit and override.
 */

import type { Report, VariantPairComparison, VariantSummary } from '../types.js';
import { evaluateCiGates } from './ci-gates.js';

export type VerdictLevel =
  | 'PROGRESS'
  | 'CAUTIOUS'
  | 'REGRESS'
  | 'NOISE'
  | 'UNDERPOWERED'
  | 'SOLO';

export interface VerdictResult {
  level: VerdictLevel;
  /** One-line headline shown in CLI / pill. */
  headline: string;
  /** Per-pair verdict if multi-treatment; same shape as level for each. */
  perPair?: Array<{ control: string; treatment: string; level: VerdictLevel; headline: string }>;
  /** Detail bullets shown by `omk bench verdict --verbose`. */
  rationale: {
    significance?: string;
    layerWinners?: string;
    sampleSize?: string;
    judgeAgreement?: string;
    shipRecommendation?: string;
  };
  /** Variants present in the report (best-vs-control framing). */
  variants: string[];
}

export interface VerdictOptions {
  /** Three-layer ci-gate threshold; defaults to 3.5 (matches `omk bench ci`). */
  ciThreshold?: number;
  /**
   * Magnitude (in raw score points) below which a "significant" diff is treated
   * as practically negligible (statistically real but too small to matter).
   * Defaults to 0.1 — about 2% of the 1-5 scale, the floor of practical signal.
   */
  triviallySmallDiff?: number;
}

/**
 * Compute a verdict for a finished report. Pure function — no I/O.
 */
export function computeVerdict(report: Report, options: VerdictOptions = {}): VerdictResult {
  const { ciThreshold = 3.5, triviallySmallDiff = 0.1 } = options;
  const variants = report.meta?.variants ?? [];
  const summary = report.summary ?? {};
  const sampleCount = report.meta?.sampleCount ?? 0;

  if (variants.length < 2) {
    // Single-variant — no comparison possible. Just report whether the variant
    // passes its own three-layer gate.
    const gate = evaluateCiGates(summary, ciThreshold);
    return {
      level: 'SOLO',
      headline: gate.allPass
        ? `SOLO · single variant, three-layer gate PASS @ threshold ${ciThreshold}`
        : `SOLO · single variant, three-layer gate FAIL — see ci output`,
      rationale: {
        layerWinners: gate.lines.join('; '),
        sampleSize: `N=${sampleCount}`,
      },
      variants,
    };
  }

  // Build per-pair verdicts. Convention: variants[0] = control, [1..] = treatments.
  // If --bootstrap wasn't used, pairComparisons is empty — synthesize pseudo-pairs
  // (without CI) so verdictForPair's no-CI path runs and we still get a verdict.
  const explicitPairs = report.meta?.pairComparisons ?? [];
  const pairs: VariantPairComparison[] = explicitPairs.length > 0
    ? explicitPairs
    : variants.slice(1).map((treatment) => ({ control: variants[0], treatment }));
  const perPair = pairs.map((p) => verdictForPair(p, summary, sampleCount, report, ciThreshold, triviallySmallDiff));

  // Worst-case roll-up: REGRESS dominates, then CAUTIOUS, then NOISE/UNDERPOWERED, then PROGRESS.
  const order: VerdictLevel[] = ['REGRESS', 'CAUTIOUS', 'UNDERPOWERED', 'NOISE', 'PROGRESS'];
  let topLevel: VerdictLevel = 'PROGRESS';
  for (const level of order) {
    if (perPair.some((p) => p.level === level)) {
      topLevel = level;
      break;
    }
  }

  // Single representative pair for the top-level rationale (the worst one).
  const representative = perPair.find((p) => p.level === topLevel) ?? perPair[0];

  const significance = representative
    ? formatSignificance(representative)
    : 'no pairwise comparison available — was --bootstrap used?';

  const layerWinners = formatLayerWinners(summary, variants);
  const sampleSize = formatSampleSize(report);
  const judgeAgreement = formatJudgeAgreement(report);
  const shipRecommendation = recommendation(topLevel, perPair);

  return {
    level: topLevel,
    headline: representative
      ? `${topLevel} · ${representative.treatment} vs ${representative.control}: ${representative.headline}`
      : `${topLevel} · ${variants.length} variants`,
    perPair,
    rationale: {
      significance,
      layerWinners,
      sampleSize,
      judgeAgreement,
      shipRecommendation,
    },
    variants,
  };
}

/**
 * Per-pair verdict logic. The hierarchy of checks matters:
 *   1. If a layer regressed past the gate → REGRESS (loudest signal).
 *   2. If diff CI is clearly negative → REGRESS.
 *   3. If diff CI contains 0:
 *      - and N is too small / saturation low confidence → UNDERPOWERED
 *      - otherwise → NOISE
 *   4. If diff CI is positive but trivially small → CAUTIOUS.
 *   5. If diff CI is positive AND treatment passes all gates → PROGRESS.
 *   6. If diff CI is positive but treatment broke a gate → CAUTIOUS.
 */
function verdictForPair(
  pair: VariantPairComparison,
  summary: Record<string, VariantSummary>,
  sampleCount: number,
  report: Report,
  ciThreshold: number,
  triviallySmallDiff: number,
): { control: string; treatment: string; level: VerdictLevel; headline: string } {
  const { control, treatment, diffBootstrapCI: diff } = pair;

  // Layer-gate check: did any layer fall below threshold for either variant?
  const cGate = evaluateCiGates({ [control]: summary[control] }, ciThreshold);
  const tGate = evaluateCiGates({ [treatment]: summary[treatment] }, ciThreshold);

  // No bootstrap CI available → fall back to point-estimate diff comparison.
  if (!diff) {
    const cMean = avgComposite(summary[control]);
    const tMean = avgComposite(summary[treatment]);
    const delta = tMean - cMean;
    const headline = `Δ=${delta >= 0 ? '+' : ''}${delta.toFixed(2)} (no CI; rerun with --bootstrap)`;
    if (Math.abs(delta) < triviallySmallDiff) {
      return { control, treatment, level: 'NOISE', headline };
    }
    return {
      control,
      treatment,
      level: delta > 0 ? 'CAUTIOUS' : 'REGRESS',
      headline,
    };
  }

  const headlineCore = `Δ=${diff.estimate >= 0 ? '+' : ''}${diff.estimate} CI=[${diff.low}, ${diff.high}]`;

  if (!diff.significant) {
    // Diff CI contains 0. Distinguish "underpowered (saturation says: more samples needed)"
    // from "noise (saturation says: we're saturated, the effect just isn't there)".
    const satVerdict = report.variance?.saturation?.verdicts?.[treatment];
    const underpowered =
      sampleCount < 20 ||
      (satVerdict && !satVerdict.saturated && satVerdict.confidence !== 'high');
    if (underpowered) {
      return {
        control,
        treatment,
        level: 'UNDERPOWERED',
        headline: `${headlineCore} · N=${sampleCount} likely too small`,
      };
    }
    return { control, treatment, level: 'NOISE', headline: `${headlineCore} · CI spans 0` };
  }

  // diff is significant.
  if (diff.estimate < 0) {
    return { control, treatment, level: 'REGRESS', headline: `${headlineCore} · treatment loses` };
  }

  // diff > 0 and significant. Did treatment break a gate?
  if (!tGate.allPass) {
    return {
      control,
      treatment,
      level: 'CAUTIOUS',
      headline: `${headlineCore} · gain real, but treatment broke layer gate`,
    };
  }

  // Trivially small diff?
  if (diff.estimate < triviallySmallDiff) {
    return {
      control,
      treatment,
      level: 'CAUTIOUS',
      headline: `${headlineCore} · significant but practically tiny`,
    };
  }

  // Did control break a gate? Then treatment winning isn't surprising — flag.
  if (!cGate.allPass) {
    return {
      control,
      treatment,
      level: 'PROGRESS',
      headline: `${headlineCore} · treatment recovers from broken control`,
    };
  }

  return { control, treatment, level: 'PROGRESS', headline: `${headlineCore} · clean win` };
}

function avgComposite(s: VariantSummary | undefined): number {
  if (!s) return 0;
  if (typeof s.avgCompositeScore === 'number') return s.avgCompositeScore;
  // Fallback: average of the three layers when composite isn't on the summary.
  const layers = [s.avgFactScore, s.avgBehaviorScore, s.avgJudgeScore].filter(
    (x): x is number => typeof x === 'number',
  );
  if (layers.length === 0) return 0;
  return layers.reduce((a, b) => a + b, 0) / layers.length;
}

function formatSignificance(p: { level: VerdictLevel; headline: string }): string {
  return `${p.level} · ${p.headline}`;
}

function formatLayerWinners(summary: Record<string, VariantSummary>, variants: string[]): string {
  if (variants.length < 2) return '—';
  const control = variants[0];
  const treatment = variants[1];
  const c = summary[control];
  const t = summary[treatment];
  if (!c || !t) return '—';
  const layers: Array<[string, number | undefined, number | undefined]> = [
    ['fact', c.avgFactScore, t.avgFactScore],
    ['behavior', c.avgBehaviorScore, t.avgBehaviorScore],
    ['judge', c.avgJudgeScore, t.avgJudgeScore],
  ];
  return layers
    .map(([name, cv, tv]) => {
      if (typeof cv !== 'number' || typeof tv !== 'number') return `${name}=—`;
      const delta = tv - cv;
      const sign = delta >= 0 ? '+' : '';
      return `${name}: ${cv.toFixed(2)}→${tv.toFixed(2)} (${sign}${delta.toFixed(2)})`;
    })
    .join(', ');
}

function formatSampleSize(report: Report): string {
  const n = report.meta?.sampleCount ?? 0;
  const sat = report.variance?.saturation?.verdicts;
  if (!sat) return `N=${n}`;
  const variants = report.meta?.variants ?? [];
  const treatment = variants[1];
  const v = treatment ? sat[treatment] : undefined;
  if (!v) return `N=${n}`;
  if (v.saturated) return `N=${n}, saturated @ N=${v.atN ?? '?'} (${v.confidence} confidence)`;
  return `N=${n}, not yet saturated (${v.confidence} confidence)`;
}

function formatJudgeAgreement(report: Report): string | undefined {
  const a = report.meta?.humanAgreement;
  if (!a) return undefined;
  const verdict = Number.isNaN(a.alpha)
    ? 'undefined'
    : a.alpha >= 0.8 ? 'strong'
    : a.alpha >= 0.667 ? 'acceptable'
    : a.alpha >= 0.4 ? 'weak'
    : 'poor';
  return `α=${Number.isNaN(a.alpha) ? 'NaN' : a.alpha.toFixed(2)} (${verdict}) vs gold ${a.goldAnnotator}`;
}

function recommendation(level: VerdictLevel, perPair: Array<{ level: VerdictLevel }>): string {
  switch (level) {
    case 'PROGRESS':
      return 'SHIP — treatment is significantly better and passes all layer gates.';
    case 'CAUTIOUS':
      return 'INVESTIGATE — the gain is real but at least one warning fired (broken gate, trivially small, or partial recovery). Do not ship blind.';
    case 'REGRESS':
      return 'DO NOT SHIP — treatment regresses. Check the worst layer and re-run with the fix.';
    case 'NOISE':
      return 'NO CALL — diff CI spans 0. The data shows no separable effect at this N.';
    case 'UNDERPOWERED':
      return 'INSUFFICIENT DATA — increase N (try 2× current) and re-run.';
    case 'SOLO':
      return 'ADD A CONTROL — single-variant report. Re-run with --control baseline --treatment <name>.';
  }
}

/**
 * Plain-text formatter for `omk bench verdict <id>`. Stays under 6 lines per the
 * v0.22 spec — one verdict + four rationale bullets + one ship recommendation.
 */
export function formatVerdictText(result: VerdictResult, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${result.level}`);
  lines.push(`  ${result.headline}`);
  if (result.rationale.layerWinners) lines.push(`  Layer winners: ${result.rationale.layerWinners}`);
  if (result.rationale.sampleSize) lines.push(`  Sample size:   ${result.rationale.sampleSize}`);
  if (result.rationale.judgeAgreement) lines.push(`  Judge α:       ${result.rationale.judgeAgreement}`);
  if (result.rationale.shipRecommendation) lines.push(`  ${result.rationale.shipRecommendation}`);
  if (options.verbose && result.perPair && result.perPair.length > 1) {
    lines.push('');
    lines.push('  Per-pair detail:');
    for (const p of result.perPair) {
      lines.push(`    ${p.level}: ${p.treatment} vs ${p.control} — ${p.headline}`);
    }
  }
  return lines.join('\n');
}
