/**
 * Verdict — turn a finished report into a one-line ship/no-ship recommendation.
 *
 * Why this exists
 * ---------------
 * v0.21 makes the data trustworthy.  closes the last mile: senior
 * engineers' #1 complaint is "the report has all the right numbers but I
 * still need 30 minutes to read it before I can decide". This module
 * aggregates the data sources omk already produces — Bootstrap CI on the
 * pairwise diff, three-layer CI gate, saturation curve, inter-judge ensemble
 * agreement, and (when available) Krippendorff α against gold — and emits one
 * of six verdicts:
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
 * powers both `omk eval` (CLI, terse) and the HTML report's
 * top-of-page "verdict pill" ("verdict pill" surface). Both surfaces must agree.
 *
 * Subjectivity caveat: the ship recommendation is rule-based, not statistically
 * proven optimal. Each rule's source (NIST AI 800-3 / Krippendorff thresholds /
 * empirical) is documented inline so users can audit and override.
 */

import type { GapReport, Lang, Report, VariantPairComparison, VariantSummary } from '../types/index.js';
import { evaluateLayerGates } from './layer-gates.js';
import { ciLevelLabel } from './bootstrap.js';
import { analyzeJudgeIndependence } from './judge-independence.js';
import { MIN_HOLDOUT_SUBSET } from './holdout.js';
import { shellQuoteArg } from '../shared/shell-quote.js';

/**
 * Below this sample count a non-significant diff is read as UNDERPOWERED
 * (only large effects are detectable) rather than NOISE. Matches the
 * pre-flight power band documented in `docs/specs/sample-design-spec.md`;
 * guarded by `test/scripts/doc-constants-drift.test.ts`.
 */
export const UNDERPOWERED_MIN_SAMPLES = 20;

/**
 * Inter-judge Pearson bands, shared with the report's ensemble-agreement audit
 * badge (`src/renderer/summary.ts`) so the verdict gate and the UI read one scale.
 *  - `>= ENSEMBLE_STRONG_PEARSON` (0.7): judges agree on rank order (badge green).
 *  - `< ENSEMBLE_DISSENT_PEARSON` (0.4): strong disagreement (badge red). A
 *    would-be PROGRESS is downgraded to CAUTIOUS — the judge-layer signal driving
 *    the win is unreliable when the ensemble can't agree.
 */
export const ENSEMBLE_STRONG_PEARSON = 0.7;
export const ENSEMBLE_DISSENT_PEARSON = 0.4;

/**
 * Run-to-run instability threshold on the median coefficient of variation (CV = stddev/mean).
 * Once stability is **actually measured** (`--repeat ≥ 2`) and the median CV exceeds this line,
 * a would-be PROGRESS is downgraded to CAUTIOUS — a statistically significant but run-to-run
 * irreproducible "gain" is not shippable. It is the upper bound of the 5/15% stability bands in
 * `docs/specs/terminology-spec.md` §5; doc ↔ code parity is guarded by
 * `test/scripts/doc-constants-drift.test.ts`. Single-run reports (stability not measured) are
 * never gated by it — see `computeVerdict`.
 */
export const STABILITY_UNSTABLE_CV = 0.15;

/**
 * Per-layer pass/fail line for the three-layer gate, on the 1-5 scale.
 * **Pragmatic default, not derived from an external standard**: 3.5 is a clear margin
 * above the 3.0 scale midpoint ("basically acceptable"), so a layer must land
 * comfortably in the upper half to pass. Overridable via `omk eval --threshold`.
 * doc ↔ code parity guarded by `test/scripts/doc-constants-drift.test.ts`.
 */
export const DEFAULT_GATE_THRESHOLD = 3.5;

/**
 * Train − holdout composite gap (1-5 scale) above which `omk eval --holdout-ratio`
 * is read as **sample-set overfitting**: the gain lives on the samples the skill
 * was shaped around and does not carry to the held-out slice. Like the stability
 * gate, a would-be PROGRESS is then downgraded to CAUTIOUS — a win that does not
 * generalize is not shippable.
 * **Pragmatic default, not from an external standard**: 0.5 is 10% of the 1-5 scale
 * — small enough to catch a real generalization drop, wide enough to ignore the
 * sampling noise of a small holdout slice. Only fires when a holdout split is
 * present (opt-in), so it never moves a default report's verdict.
 * doc ↔ code parity guarded by `test/scripts/doc-constants-drift.test.ts`.
 */
