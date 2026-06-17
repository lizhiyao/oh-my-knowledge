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

import type { Report, VariantPairComparison, VariantSummary } from '../types/index.js';
import { evaluateLayerGates } from './layer-gates.js';
import { ciLevelLabel } from './bootstrap.js';
import { analyzeJudgeIndependence } from './judge-independence.js';

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
    shipRecommendation?: string;
  };
  /** Variants present in the report (best-vs-control framing). */
  variants: string[];
}

export interface VerdictOptions {
  /** Three-layer ci-gate threshold; defaults to 3.5 (matches `omk eval`). */
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
  const { gateThreshold = 3.5, triviallySmallDiff = 0.1 } = options;
  const variants = report.meta?.variants ?? [];
  const summary = report.summary ?? {};
  const sampleCount = report.meta?.sampleCount ?? 0;

  if (variants.length < 2) {
    // Single-variant — no comparison possible. Just report whether the variant
    // passes its own three-layer gate.
    const gate = evaluateLayerGates(summary, gateThreshold);
    // SOLO 只有绝对分、无 A/B 差值可抵消自我偏好,故同厂商评委的 caveat 更该出。
    const judgeInd = judgeIndependenceCaveat(report);
    return {
      level: 'SOLO',
      headline: (gate.allPass
        ? `SOLO · single variant, three-layer gate PASS @ threshold ${gateThreshold}`
        : `SOLO · single variant, three-layer gate FAIL — see ci output`) + judgeInd.note,
      rationale: {
        layerWinners: gate.lines.join('; '),
        sampleSize: `N=${sampleCount}`,
        stability: formatStability(report),
        ...(judgeInd.rationale ? { judgeAgreement: judgeInd.rationale } : {}),
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
  const level: VerdictLevel = stabilityGated ? 'CAUTIOUS' : topLevel;
  const stabilityNote = stabilityGated && stab
    ? ` · 显著但 run-to-run 不稳(CV=${(stab.cv * 100).toFixed(1)}% > ${(STABILITY_UNSTABLE_CV * 100).toFixed(0)}%)`
    : '';
  const judgeInd = judgeIndependenceCaveat(report);

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
      ? `${level} · ${representative.treatment} vs ${representative.control}: ${representative.headline}${stabilityNote}${judgeInd.note}`
      : `${level} · ${variants.length} variants`,
    perPair,
    rationale: {
      significance,
      layerWinners,
      sampleSize,
      stability,
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
  if (ind.singleVendorEnsemble) reasons.push(`${ind.judgeVendors.length} 个评委同厂商,ensemble 一致性不反驳同模型偏置`);
  if (reasons.length === 0) return { note: '' };

  if (ind.goldCalibrated) {
    // 有 gold 校准背板 → 不进 headline,只软提示。
    return { note: '', rationale: `自我偏好敞口(${reasons.join(';')})已有 gold 校准背板` };
  }
  return {
    note: ' · 评委自我偏好敞口未校准',
    rationale: `${reasons.join(';')} —— 绝对分可能偏高;换跨厂商评委(--judge-models)或挂 gold(omk eval gold compare)校准`,
  };
}

function recommendation(level: VerdictLevel, _perPair: Array<{ level: VerdictLevel }>): string {
  switch (level) {
    case 'PROGRESS':
      return 'SHIP — treatment is significantly better and passes all layer gates.';
    case 'CAUTIOUS':
      return 'INVESTIGATE — the gain is real but at least one warning fired (broken gate, trivially small, partial recovery, judge dissent, or run-to-run unstable). Do not ship blind.';
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
 * Plain-text formatter for the `omk eval` verdict. Stays under 6 lines per the
 *  spec — one verdict + four rationale bullets + one ship recommendation.
 */
export function formatVerdictText(result: VerdictResult, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`Verdict: ${result.level}`);
  lines.push(`  ${result.headline}`);
  if (result.rationale.layerWinners) lines.push(`  Layer winners: ${result.rationale.layerWinners}`);
  if (result.rationale.sampleSize) lines.push(`  Sample size:   ${result.rationale.sampleSize}`);
  if (result.rationale.stability) lines.push(`  Stability:     ${result.rationale.stability}`);
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