export const OVERFITTING_GAP_THRESHOLD = 0.5;

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
  /** Detail bullets shown by `omk eval` verbose output. */
  rationale: {
    significance?: string;
    layerWinners?: string;
    sampleSize?: string;
    /** Stability claim:CV / variance summary if --repeat ≥ 2, 否则显式说"未测量"
     *  让用户感受到 single-run 的盲区,而不是默默不提。 */
    stability?: string;
    judgeAgreement?: string;
    /** Overfitting (train vs holdout) caveat — only present under `--holdout-ratio`. */
    overfitting?: string;
    /** Knowledge-gap caveat — informational, watermarked, never gates (gap-spec §8). */
    gapSignal?: string;
    shipRecommendation?: string;
  };
  /** The pair the top-level verdict is about — the worst pair from the roll-up, NOT
   *  variants[1]. Surfaces let the HTML pill name the right treatment in a
   *  control-vs-many report instead of re-deriving from the first pair. Undefined for
   *  SOLO / pairless reports. */
  representative?: { control: string; treatment: string };
  /** Structured caveats (language-neutral) so HTML / other surfaces can i18n them
   *  instead of re-parsing the zh `rationale` strings. Present only when the caveat
   *  fires; mirrors `rationale.overfitting` / `rationale.gapSignal`. */
  caveats?: {
    overfitting?: { variant: string; trainScore: number; holdoutScore: number; gap: number };
    gapSignal?: { variant: string; gapRatePct: number; testSetPath?: string | null; testSetHash?: string | null };
  };
  /** Variants present in the report (best-vs-control framing). */
  variants: string[];
}

export interface VerdictOptions {
  /** Three-layer ci-gate threshold; defaults to DEFAULT_GATE_THRESHOLD (matches `omk eval`). */
  gateThreshold?: number;
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
  const { gateThreshold = DEFAULT_GATE_THRESHOLD, triviallySmallDiff = 0.1 } = options;
  const variants = report.meta?.variants ?? [];
  const summary = report.summary ?? {};
  const sampleCount = report.meta?.sampleCount ?? 0;

  if (variants.length < 2) {
    // Single-variant — no comparison possible. Just report whether the variant
    // passes its own three-layer gate.
    const gate = evaluateLayerGates(summary, gateThreshold);
    // SOLO 只有绝对分、无 A/B 差值可抵消自我偏好,故同厂商评委的 caveat 更该出。
    const judgeInd = judgeIndependenceCaveat(report);
    // 过拟合 / gap 在 SOLO 也有意义(单变体是否泛化 / 缺口多大),但 SOLO 无 PROGRESS 可降,只附提示不门控。
    const overfit = overfittingCaveat(report);
    const gap = gapSignalCaveat(report);
    return {
      level: 'SOLO',
      headline: (gate.allPass
        ? `SOLO · single variant, three-layer gate PASS @ threshold ${gateThreshold}`
        : `SOLO · single variant, three-layer gate FAIL — see ci output`) + judgeInd.note + overfit.note + gap.note,
      rationale: {
        layerWinners: gate.lines.join('; '),
        sampleSize: `N=${sampleCount}`,
        stability: formatStability(report),
        ...(judgeInd.rationale ? { judgeAgreement: judgeInd.rationale } : {}),
        ...(overfit.rationale ? { overfitting: overfit.rationale } : {}),
        ...(gap.rationale ? { gapSignal: gap.rationale } : {}),
        shipRecommendation: recommendation('SOLO', []),
      },
      ...((overfit.data || gap.data) ? {
        caveats: {
          ...(overfit.data ? { overfitting: overfit.data } : {}),
          ...(gap.data ? { gapSignal: gap.data } : {}),
        },
      } : {}),
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
  const perPair = pairs.map((p) => verdictForPair(p, summary, sampleCount, report, gateThreshold, triviallySmallDiff));

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

  // 稳定性门控(报告级,非 per-pair):仅当**已测**(runs≥2)且 run-to-run 不稳(median CV > STABILITY_UNSTABLE_CV)
  // 时,把 PROGRESS 降为 CAUTIOUS —— 显著但跨轮不可复现的"进展"不可 ship。单轮(未测稳定性)不门控:rationale
  // 已诚实标"未测量"(terminology-spec §5「诚实交代测不到的东西」),默认单轮全降级会过激。只压 PROGRESS:已是 CAUTIOUS/REGRESS 等
  // 不再加码,顺序与 worst-case roll-up 一致。
  const stab = medianStabilityCV(report);
  const stabilityGated = topLevel === 'PROGRESS' && stab !== null && stab.cv > STABILITY_UNSTABLE_CV;
  // 过拟合门控:与稳定性门控同形——opt-in holdout 下 train/holdout 分差过大 → PROGRESS 降 CAUTIOUS。
  // overfittingCaveat 首行短路无 holdout 的报告,故默认报告 level 与 headline 逐字节不变。
  const overfit = overfittingCaveat(report);
  const overfitGated = topLevel === 'PROGRESS' && overfit.gated;
  const level: VerdictLevel = (stabilityGated || overfitGated) ? 'CAUTIOUS' : topLevel;
  const stabilityNote = stabilityGated && stab
    ? ` · 显著但 run-to-run 不稳(CV=${(stab.cv * 100).toFixed(1)}% > ${(STABILITY_UNSTABLE_CV * 100).toFixed(0)}%)`
    : '';
  const judgeInd = judgeIndependenceCaveat(report);
  // gap 软提示:不改 level(spec §8),低缺口 / 无 gapReports 时空串,headline 逐字节不变。
  const gap = gapSignalCaveat(report);

  const significance = representative
    ? formatSignificance(representative)
    : 'no pairwise comparison available — was --bootstrap used?';

  const layerWinners = formatLayerWinners(summary, variants);
  const sampleSize = formatSampleSize(report);
  const stability = formatStability(report);
  const judgeAgreement = [formatJudgeAgreement(report), judgeInd.rationale].filter(Boolean).join(' · ') || undefined;
  const shipRecommendation = recommendation(level, perPair);

  return {
    level,
    headline: representative
      ? `${level} · ${representative.treatment} vs ${representative.control}: ${representative.headline}${stabilityNote}${judgeInd.note}${overfit.note}${gap.note}`
      : `${level} · ${variants.length} variants`,
    perPair,
    rationale: {
      significance,
      layerWinners,
      sampleSize,
      stability,
      judgeAgreement,
      ...(overfit.rationale ? { overfitting: overfit.rationale } : {}),
      ...(gap.rationale ? { gapSignal: gap.rationale } : {}),
      shipRecommendation,
    },
    ...(representative ? { representative: { control: representative.control, treatment: representative.treatment } } : {}),
    ...((overfit.data || gap.data) ? {
      caveats: {
        ...(overfit.data ? { overfitting: overfit.data } : {}),
        ...(gap.data ? { gapSignal: gap.data } : {}),
      },
    } : {}),
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
  gateThreshold: number,
  triviallySmallDiff: number,
): { control: string; treatment: string; level: VerdictLevel; headline: string } {
  const { control, treatment, diffBootstrapCI: diff } = pair;

  // Layer-gate check: did any layer fall below threshold for either variant?
  const cGate = evaluateLayerGates({ [control]: summary[control] }, gateThreshold);
  const tGate = evaluateLayerGates({ [treatment]: summary[treatment] }, gateThreshold);

  // No bootstrap CI available → fall back to point-estimate diff comparison. 这是 `--no-bootstrap` 的**降级
  // 模式**:bootstrap 默认开,正常路径永远有 CI,这里只在用户显式关掉时触达。降级路径刻意不对称——正 Δ 最多给
  // CAUTIOUS(没 CI 不敢判 PROGRESS),负 Δ 直接 REGRESS(不做显著性检验)。这对"检测变差"是保守安全方向(宁可
  // 误报回归也别漏掉),代价是把噪声级的负 Δ 也叫 REGRESS;要严谨结论就别关 bootstrap。
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

  // 多重比较把本对的 α 收到 α/K → CI 变宽,标签随 α 走(与 HTML pairwise 表同口径);K=1(无 alpha)不加标签,
  // headline 与历史逐字节一致。让 omk eval CLI 也诚实显示真实置信水平,而非裸区间。
  const ciLabel = pair.alpha != null ? `${ciLevelLabel(pair.alpha)} ` : '';
  const headlineCore = `Δ=${diff.estimate >= 0 ? '+' : ''}${diff.estimate} ${ciLabel}CI=[${diff.low}, ${diff.high}]`;

  if (!diff.significant) {
    // Diff CI contains 0. Distinguish "underpowered (saturation says: more samples needed)"
    // from "noise (saturation says: we're saturated, the effect just isn't there)".
    const satVerdict = report.variance?.saturation?.verdicts?.[treatment];
    const underpowered =
      sampleCount < UNDERPOWERED_MIN_SAMPLES ||
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

  // Ensemble dissent gate: a real, gate-passing gain is only PROGRESS if the
  // judges that produced it actually agree. When inter-judge Pearson sits in the
  // badge's red band (< ENSEMBLE_DISSENT_PEARSON) for either compared variant,
  // the judge-layer signal behind the win is unreliable → downgrade to CAUTIOUS.
  const dissent = ensembleDissent(pair, summary);
  if (dissent) {
    return {
      control,
      treatment,
      level: 'CAUTIOUS',
      headline: `${headlineCore} · gain real, but judges disagree on ${dissent.variant} (Pearson ${dissent.pearson} < ${ENSEMBLE_DISSENT_PEARSON})`,
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

/**
 * Strong inter-judge disagreement on the compared pair, if any. Reuses the
 * persisted per-variant ensemble Pearson (`summary[v].judgeAgreement.pearson`).
 * Returns the worst offender below the dissent threshold, or null when every
 * variant agrees / has no ensemble signal (single- or constant-score judge ⇒
 * pearson undefined, nothing to act on — its disagreement, if any, still shows
 * in the report's MAD column).
 */
function ensembleDissent(
  pair: { control: string; treatment: string },
  summary: Record<string, VariantSummary>,
): { variant: string; pearson: number } | null {
  let worst: { variant: string; pearson: number } | null = null;
  for (const variant of [pair.treatment, pair.control]) {
    const pearson = summary[variant]?.judgeAgreement?.pearson;
    if (pearson != null && pearson < ENSEMBLE_DISSENT_PEARSON) {
      if (!worst || pearson < worst.pearson) worst = { variant, pearson };
    }
  }
  return worst;
}

function avgComposite(s: VariantSummary | undefined): number {
  if (!s) return 0;
  if (typeof s.avgCompositeScore === 'number') return s.avgCompositeScore;
  // 兜底:summary 无 avgCompositeScore 时,用三层均值近似。**有偏**:真 composite 是 per-sample
  // (present-layers 均值)再跨 sample 平均;这里是「跨 sample 的层均值」再跨层平均,各层在不同 sample 上缺失
  // 不均时两者不等(Jensen / 分母不一致)。仅 no-bootstrap 降级路径 + summary 缺 composite 的老报告才触达
  // (默认开 bootstrap、新报告必带 avgCompositeScore,故极罕见),不值得回填 per-sample 重算 —— 标注保留近似。
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

/**
 * Stability rationale. 三种状态:
 *   - --repeat ≥ 2 + 有 variance 数据: 报告 CV (variation coefficient) 主指标
 *   - --repeat ≥ 2 但 variance 缺失: 异常,标 "—" 提示数据丢失
 *   - --repeat < 2: 显式说"未测量,需 --repeat ≥ 2",而不是默默不提
 *
 * 单轮场景关键:不是"稳定 = 100%"(常见误读),而是"测不到稳定性"。
 * Verdict 必须诚实交代这个盲区,不能让用户以为没说就是 OK。
 */
/**
 * 跨轮稳定性的中位 CV(variation coefficient = stddev/mean)。仅在**已测**(runs≥2)且 variance 数据齐时
 * 返回 { runs, cv },否则 null(单轮未测 / variance 缺失 / CV 全算不出 → 不参与门控)。formatStability 的
 * 文字、computeVerdict 的稳定性门控、renderer 的 hero CV chip 共用这一处计算,口径一致、绝不漂移。
 * **真·中位**:偶数个 variant 取中间两项的平均(不是上中位)—— 最常见的 A/B 报告恰好是两个 variant,取上中位
 * 会退化成"较大的那个 CV",把门控口径从「中位」悄悄变成「max」、直接改变 ship/no-ship(复审 P2)。
 */
export function medianStabilityCV(report: Report): { runs: number; cv: number } | null {
  const runs = report.variance?.runs ?? report.meta?.request?.repeat ?? 1;
  if (runs < 2) return null;
  const variance = report.variance?.perVariant;
  if (!variance || Object.keys(variance).length === 0) return null;
  const cvs: number[] = [];
  for (const v of Object.values(variance)) {
    if (typeof v.stddev === 'number' && typeof v.mean === 'number' && v.mean > 0) {
      cvs.push(v.stddev / v.mean);
    }
  }
  if (cvs.length === 0) return null;
  cvs.sort((a, b) => a - b);
  const mid = Math.floor(cvs.length / 2);
  const median = cvs.length % 2 === 0 ? (cvs[mid - 1] + cvs[mid]) / 2 : cvs[mid];
  return { runs, cv: median };
}

function formatStability(report: Report): string {
  const runs = report.variance?.runs ?? report.meta?.request?.repeat ?? 1;
  if (runs < 2) {
    return '稳定性未测量(单轮评测,需 --repeat ≥ 2 才能测 CV)';
  }
  const variance = report.variance?.perVariant;
  if (!variance || Object.keys(variance).length === 0) {
    return `runs=${runs} 但 variance 数据缺失`;
  }
  const stab = medianStabilityCV(report);
  if (!stab) return `runs=${runs}, CV 计算失败(stddev/mean 数据缺失)`;
  const cvPct = (stab.cv * 100).toFixed(1);
  // 阈值参考 terminology-spec §5:<5% 稳 / 5-15% 中 / >15% 不稳。不稳上界 = STABILITY_UNSTABLE_CV,
  // 与门控同一根线:label 判"不稳" ⟺ 门控触发(cv > STABILITY_UNSTABLE_CV)。
  const verdict = stab.cv < 0.05 ? '稳定' : stab.cv <= STABILITY_UNSTABLE_CV ? '中等' : '不稳';
  return `CV=${cvPct}% (${verdict}, runs=${runs}; 阈值 <5%=稳/5-15%=中/>15%=不稳)`;
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

/**
 * 评委独立性 caveat(自我偏好 J1 / 单厂商 ensemble J2)。返回 { note, rationale }:
 *   note      —— 追到 headline 的短提示(仅未 gold 校准时出,提醒读者敞口);
 *   rationale —— 并进 rationale.judgeAgreement 的可执行说明(指向跨厂商评委 / gold)。
 * **不改 verdict level**:omk 固定模型,自我偏好对 baseline / treatment 两臂同等加成、在 verdict
 * 在意的 A/B 差值里大幅抵消,不该翻 ship/no-ship;真正受影响的是绝对分 / 版本曲线 / 跨模型比较。
 */
function judgeIndependenceCaveat(report: Report): { note: string; rationale?: string } {
  const ind = analyzeJudgeIndependence(report);
  const reasons: string[] = [];
  if (ind.sameVendorJudge) reasons.push(`评委与被测输出同厂商(${ind.outputVendors.join('/')})`);
  if (ind.singleVendorEnsemble) reasons.push(`${ind.judgeVendors.length} 个评委同厂商，ensemble 一致性不反驳同模型偏置`);
  if (reasons.length === 0) return { note: '' };

  if (ind.goldCalibrated) {
    // 有 gold 校准背板 → 不进 headline,只软提示。
    return { note: '', rationale: `自我偏好敞口（${reasons.join('；')}）已有 gold 校准背板` };
  }
  return {
    note: ' · 评委自我偏好敞口未校准',
    rationale: `${reasons.join('；')} —— 绝对分可能偏高；换跨厂商评委(--judge-models)或挂 gold(omk eval gold compare)校准`,
  };
}

/**
 * Overfitting caveat from the opt-in train/holdout breakdown (`--holdout-ratio`).
 * `gated` drives a PROGRESS → CAUTIOUS downgrade (a win that does not carry to the
 * held-out slice is not shippable), mirroring the stability gate. **First line
 * short-circuits when there is no holdout split**, so default reports (no
 * `analysis.holdout`) are byte-identical — the gate only ever fires when the user
 * opted into a holdout, which is brand-new behaviour with no historical reports.
 */
/**
 * The treatment variants a report-level caveat should scan. control = variants[0];
 * treatments = the rest. For a single-variant (SOLO) report there is no control,
 * so the lone variant is itself the subject. Scanning **all** treatments (not just
 * variants[1]) keeps the caveats aligned with the verdict's worst-case roll-up over
 * `perPair` — a control-vs-many report must not miss the 2nd/3rd treatment.
 */
function treatmentVariants(report: Report): string[] {
  const variants = report.meta?.variants ?? [];
  return variants.length >= 2 ? variants.slice(1) : variants.slice(0, 1);
}

function overfittingCaveat(report: Report): {
  note: string;
  rationale?: string;
  gated: boolean;
  data?: { variant: string; trainScore: number; holdoutScore: number; gap: number };
} {
  const holdout = report.analysis?.holdout;
  if (!holdout || holdout.disabled) return { note: '', gated: false };
  // Worst-case over all treatments — matches the verdict roll-up. A PROGRESS top-level
  // means every pair passed, so a single overfitting treatment must still downgrade it.
  let worst: { variant: string; train: number; holdout: number; gap: number } | null = null;
  for (const t of treatmentVariants(report)) {
    const pv = holdout.perVariant[t];
    if (!pv) continue;
    // 门控绑「实际可评分条目数」,不是 authored 切分数:某侧 3 条里只有 1 条真出分(其余
    // error / budget-abort)时,分差只有 1 个样本支撑,把它包装成「3 条结论」会误判过拟合。
    // 两侧 scorable 都 ≥ MIN_HOLDOUT_SUBSET 才信。这也顺带挡掉 score=0(scorable=0)的测量假象。
    if (pv.trainScorable < MIN_HOLDOUT_SUBSET || pv.holdoutScorable < MIN_HOLDOUT_SUBSET) continue;
    const gap = pv.trainScore - pv.holdoutScore;
    if (gap <= OVERFITTING_GAP_THRESHOLD) continue;
    if (!worst || gap > worst.gap) worst = { variant: t, train: pv.trainScore, holdout: pv.holdoutScore, gap };
  }
  if (!worst) return { note: '', gated: false };
  return {
    note: ` · 过拟合敞口(${worst.variant}: train ${worst.train.toFixed(2)} − holdout ${worst.holdout.toFixed(2)} = ${worst.gap.toFixed(2)} > ${OVERFITTING_GAP_THRESHOLD})`,
    rationale: `${worst.variant} train/holdout 综合分差 ${worst.gap.toFixed(2)} 超阈值 ${OVERFITTING_GAP_THRESHOLD}(holdout ratio ${holdout.ratio}）—— 提升可能是对用例集过拟合、对 holdout 不泛化；扩充用例集或换独立外验集复核`,
    gated: true,
    data: { variant: worst.variant, trainScore: worst.train, holdoutScore: worst.holdout, gap: worst.gap },
  };
}

/**
 * Knowledge-gap rate above which the verdict appends an **informational** caveat.
 * Internal-only, deliberately NOT exported: gap rate is informational, never a
 * gate (knowledge-gap-signal-spec.md §8), so exposing this as a tunable constant
 * would invite reading it as a pass/fail line.
 */
const GAP_CAVEAT_BAND = 0.2;

/**
 * Knowledge-gap caveat (`report.analysis.gapReports`). **Soft only — never changes
 * the verdict level** (spec §8: a nudge, not a fail). Surfaces the treatment's gap
 * rate with its mandatory test-set watermark (spec §7.1: a gap number without a
 * watermark is invalid output) plus the "informational, not completeness" framing.
 * Empty note below the band, so the common low-gap case keeps verdict headlines
 * byte-identical.
 */
function gapSignalCaveat(report: Report): {
  note: string;
  rationale?: string;
  data?: { variant: string; gapRatePct: number; testSetPath?: string | null; testSetHash?: string | null };
} {
  const gapReports = report.analysis?.gapReports;
  if (!gapReports) return { note: '' };
  // Worst-case (highest gap rate) over all treatments — a control-vs-many report must
  // surface the noisiest treatment, not just variants[1]. spec §7.1: gap 数必须带
  // test-set 水印,否则视为无效输出 —— 无水印的条目不参与(而非吐裸缺口率)。生产报告
  // 恒带水印(report-finalize 强制),此处只防手搓 / 退化报告。
  let gr: GapReport | null = null;
  for (const t of treatmentVariants(report)) {
    const cand = gapReports[t];
    if (!cand || cand.gapRate < GAP_CAVEAT_BAND) continue;
    if (!cand.testSetPath && !cand.testSetHash) continue;
    if (!gr || cand.gapRate > gr.gapRate) gr = cand;
  }
  if (!gr) return { note: '' };
  const pct = (gr.gapRate * 100).toFixed(0);
  const shortHash = gr.testSetHash ? gr.testSetHash.slice(0, 8) : '';
  const tag = shortHash || gr.testSetPath;
  const watermark = gr.testSetPath
    ? `${gr.testSetPath}${shortHash ? ` @ ${shortHash}` : ''}`
    : shortHash;
  return {
    note: ` · 知识缺口率 ${pct}% @ ${tag}`,
    rationale: `知识缺口率 ${pct}%(test set: ${watermark}，N=${gr.sampleCount}）—— informational，反映当前用例集与知识库的交互、非完备性度量；高缺口提示扩充知识库或复核未覆盖文件`,
    data: { variant: gr.variant, gapRatePct: Number(pct), testSetPath: gr.testSetPath, testSetHash: gr.testSetHash },
  };
}

function recommendation(level: VerdictLevel, _perPair: Array<{ level: VerdictLevel }>, lang: Lang = 'en'): string {
  if (lang === 'zh') {
    switch (level) {
      case 'PROGRESS':
        return '可发布 —— 实验组显著更优，且通过所有分层门控。';
      case 'CAUTIOUS':
        return '需排查 —— 提升是真的，但至少触发了一条告警（门控破损 / 提升微不足道 / 仅部分恢复 / 评委分歧 / 跨轮不稳 / 训练-留出过拟合）。不要盲发。';
      case 'REGRESS':
        return '勿发布 —— 实验组退步。检查最差的那一层，修好再重跑。';
      case 'NOISE':
        return '不下结论 —— 差异置信区间跨过 0，当前 N 下分辨不出效果。';
      case 'UNDERPOWERED':
        return '数据不足 —— 增加用例数（建议 2× 当前）后重跑。';
      case 'SOLO':
        return '缺对照 —— 单变体报告。用 --control baseline --treatment <名字> 重跑。';
    }
  }
  switch (level) {
    case 'PROGRESS':
      return 'SHIP — treatment is significantly better and passes all layer gates.';
    case 'CAUTIOUS':
      return 'INVESTIGATE — the gain is real but at least one warning fired (broken gate, trivially small, partial recovery, judge dissent, run-to-run unstable, or train/holdout overfitting). Do not ship blind.';
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

function nextStepTreatmentName(result: Pick<VerdictResult, 'level' | 'representative' | 'variants'>): string {
  if (result.representative?.treatment) return result.representative.treatment;
  if (result.level === 'SOLO') return result.variants[0] ?? '<name>';
  return result.variants[1] ?? '<name>';
}

function releaseNextStep(result: Pick<VerdictResult, 'level' | 'representative' | 'variants'>, lang: Lang): string {
  const treatment = nextStepTreatmentName(result);
  const treatmentArg = shellQuoteArg(treatment);
  if (lang === 'zh') {
    switch (result.level) {
      case 'PROGRESS':
        return `可以发布：按你的正常发布流程发布，并留存本次报告作为发布证据；如果这是受管 skill，继续运行 \`omk promote ${treatmentArg}\` 记录接受决定。`;
      case 'CAUTIOUS':
        return '不要直接发布；先看触发的告警（分层门控、评委分歧、稳定性或 holdout），修完再重跑。';
      case 'REGRESS':
        return '不要发布；定位最差层和失败用例，修复后重跑。';
      case 'NOISE':
        return '先别发布；增加样本数或提高用例区分度，再重跑。';
      case 'UNDERPOWERED':
        return '把样本数加到至少 20，或先按当前规模 2× 扩充后重跑。';
      case 'SOLO':
        return `补一个 baseline 对照，再跑 \`omk eval --control baseline --treatment ${treatmentArg}\`。`;
    }
  }
  switch (result.level) {
    case 'PROGRESS':
      return `ship through your normal release path and keep this report as release evidence; for a managed skill, run \`omk promote ${treatmentArg}\` to record acceptance.`;
    case 'CAUTIOUS':
      return 'do not ship directly; inspect the warnings (layer gates, judge dissent, stability, or holdout), fix them, then re-run.';
    case 'REGRESS':
      return 'do not ship; inspect the weakest layer and failing samples, fix them, then re-run.';
    case 'NOISE':
      return 'do not ship yet; add samples or sharpen the test set, then re-run.';
    case 'UNDERPOWERED':
      return 'increase the sample set to at least 20, or roughly 2x the current size, then re-run.';
    case 'SOLO':
      return `add a baseline control and re-run \`omk eval --control baseline --treatment ${treatmentArg}\`.`;
  }
}

/**
 * Plain-text formatter for the `omk eval` verdict. Stays terse for the
 *  spec — one verdict, rationale bullets, one ship recommendation, and one next step.
 */
export function formatVerdictText(result: VerdictResult, options: { verbose?: boolean; lang?: Lang } = {}): string {
  // lang 默认 'en':保留既有英文输出逐字节不变(verdict.test 与历史 CLI 行为)。zh 只本地化
  //  标签与 ship 建议;headline 是 Δ/CI/N 统计记号 —— 跨语言中性、且会随 report 持久化,
  //  不翻译(翻它=改可比性锚点)。recommendation 在 format 时按 lang 重新派生,不动 computeVerdict。
  const zh = options.lang === 'zh';
  const lines: string[] = [];
  lines.push(zh ? `判定：${result.level}` : `Verdict: ${result.level}`);
  lines.push(`  ${result.headline}`);
  if (result.rationale.layerWinners) lines.push(zh ? `  分层优胜：${result.rationale.layerWinners}` : `  Layer winners: ${result.rationale.layerWinners}`);
  if (result.rationale.sampleSize) lines.push(zh ? `  用例规模：${result.rationale.sampleSize}` : `  Sample size:   ${result.rationale.sampleSize}`);
  if (result.rationale.stability) lines.push(zh ? `  跨轮稳定：${result.rationale.stability}` : `  Stability:     ${result.rationale.stability}`);
  if (result.rationale.judgeAgreement) lines.push(zh ? `  评委 α：${result.rationale.judgeAgreement}` : `  Judge α:       ${result.rationale.judgeAgreement}`);
  if (result.rationale.overfitting) lines.push(zh ? `  过拟合：${result.rationale.overfitting}` : `  Overfitting:   ${result.rationale.overfitting}`);
  if (result.rationale.gapSignal) lines.push(zh ? `  知识缺口：${result.rationale.gapSignal}` : `  Gap signal:    ${result.rationale.gapSignal}`);
  if (result.rationale.shipRecommendation) {
    lines.push(`  ${zh ? recommendation(result.level, [], 'zh') : result.rationale.shipRecommendation}`);
    lines.push(zh ? `  下一步：${releaseNextStep(result, 'zh')}` : `  Next: ${releaseNextStep(result, 'en')}`);
  }
  if (options.verbose && result.perPair && result.perPair.length > 1) {
    lines.push('');
    lines.push(zh ? '  逐对明细：' : '  Per-pair detail:');
    for (const p of result.perPair) {
      lines.push(`    ${p.level}: ${p.treatment} vs ${p.control} — ${p.headline}`);
    }
  }
  return lines.join('\n');
}
