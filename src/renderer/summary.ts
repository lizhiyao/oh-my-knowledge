import { e, fmtNum, fmtCost, fmtDuration, COLORS, t } from './layout.js';
import { generateAnalysisSummary } from '../analysis/report-diagnostics.js';
import { pValueCategory } from '../eval-core/statistics.js';
import { computeVerdict, type VerdictLevel, type VerdictResult } from '../eval-core/verdict.js';
import type { GapReport, GapSignalRef, Insight, KnowledgeCoverage, Lang, Report, ReportHumanAgreement, SaturationData, VarianceComparison, VarianceComparisonMetric, VarianceData, VarianceLayerKey, VariantPairComparison, VariantSummary } from '../types/index.js';

/**
 * Verdict pill — sticky banner at the top of the HTML report giving the same
 * one-line conclusion as the `omk eval` CLI. Both surfaces share the
 * computeVerdict rule engine so they can never disagree.
 *
 * Color coding follows traffic-light convention plus a yellow band for
 * UNDERPOWERED / NOISE / CAUTIOUS — none of which are "ship" but none of which
 * are "regress" either. SOLO is grey because it's an info pill, not a verdict.
 */
// v0.21 B.4 — verdict 一句话总结. 把 level 标签 + Δ 数字 + action 推荐 + 原因
// 压成一个完整的中文/英文句子, 用 variant 名直接说"X 比 Y 怎么样, 怎么办".
// 用户读完一句话就懂结论, 不需要先学 jargon (Δ / CI / NOISE / SHIP).
// 数字细节让"六维对比"表展示, verdict pill 只给 takeaway.
function verdictOneLine(level: VerdictLevel, lang: Lang, treatment?: string, control?: string): string {
  const t = treatment ?? (lang === 'zh' ? '实验组' : 'treatment');
  const c = control ?? (lang === 'zh' ? '对照组' : 'control');
  if (lang === 'zh') {
    switch (level) {
      case 'PROGRESS':     return `${t} 比 ${c} 明显更好——可以发布`;
      case 'CAUTIOUS':     return `${t} 比 ${c} 略好——但建议再仔细看，差距很小或某层未达标`;
      case 'REGRESS':      return `${t} 比 ${c} 明显更差——不要发布`;
      case 'NOISE':        return `${t} 和 ${c} 没看出明显差别——可以多加几条用例再试`;
      case 'UNDERPOWERED': return `评测用例数太少，看不出 ${t} 和 ${c} 的差别——多跑几个再看`;
      case 'SOLO':         return `只跑了一组,需要加对照组才能对比`;
    }
  }
  switch (level) {
    case 'PROGRESS':     return `${t} is clearly better than ${c} — ready to ship`;
    case 'CAUTIOUS':     return `${t} is slightly better than ${c} — investigate, gap is small or a layer is below threshold`;
    case 'REGRESS':      return `${t} is clearly worse than ${c} — do not ship`;
    case 'NOISE':        return `No clear difference between ${t} and ${c} — try more samples`;
    case 'UNDERPOWERED': return `Not enough data to compare ${t} and ${c} — run more samples`;
    case 'SOLO':         return `Single variant — add a control to compare`;
  }
}

// v0.21 B.4 — 中文标签用"程度副词 + 方向" 三段式 (明显进步 / 略微进步 / 基本
// 持平 / 明显退步) 让用户一眼读懂,不必先学 jargon. 英文保留 level code (开发者
// 用户多, code 反而无歧义).
export function levelLabel(level: VerdictLevel, lang: Lang): string {
  if (lang === 'zh') {
    switch (level) {
      case 'PROGRESS':     return '明显进步';
      case 'CAUTIOUS':     return '略微进步';
      case 'REGRESS':      return '明显退步';
      case 'NOISE':        return '基本持平';
      case 'UNDERPOWERED': return '用例不足';
      case 'SOLO':         return '无法对比';
    }
  }
  return level;
}

// v0.21 B.4 — Tooltip 写人话,不是 jargon 重复. 出现在 listing 页的 status pill
// title 和 detail 页 banner 的 aria-label 上. 用户 hover 立刻知道这个 status
// 是怎么算出来的, 不用查文档.
export function levelTooltip(level: VerdictLevel, lang: Lang): string {
  if (lang === 'zh') {
    switch (level) {
      case 'PROGRESS':     return '实验组分数显著优于对照组';
      case 'REGRESS':      return '实验组分数显著劣于对照组';
      case 'CAUTIOUS':     return '实验组略优于对照组,但差距小或某层未达 gate';
      case 'NOISE':        return '两组分数差距置信区间跨过 0,统计上分辨不出效果';
      case 'UNDERPOWERED': return '评测用例数太少,需要多加几条再看';
      case 'SOLO':         return '只跑了一组,没做对比';
    }
  }
  switch (level) {
    case 'PROGRESS':     return 'Treatment scores significantly above control';
    case 'REGRESS':      return 'Treatment scores significantly below control';
    case 'CAUTIOUS':     return 'Treatment slightly above control — small gap or layer below gate';
    case 'NOISE':        return 'Diff CI spans 0; effect not separable from noise';
    case 'UNDERPOWERED': return 'Sample size too small to detect effect';
    case 'SOLO':         return 'Single variant — no comparison';
  }
}

// Verdict hero — verdict 是报告的「答案」，应在头部抢眼可读：
//   行 1: 状态 badge (明显进步 / PROGRESS) + 自然语言句子 (含 ship action)
//   行 2: 分差 + 评测规模 — 最直观的两个数字, "差多少 / 跑了多少"
// machine-readable enum 通过 data-verdict-level 属性挂在 section 上，给 CI/工具用；
// ship-action token 写进 aria-label 给 screen reader,但不放进 badge 显示文字 ——
// 因为 verdictOneLine 的中文句子已经包含 "可以发布 / 不要发布" 这类 action,
// badge 再放一遍是重复。CI / CV 这种统计学专名挪到 variance 表 + tooltip,hero
// 不堆 jargon. 想看精确边界值的工程师下滑到下方的配对对比 / 波动检验表里看。
// computeVerdict 在历史混合批量 report 上有 NPE 风险，try/catch 让 renderer 不 crash。
const SHIP_LABEL: Record<VerdictLevel, { zh: string; en: string }> = {
  PROGRESS:     { zh: '可发布',   en: 'SHIP' },
  CAUTIOUS:     { zh: '需排查',   en: 'INVESTIGATE' },
  REGRESS:      { zh: '勿发布',   en: 'DO NOT SHIP' },
  NOISE:        { zh: '不下结论', en: 'NO CALL' },
  UNDERPOWERED: { zh: '数据不足', en: 'INSUFFICIENT DATA' },
  SOLO:         { zh: '缺对照',   en: 'ADD CONTROL' },
};

function computeMedianCVPercent(report: Report): number | null {
  const variance = report.variance;
  if (!variance || (variance.runs ?? 0) < 2) return null;
  const cvs: number[] = [];
  for (const v of Object.values(variance.perVariant ?? {})) {
    if (typeof v.stddev === 'number' && typeof v.mean === 'number' && v.mean > 0) {
      cvs.push((v.stddev / v.mean) * 100);
    }
  }
  if (cvs.length === 0) return null;
  cvs.sort((a, b) => a - b);
  return cvs[Math.floor(cvs.length / 2)];
}

export function renderVerdictPill(report: Report, lang: Lang): string {
  let result: VerdictResult;
  try {
    result = computeVerdict(report);
  } catch {
    return '';
  }
  const level = result.level;
  const pair = result.perPair?.[0];
  const oneLine = verdictOneLine(level, lang, pair?.treatment, pair?.control);
  const tooltip = levelTooltip(level, lang);
  const prefix = lang === 'zh' ? '测评结论' : 'Verdict';
  // 机器可读 enum 永远是 level token; 显示给用户的文字按 lang i18n.
  const levelDisplay = lang === 'zh' ? levelLabel(level, lang) : level;
  const shipAria = lang === 'zh' ? SHIP_LABEL[level].zh : SHIP_LABEL[level].en;

  // hero 只放「答案」: 分差是 verdict 的核心证据数字, 单独一枚 chip。
  // 评测规模 (用例数 × 轮次) 走「实验配置」section 的 subtitle 那条 canonical 路径,
  // 不在 hero 里重复; CV / CI 走 chip tooltip + 方法学审计 / 波动表。
  const ci = report.meta?.pairComparisons?.[0]?.diffBootstrapCI;
  const cvPct = computeMedianCVPercent(report);

  const metrics: Array<{ label: string; value: string; tip?: string }> = [];
  if (ci) {
    const sign = ci.estimate >= 0 ? '+' : '';
    const cvSuffix = cvPct != null
      ? (lang === 'zh' ? `;多轮稳定性 CV=${cvPct.toFixed(1)}% (${cvPct < 5 ? '稳' : cvPct < 15 ? '中' : '不稳'})` : `; CV=${cvPct.toFixed(1)}% (${cvPct < 5 ? 'stable' : cvPct < 15 ? 'moderate' : 'unstable'})`)
      : '';
    const ciTipBase = lang === 'zh'
      ? `实验组与对照组综合分均值差(Δ)。bootstrap 95% 可信区间 [${ci.low}, ${ci.high}]，${ci.significant ? '不含 0 = 差异显著' : '跨过 0 = 差异不显著'}${cvSuffix}`
      : `Treatment minus control mean composite score (Δ). Bootstrap 95% CI [${ci.low}, ${ci.high}], ${ci.significant ? 'excludes 0 ⇒ significant' : 'spans 0 ⇒ not significant'}${cvSuffix}`;
    metrics.push({
      label: lang === 'zh' ? '分差' : 'Δ',
      value: `${sign}${ci.estimate}`,
      tip: ciTipBase,
    });
  }

  const metricChips = metrics.map((m) =>
    `<span class="verdict-metric"${m.tip ? ` title="${e(m.tip)}"` : ''}>` +
    `<span class="verdict-metric-label">${e(m.label)}</span>` +
    `<span class="verdict-metric-value">${e(m.value)}</span></span>`,
  ).join('');

  return `<section class="page-verdict verdict-${level}" role="status" data-verdict-level="${e(level)}" aria-label="${e(prefix)}: ${e(levelDisplay)} · ${e(shipAria)} · ${e(oneLine)}" title="${e(tooltip)}">
    <div class="page-verdict-head">
      <span class="page-verdict-badge"><span class="page-verdict-badge-dot" aria-hidden="true">●</span>${e(levelDisplay)}</span>
      <span class="page-verdict-text">${e(oneLine)}</span>
    </div>
    ${metricChips ? `<div class="page-verdict-metrics">${metricChips}</div>` : ''}
  </section>`;
}


/**
 * Pairwise diff (treatment vs control) bootstrap CI table — populated only when
 * --bootstrap was used and at least 2 variants ran. Each row shows whether
 * treatment significantly outperformed control on compositeScore mean.
 */
export function renderPairwiseDiff(pairs: VariantPairComparison[] | undefined, lang: Lang): string {
  if (!pairs || pairs.length === 0) return '';
  const validPairs = pairs.filter((p) => p.diffBootstrapCI);
  if (validPairs.length === 0) return '';

  const rows = validPairs.map((p) => {
    const ci = p.diffBootstrapCI!;
    const sigClass = ci.significant ? 'green' : 'text-muted';
    const sigText = ci.significant ? t('bootstrapDiffSignificant', lang) : t('bootstrapDiffNotSignificant', lang);
    const estColor = ci.estimate > 0 ? 'var(--green)' : ci.estimate < 0 ? 'var(--red)' : 'var(--text-muted)';
    return `<tr>
      <td><strong>${e(p.treatment)}</strong> ${lang === 'zh' ? 'vs' : 'vs'} ${e(p.control)}</td>
      <td style="text-align:center;color:${estColor}"><strong>${ci.estimate >= 0 ? '+' : ''}${ci.estimate}</strong></td>
      <td style="text-align:center;font-size:11px">[${ci.low}, ${ci.high}]</td>
      <td style="text-align:center;color:var(--${sigClass})">${sigText}</td>
      <td style="text-align:center;color:var(--text-muted);font-size:11px">${ci.samples}</td>
    </tr>`;
  }).join('');

  return `
    <h2 style="margin-top:24px">${lang === 'zh' ? '配对对比 (Bootstrap CI)' : 'Pairwise comparison (bootstrap CI)'}</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 12px">${lang === 'zh' ? 'control vs treatment 的均值差 95% CI。CI 不含 0 = 显著差异。bootstrap 不假设分布,适合 LLM 序数评分。' : '95% CI on (treatment - control) mean diff. 0 outside CI = significant. Bootstrap is distribution-free, fits ordinal LLM scores.'}</p>
    <div class="table-wrap">
    <table class="summary-table">
      <thead><tr>
        <th>${lang === 'zh' ? '对照' : 'Pair'}</th>
        <th title="${t('bootstrapDiffLabel', lang)}">${t('bootstrapDiffLabel', lang)}</th>
        <th>95% CI</th>
        <th>${lang === 'zh' ? '显著性' : 'Significance'}</th>
        <th>${lang === 'zh' ? '重采样数' : 'samples'}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

/**
 * Human-gold agreement section — rendered when --gold-dir was used at run time
 * and the report has been re-persisted with `meta.humanAgreement`. Shows α
 * (primary), bootstrap CI on α, weighted κ, Pearson — and surfaces a
 * contamination warning prominently when the gold annotator id overlaps with
 * the judge model id.
 */
export function renderHumanAgreement(agreement: ReportHumanAgreement | undefined, lang: Lang): string {
  if (!agreement) return '';
  if (agreement.sampleCount === 0) return '';
  const fmt = (x: number): string => Number.isNaN(x) ? 'NaN' : x.toFixed(3);
  const a = agreement;
  const alphaColor = Number.isNaN(a.alpha)
    ? 'var(--text-muted)'
    : a.alpha >= 0.8 ? 'var(--green)'
    : a.alpha >= 0.667 ? 'var(--yellow)'
    : 'var(--red)';
  const interpret = lang === 'zh'
    ? (Number.isNaN(a.alpha)
      ? '评分多样性不足，α 未定义'
      : a.alpha >= 0.8 ? '高度一致——结论可放心使用'
      : a.alpha >= 0.667 ? '可接受——谨慎结论'
      : a.alpha >= 0.4 ? '较弱一致——结论需配合 CI 与人工抽检'
      : a.alpha >= 0 ? '偏差较大——排查 rubric / prompt'
      : '系统性反向——重新审视判分逻辑')
    : (Number.isNaN(a.alpha)
      ? 'insufficient rating variance for α'
      : a.alpha >= 0.8 ? 'high agreement — conclusions trustworthy'
      : a.alpha >= 0.667 ? 'acceptable — conclude cautiously'
      : a.alpha >= 0.4 ? 'weak agreement — pair with CI + spot-checks'
      : a.alpha >= 0 ? 'large divergence — investigate rubric / prompt'
      : 'systematic inversion — judge logic needs review');

  const warningBlock = a.contaminationWarning
    ? `<div style="margin:8px 0;padding:8px 12px;background:rgba(255, 200, 80, 0.12);border-left:3px solid var(--yellow);font-size:13px"><strong>${lang === 'zh' ? '污染警告' : 'Contamination warning'}:</strong> ${e(a.contaminationWarning)}</div>`
    : '';

  const missingNote = (a.missingCount > 0 || a.unscoredCount > 0)
    ? `<p style="font-size:12px;color:var(--text-muted);margin:4px 0">${lang === 'zh' ? '注: 报告缺' : 'Note: report missing'} ${a.missingCount} ${lang === 'zh' ? '条 sample' : 'samples'}${a.unscoredCount > 0 ? `, ${a.unscoredCount} ${lang === 'zh' ? '条无评分' : 'unscored'}` : ''}</p>`
    : '';

  return `
    <h2 style="margin-top:24px">${lang === 'zh' ? '人工锚点 (Human Gold)' : 'Human gold anchor'}</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 12px">${lang === 'zh' ? '对比 LLM 评委分与外部标注的一致性。α 解决"评委对不对"，区别于 CI 解决"评委稳不稳"。' : 'Agreement between the LLM judge and external annotations. α addresses "is the judge correct"; the bootstrap CI addresses "is it consistent".'}</p>
    ${warningBlock}
    <div class="table-wrap">
    <table class="summary-table">
      <thead><tr>
        <th>${lang === 'zh' ? '指标' : 'Metric'}</th>
        <th style="text-align:center">${lang === 'zh' ? '值' : 'Value'}</th>
        <th style="text-align:center">95% CI</th>
        <th>${lang === 'zh' ? '说明' : 'Note'}</th>
      </tr></thead>
      <tbody>
        <tr>
          <td><strong>Krippendorff α</strong></td>
          <td style="text-align:center;color:${alphaColor}"><strong>${fmt(a.alpha)}</strong></td>
          <td style="text-align:center;font-size:11px">[${fmt(a.alphaCI.low)}, ${fmt(a.alphaCI.high)}]</td>
          <td style="font-size:12px;color:var(--text-secondary)">${lang === 'zh' ? '主指标，序数加权' : 'primary, ordinal-weighted'}</td>
        </tr>
        <tr>
          <td>${lang === 'zh' ? '加权 κ' : 'weighted κ'}</td>
          <td style="text-align:center">${fmt(a.weightedKappa)}</td>
          <td style="text-align:center;color:var(--text-muted)">—</td>
          <td style="font-size:12px;color:var(--text-secondary)">${lang === 'zh' ? '副指标，平方加权' : 'secondary, quadratic'}</td>
        </tr>
        <tr>
          <td>Pearson r</td>
          <td style="text-align:center">${fmt(a.pearson)}</td>
          <td style="text-align:center;color:var(--text-muted)">—</td>
          <td style="font-size:12px;color:var(--text-secondary)">${lang === 'zh' ? '只看 rank order' : 'rank-order only'}</td>
        </tr>
      </tbody>
    </table>
    </div>
    <p style="margin:8px 0 0;font-size:13px"><strong>${lang === 'zh' ? '解读' : 'Reading'}:</strong> ${e(interpret)}</p>
    <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted)">${lang === 'zh' ? '标注者' : 'annotator'}: ${e(a.goldAnnotator)} (v${e(a.goldVersion)}) · variant: <strong>${e(a.variant)}</strong> · n=${a.sampleCount}</p>
    ${missingNote}`;
}

/**
 * Saturation curve — answers "did I run enough samples?". Renders an inline
 * SVG of mean ± 95% CI shading vs cumulative N, one curve per variant. The
 * verdict line below the chart calls out the saturation point (when the curve
 * has flattened enough that more samples don't materially shrink the CI).
 *
 * Hidden when variance is absent (single-run reports) or when there are fewer
 * than 2 checkpoints. We keep the chart visible at 2-4 checkpoints (= repeat
 * < 5) so users can see the trajectory; the verdict is only computed at
 * repeat ≥ 5.
 */
export function renderSaturationCurve(saturation: SaturationData | undefined, variants: string[], lang: Lang): string {
  if (!saturation) return '';
  const checkpoints = saturation.checkpointSampleCounts;
  if (!checkpoints || checkpoints.length < 2) return '';

  // Layout: 600 × 280 SVG, leave 50px on the left for y-axis and 30px at the
  // bottom for x-axis labels. Score is the 1-5 Likert range; pin axes to that.
  const width = 600, height = 280, padL = 50, padR = 20, padT = 16, padB = 32;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xMax = Math.max(...checkpoints);
  const xMin = Math.min(...checkpoints);
  const yMin = 1, yMax = 5;
  const xScale = (x: number): number => padL + (plotW * (x - xMin)) / Math.max(1, xMax - xMin);
  const yScale = (y: number): number => padT + plotH - (plotH * (y - yMin)) / (yMax - yMin);

  // Per-variant curves and CI ribbons.
  const seriesParts: string[] = [];
  variants.forEach((variant, i) => {
    const trace = saturation.perVariant[variant];
    if (!trace || trace.length === 0) return;
    const color = COLORS[i % COLORS.length];

    // CI ribbon: polygon walking forward along upper bound and back along lower.
    const upper = trace.map((p) => `${xScale(p.n).toFixed(1)},${yScale(p.ciHigh).toFixed(1)}`);
    const lower = trace.map((p) => `${xScale(p.n).toFixed(1)},${yScale(p.ciLow).toFixed(1)}`).reverse();
    const ribbonPoints = [...upper, ...lower].join(' ');
    seriesParts.push(`<polygon points="${ribbonPoints}" fill="${color}" fill-opacity="0.15" stroke="none" />`);

    // Mean line.
    const linePoints = trace.map((p) => `${xScale(p.n).toFixed(1)},${yScale(p.mean).toFixed(1)}`).join(' ');
    seriesParts.push(`<polyline points="${linePoints}" fill="none" stroke="${color}" stroke-width="2" />`);

    // Mean dots.
    for (const p of trace) {
      seriesParts.push(`<circle cx="${xScale(p.n).toFixed(1)}" cy="${yScale(p.mean).toFixed(1)}" r="3" fill="${color}" />`);
    }
  });

  // Y-axis ticks at 1..5; x-axis ticks at every checkpoint.
  const yTicks = [1, 2, 3, 4, 5].map((y) =>
    `<line x1="${padL}" y1="${yScale(y)}" x2="${width - padR}" y2="${yScale(y)}" stroke="var(--border)" stroke-width="0.5" />
     <text x="${padL - 6}" y="${yScale(y) + 4}" font-size="10" text-anchor="end" fill="var(--text-muted)">${y}</text>`,
  ).join('');
  const xTicks = checkpoints.map((n) =>
    `<text x="${xScale(n)}" y="${height - padB + 14}" font-size="10" text-anchor="middle" fill="var(--text-muted)">${n}</text>`,
  ).join('');

  // Per-variant verdict block underneath.
  const verdictRows: string[] = [];
  if (saturation.verdicts) {
    for (const variant of variants) {
      const v = saturation.verdicts[variant];
      if (!v) continue;
      const flagColor = v.saturated ? 'var(--green)' : 'var(--yellow)';
      const flagText = v.saturated
        ? (lang === 'zh' ? `已饱和 (N=${v.atN})` : `saturated at N=${v.atN}`)
        : (lang === 'zh' ? '尚未饱和' : 'not yet saturated');
      const conf = v.confidence === 'low'
        ? `<span style="color:var(--yellow)">⚠ ${lang === 'zh' ? '用例太少,结论参考意义有限' : 'low confidence, interpret cautiously'}</span>`
        : '';
      verdictRows.push(
        `<tr><td><strong>${e(variant)}</strong></td>
         <td style="color:${flagColor}"><strong>${flagText}</strong></td>
         <td style="font-size:12px;color:var(--text-secondary)">${e(v.reason)} ${conf}</td></tr>`,
      );
    }
  }

  const noteHtml = saturation.verdicts
    ? `<div class="table-wrap"><table class="summary-table">
       <thead><tr>
         <th>${lang === 'zh' ? '变体' : 'Variant'}</th>
         <th>${lang === 'zh' ? '判定' : 'Verdict'}</th>
         <th>${lang === 'zh' ? '依据' : 'Rationale'}</th>
       </tr></thead><tbody>${verdictRows.join('')}</tbody></table></div>`
    : `<p style="font-size:13px;color:var(--text-muted);margin:8px 0 0">${lang === 'zh' ? '提示:repeat ≥ 5 时才会输出饱和判定。当前数据只够画曲线,不足以下结论。' : 'Note: saturation verdict needs repeat ≥ 5. Current data plots the curve only.'}</p>`;

  return `
    <h2 style="margin-top:24px">${lang === 'zh' ? '饱和曲线 (Saturation curve)' : 'Saturation curve'}</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 12px">${lang === 'zh' ? '随累积评测用例数 N 增长的均值与 95% CI。CI 宽度衰减放缓即饱和——再多评测用例对结论无实质收益。' : 'Mean and 95% CI as cumulative N grows. When CI shrink rate flattens, the evidence has saturated — more samples buy little.'}</p>
    <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:${width}px;height:auto;display:block">
      ${yTicks}
      <text x="${padL - 36}" y="${padT + plotH / 2}" font-size="11" text-anchor="middle" fill="var(--text-muted)" transform="rotate(-90 ${padL - 36} ${padT + plotH / 2})">${lang === 'zh' ? '均值' : 'mean'}</text>
      <text x="${padL + plotW / 2}" y="${height - 4}" font-size="11" text-anchor="middle" fill="var(--text-muted)">${lang === 'zh' ? '累积评测用例数 N' : 'cumulative N'}</text>
      ${xTicks}
      ${seriesParts.join('\n')}
    </svg>
    ${noteHtml}`;
}

export function renderSummaryCards(variants: string[], summary: Record<string, VariantSummary>, lang: Lang, variance?: VarianceData): string {
  // 六维对比表格:事实 / 行为 / LLM 评价 / 成本 / 效率 / 稳定性。
  // 前三列(事实/行为/LLM 评价)是 task 级原始指标的 variant 聚合;成本/效率同。
  // 稳定性是 variant 级散度度量(需 --repeat ≥ 2)。
  //
  // composite 合成分 (= (fact + behavior + judge) / 3) 从 v0.16 起不再在此表主视觉呈现,
  // 仅保留在 report JSON 数据层 + Variance & Significance 表顶层 flat 字段(legacy)。
  // 综合分放在第一列, 紧贴 实验分组. 它是 fact/behavior/judge 三层的等权均值,
  // 在 omk 内部承担「跨 run 排序 / bootstrap CI / verdict 比较信号」三个角色 ——
  // 这里展示 + 表头 ? button 弹 modal 公开计算方式 + 局限, 让用户知情消费。
  // 其余六列保持 layer-first (fact / behavior / judge / cost / efficiency / stability)。
  const headerCols = [
    { key: 'dimFact', label: t('dimFact', lang) },
    { key: 'dimBehavior', label: t('dimBehavior', lang) },
    { key: 'dimJudge', label: t('dimJudge', lang) },
    { key: 'dimCost', label: t('dimCost', lang) },
    { key: 'dimEfficiency', label: t('dimEfficiency', lang) },
    { key: 'dimStability', label: t('dimStability', lang) },
  ];

  const scoringModalId = 'guide-scoring';
  // v0.30 — 拆 hero(每变体综合分一行)+ heatmap 表(去 composite,加色块)。
  // composite 从表里挪出来当 hero,大字号 + delta 跟 baseline 对比;
  // 维度细节继续用表,但每格按 score 浅色填充,便于扫读弱维度。
  const thead = `<tr><th data-i18n="variants">${t('variants', lang)}</th>${headerCols.map((c) => `<th data-i18n="${c.key}">${c.label}</th>`).join('')}</tr>`;

  // 渲染单层分数 cell(事实/行为/LLM 评价通用)— 加 heatmap 浅色背景
  function renderLayerCell(varianceMean: number | undefined, summaryValue: number | undefined, detailHtml = ''): string {
    const v = varianceMean ?? summaryValue;
    const hasValue = typeof v === 'number' && v > 0;
    const heatClass = hasValue
      ? (v >= 4 ? 'sm-heat-pass' : v >= 3 ? 'sm-heat-warn' : 'sm-heat-fail')
      : '';
    const color = hasValue
      ? (v >= 4 ? 'var(--green)' : v >= 3 ? 'var(--yellow)' : 'var(--red)')
      : 'var(--text-muted)';
    const display = hasValue ? v.toFixed(2) : '—';
    return `<td class="summary-cell ${heatClass}"><div class="summary-value summary-value-primary" style="color:${color}">${display}</div>${detailHtml}</td>`;
  }

  const rows = variants.map((v, i) => {
    const s = summary[v] || {} as VariantSummary;
    const vd = variance?.perVariant[v];
    const color = COLORS[i % COLORS.length];

    // 事实层 cell(含事实验证率 detail,如果有)
    const factDetailParts: string[] = [];
    if (s.avgFactVerifiedRate != null) {
      const pct = Math.round(s.avgFactVerifiedRate * 100);
      factDetailParts.push(`${lang === 'zh' ? '验证率' : 'Verified'} ${pct}%`);
    }
    const factDetail = factDetailParts.length > 0 ? `<div class="summary-detail">${factDetailParts.join(' · ')}</div>` : '';
    const factCell = renderLayerCell(vd?.byLayer?.fact?.mean, s.avgFactScore, factDetail);

    // 行为层 cell(暂无 detail,后续可按工具调用成功率之类扩展)
    const behaviorCell = renderLayerCell(vd?.byLayer?.behavior?.mean, s.avgBehaviorScore);

    // LLM 评价层 cell
    const judgeCell = renderLayerCell(vd?.byLayer?.judge?.mean, s.avgJudgeScore);

    // Cost — only show execution cost (judge cost is tool overhead, not skill cost)
    // execCostReported === false 时(如 codex executor)显示「—」并 tooltip 解释,
    // 跟"真的花了 $0(全 cached / 短 prompt)"区分开。
    const execCost = s.totalExecCostUSD || 0;
    const costReported = s.execCostReported !== false;
    const hasCost = execCost > 0 || (s.avgTotalTokens || 0) > 0;
    const costUnreportedTooltip = lang === 'zh'
      ? 'executor 不报 USD 成本(如 codex CLI),无法估算'
      : 'executor does not report USD cost (e.g. codex CLI); not measurable';
    const costCell = hasCost
      ? (costReported
        ? `<td class="summary-cell"><div class="summary-value">${fmtCost(execCost)}</div><div class="summary-detail">${fmtNum(s.avgTotalTokens)} tokens/${t('tokPerReq', lang).replace('tokens/', '')}</div></td>`
        : `<td class="summary-cell" title="${e(costUnreportedTooltip)}"><div class="summary-value" style="color:var(--text-muted)">${fmtCost(0, false)}</div><div class="summary-detail">${fmtNum(s.avgTotalTokens)} tokens/${t('tokPerReq', lang).replace('tokens/', '')}</div></td>`)
      : `<td class="summary-cell"><span style="color:var(--text-muted)">N/A</span></td>`;

    // Efficiency
    const effDetails: string[] = [];
    const displayTurns = s.avgFullNumTurns ?? s.avgNumTurns;
    if ((displayTurns || 0) > 0) effDetails.push(`${displayTurns} ${t('turnsPerReq', lang)}`);
    if (s.avgToolCalls != null && s.avgToolCalls > 0) {
      const srPct = s.toolSuccessRate != null ? ` (${(s.toolSuccessRate * 100).toFixed(0)}% OK)` : '';
      effDetails.push(`${s.avgToolCalls} tools/req${srPct}`);
    }
    const totalDurationMs = (s.avgDurationMs || 0) * (s.successCount || 0);
    if (totalDurationMs > 0) effDetails.push(`${lang === 'zh' ? '总计' : 'total'} ${fmtDuration(totalDurationMs)}`);
    const effDetail = effDetails.length > 0 ? `<div class="summary-detail">${effDetails.join(' · ')}</div>` : '';
    const avgLabel = lang === 'zh' ? '次' : 'req';
    const effCell = `<td class="summary-cell"><div class="summary-value">${fmtDuration(s.avgDurationMs)}<span class="summary-unit">/${avgLabel}</span></div>${effDetail}</td>`;

    // Stability — 多次运行分数一致性（test-retest reliability），统计学定义的稳定性。
    // 主视觉:白话定性词 + ±σ 直观量级,让读者一眼判断。
    // 副区:CV (变异系数 = σ / mean) 分两行展示 + 95% CI(置信区间)。
    // 无 --repeat(variance 缺失) 时主值显示 "—" + 明示需多跑,不虚报 100%——
    // 符合 omk 叙事底线"诚实交代测不到什么"。
    //
    // 跨用例 min~max range 不是稳定性(反映用例难度差异,非 variant 波动),已从此列移除。
    // 成功率 ≠ 稳定性(执行完成率,不是分数一致性),降级到 < 100% 时的副区 alert。
    const total = s.totalSamples || 0;
    const successCount = s.successCount || 0;
    const errorCount = s.errorCount || 0;
    const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;

    const stabDetails: string[] = [];
    let stabValue: string;
    let stabColor: string;

    // CV = σ / mean,当 mean 过小(接近 0)时 CV 发散,数值无参考价值——1-5 分数量纲下
     // mean < 0.5 已属全灭场景,直接降级显示"—"。负 mean(理论上不会出现)也走降级。
    if (vd && typeof vd.stddev === 'number' && typeof vd.mean === 'number' && vd.mean >= 0.5) {
      const cv = Math.abs(vd.stddev / vd.mean);
      const cvPct = cv * 100;
      const sigma = vd.stddev;
      // 主值用白话定性 + ±σ 直观量级,让非统计背景读者一眼判断。
      // CV 和 CI 下沉到副区,给懂的人细看。阈值面向 1-5 分数量纲的经验值。
      let label: string;
      if (cvPct < 5) {
        label = lang === 'zh' ? '稳定' : 'Stable';
        stabColor = 'var(--green)';
      } else if (cvPct < 15) {
        label = lang === 'zh' ? '较稳' : 'Moderate';
        stabColor = 'var(--yellow)';
      } else {
        label = lang === 'zh' ? '波动大' : 'Variable';
        stabColor = 'var(--red)';
      }
      stabValue = `${label} · ±${fmtNum(sigma, 2)}`;
      const ciLo = fmtNum(vd.lower, 2);
      const ciHi = fmtNum(vd.upper, 2);
      stabDetails.push(`CV ${cvPct.toFixed(1)}% · 95% CI [${ciLo}, ${ciHi}]`);
    } else {
      // No cross-run data → make the gap loud, not silent. 之前用灰色 "—" 让单轮
      // 报告读者误以为"无显示 = 没问题",实际是 omk 测不到这个维度。改红 +
      // "未测量" 字样让缺失可见 — 鼓励用户加 --repeat ≥ 2 而不是默默 ship。
      stabValue = lang === 'zh' ? '⚠ 未测量' : '⚠ Not measured';
      stabColor = 'var(--red)';
      stabDetails.push(
        `<span style="color:var(--red)">${
          lang === 'zh' ? '单轮评测,加 --repeat ≥ 2 才能测 CV' : 'single-run; needs --repeat ≥ 2 to measure CV'
        }</span>`,
      );
    }

    // Execution-completion alerts:success rate < 100% 时降级到此处,避免和"稳定性"语义混淆。
    if (errorCount > 0) {
      stabDetails.unshift(`<span style="color:var(--red)">${successRate}% ${lang === 'zh' ? '完成率' : 'completed'} · ${errorCount} ${t('errors', lang)}</span>`);
    }

    // 正常情况副区只一行:`CV X.X% · 95% CI [...]`。
    // 有 alert(成功率 < 100%) 时把 alert 放第一行、CV+CI 放第二行,让异常信息第一眼看到。
    const stabDetail = stabDetails.length > 0
      ? stabDetails.map((d) => `<div class="summary-detail">${d}</div>`).join('')
      : '';

    const stabCell = `<td class="summary-cell"><div class="summary-value" style="color:${stabColor}">${stabValue}</div>${stabDetail}</td>`;

    return `<tr><td style="border-left:3px solid ${color};padding-left:12px"><strong>${e(v)}</strong></td>${factCell}${behaviorCell}${judgeCell}${costCell}${effCell}${stabCell}</tr>`;
  }).join('');

  // ──────────── Hero 行:每 variant 一行,综合分大字号 + delta vs baseline ────────────
  // 每变体一行,左 variant 名 + 颜色条;中 大字号 composite;右 delta(vs variants[0])
  const baselineComposite = summary[variants[0]]?.avgCompositeScore;
  const heroRows = variants.map((v, i) => {
    const s = summary[v] || {} as VariantSummary;
    const composite = s.avgCompositeScore;
    const compositeHasValue = typeof composite === 'number' && composite > 0;
    const compositeColor = compositeHasValue
      ? (composite >= 4 ? 'var(--green)' : composite >= 3 ? 'var(--yellow)' : 'var(--red)')
      : 'var(--text-muted)';
    const compositeDisplay = compositeHasValue ? composite.toFixed(2) : '—';
    const color = COLORS[i % COLORS.length];
    let deltaHtml = '';
    if (i > 0 && compositeHasValue && typeof baselineComposite === 'number' && baselineComposite > 0) {
      const diff = composite! - baselineComposite;
      if (Math.abs(diff) >= 0.01) {
        const sign = diff > 0 ? '+' : '';
        const dColor = diff > 0 ? 'var(--green)' : 'var(--red)';
        const arrow = diff > 0 ? '↑' : '↓';
        deltaHtml = `<span class="sm-hero-delta" style="color:${dColor}">${sign}${diff.toFixed(2)} ${arrow}</span>`;
      }
    }
    return `<div class="sm-hero" style="border-left:3px solid ${color}">
      <div class="sm-hero-name">${e(v)}</div>
      <div class="sm-hero-score" style="color:${compositeColor}">${compositeDisplay}<span class="sm-hero-unit">/ 5</span></div>
      ${deltaHtml || '<span class="sm-hero-delta-placeholder"></span>'}
    </div>`;
  }).join('');
  const heroBlock = `<div class="sm-hero-list">
    <div class="sm-hero-h">
      ${lang === 'zh' ? '综合分' : 'Composite'}
      <button type="button" class="hint-btn" onclick="openModal('${scoringModalId}')" aria-label="${e(lang === 'zh' ? '综合分怎么算的？' : 'How is composite computed?')}" aria-haspopup="dialog">?</button>
    </div>
    ${heroRows}
  </div>`;

  const guideModalId = 'guide-six-dims';
  const guideTitle = lang === 'zh' ? '如何阅读六维对比？' : 'How to read this six-dimension comparison?';
  const guideIntro = lang === 'zh'
    ? '每行是一个实验分组（Variant），六列分别衡量不同维度：'
    : 'Each row is an experiment variant. Six columns measure independent dimensions:';
  const icon = (emoji: string) => `<span aria-hidden="true">${emoji}</span>`;
  // 维度分隔加粗(border-top 2px),让六维的视觉边界更明显。sub 缩进从 28 收到 22。
  const dim = 'style="padding:12px 0 4px;border-top:2px solid var(--border);color:var(--text-primary);font-weight:600"';
  const dimDesc = 'style="padding:12px 0 4px;border-top:2px solid var(--border);color:var(--text-secondary)"';
  const dimFirst = 'style="padding:4px 0 4px;color:var(--text-primary);font-weight:600"';
  const dimFirstDesc = 'style="padding:4px 0 4px;color:var(--text-secondary)"';
  const sub = 'style="padding:2px 0 2px 22px;font-size:12px;color:var(--text-secondary);font-weight:500"';
  const subDesc = 'style="padding:2px 0;font-size:12px;color:var(--text-muted)"';
  const guideRows = lang === 'zh' ? `
    <tr><td ${dimFirst}>${icon('📋')} <strong>事实</strong></td><td ${dimFirstDesc}>任务执行模型的输出说得对不对（事实声明层面）。靠规则断言判：关键词是否出现、JSON 格式是否合法等，答错了直接不给分。</td></tr>
    <tr><td ${dim}>${icon('🛠️')} <strong>行为</strong></td><td ${dimDesc}>任务执行模型做事的过程有没有走对路。靠规则断言判：该调的工具有没有调、有没有超过轮次/成本上限。</td></tr>
    <tr><td ${dim}>${icon('💬')} <strong>LLM 评价</strong></td><td ${dimDesc}>请一个 LLM 当评委，让它读任务执行模型的输出内容，按预先写好的评分规则（英文叫 rubric）打个 1-5 分。主观但能抓到规则断言判不了的"整体好不好"——比如回答是否清晰、有没有答非所问。</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>执行成本</strong></td><td ${dimDesc}>任务执行模型跑这次评测花了多少 API 调用费。评委模型成本单独作为评测开销记录，不算进 skill 自身成本。</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>效率</strong></td><td ${dimDesc}>一次评测平均跑多久；附带轮次数和工具调用次数。</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>稳定性</strong></td><td ${dimDesc}>同一份测试跑很多次，分数抖不抖。抖得越少越稳定。<strong>跑一次看不出稳定性</strong>——至少要 <code>--repeat ≥ 2</code>，不然显示"—"。</td></tr>
    <tr><td ${sub}>稳定 / 较稳 / 波动大</td><td ${subDesc}>分数波动比例 &lt;5% = 稳定 · 5~15% = 一般 · &gt;15% = 波动大</td></tr>
    <tr><td ${sub}>±σ</td><td ${subDesc}>每次跑出的分数，大概在平均分上下浮动多少。1-5 分数里 ±0.05 几乎不抖、±0.5 抖得很厉害</td></tr>
    <tr><td ${sub}>CV</td><td ${subDesc}>分数抖动幅度占平均分的比例（例：CV 2% = 分数波动大约是平均分的 2%）</td></tr>
    <tr><td ${sub}>95% CI</td><td ${subDesc}>如果跑无数次求平均，真实平均分有 95% 概率落在这个范围里——范围越窄，这次测出的均值越可信</td></tr>
  ` : `
    <tr><td ${dimFirst}>${icon('📋')} <strong>Fact</strong></td><td ${dimFirstDesc}>Whether the task execution model's output is factually correct. Checked by rule-based assertions — keyword matches, JSON schema validity, etc. Wrong = zero.</td></tr>
    <tr><td ${dim}>${icon('🛠️')} <strong>Behavior</strong></td><td ${dimDesc}>Whether the task execution model followed the right process. Checked by rule-based assertions — did it call the expected tools, stay within turn/cost limits.</td></tr>
    <tr><td ${dim}>${icon('💬')} <strong>LLM judge</strong></td><td ${dimDesc}>A separate LLM acts as judge: it reads the task execution model's output and scores it 1-5 against a predefined rubric. Subjective, but catches "overall feel" that rule-based assertions miss — e.g., whether the answer is clear, whether it's on-topic.</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>Exec cost</strong></td><td ${dimDesc}>API cost for the task execution model. Judge model cost is tracked as evaluation overhead, not skill cost.</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>Efficiency</strong></td><td ${dimDesc}>Average time per evaluation, plus turn counts and tool call stats.</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>Stability</strong></td><td ${dimDesc}>How much the score swings when you repeat the same test. Less swing = more stable. <strong>You can't measure stability from a single run</strong> — need <code>--repeat ≥ 2</code>, otherwise shows "—".</td></tr>
    <tr><td ${sub}>Stable / Moderate / Variable</td><td ${subDesc}>Score swing as % of mean: &lt;5% = Stable · 5~15% = Moderate · &gt;15% = Variable</td></tr>
    <tr><td ${sub}>±σ</td><td ${subDesc}>How much each run's score typically swings around the mean. On a 1-5 scale, ±0.05 barely moves, ±0.5 swings a lot</td></tr>
    <tr><td ${sub}>CV</td><td ${subDesc}>Score swing as a percentage of the mean (e.g., CV 2% = swings are about 2% of the mean)</td></tr>
    <tr><td ${sub}>95% CI</td><td ${subDesc}>If you ran infinitely many times, the true mean has a 95% chance of falling in this range — narrower = you can trust the measured mean more</td></tr>
  `;

  const scoringModalHtml = renderScoringModal(scoringModalId, lang);

  return `
    <h2 style="display:flex;align-items:center;gap:4px">${lang === 'zh' ? '六维对比' : 'Six-Dimension Comparison'} <button type="button" class="hint-btn" onclick="openModal('${guideModalId}')" aria-label="${e(guideTitle)}" aria-haspopup="dialog">?</button></h2>
    <div id="${guideModalId}" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${guideModalId}-title" onclick="if(event.target===this)closeModal('${guideModalId}')">
      <div class="modal-content">
        <div class="modal-header">
          <strong id="${guideModalId}-title" style="font-size:1rem">${e(guideTitle)}</strong>
          <button type="button" class="modal-close" onclick="closeModal('${guideModalId}')" aria-label="${lang === 'zh' ? '关闭' : 'Close'}">✕</button>
        </div>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 16px">${e(guideIntro)}</p>
        <table class="modal-table"><tbody>${guideRows}</tbody></table>
      </div>
    </div>
    ${scoringModalHtml}
    ${heroBlock}
    <div class="table-wrap">
    <table class="summary-table">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
    <style>
    /* 六维对比 — Hero 区(每 variant 综合分 + delta) */
    .sm-hero-list { display:flex;flex-direction:column;gap:8px;margin:14px 0 18px }
    .sm-hero-h { font-size:13px;color:var(--text-muted);margin-bottom:4px;letter-spacing:0.02em }
    .sm-hero { display:flex;align-items:baseline;gap:16px;padding:14px 18px;background:var(--bg-surface);border-radius:var(--radius);box-shadow:var(--shadow-sm) }
    .sm-hero-name { flex:1;font-size:14.5px;font-weight:500;color:var(--text-primary) }
    .sm-hero-score { font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1 }
    .sm-hero-unit { font-size:13px;color:var(--text-muted);margin-left:4px;font-weight:400 }
    .sm-hero-delta { font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;font-family:"SF Mono",Menlo,monospace;min-width:60px;text-align:right }
    .sm-hero-delta-placeholder { display:inline-block;min-width:60px }
    /* 六维 heatmap — 每格按分数浅色填充,便于远看识别弱维度 */
    .sm-heat-pass { background:linear-gradient(0deg,var(--green-bg),var(--green-bg)) }
    .sm-heat-warn { background:linear-gradient(0deg,var(--yellow-bg),var(--yellow-bg)) }
    .sm-heat-fail { background:linear-gradient(0deg,var(--red-bg),var(--red-bg)) }
    </style>`;
}

/**
 * 评分说明 modal — 公开 composite 计算方式 + 局限,所有展示综合分的地方都通向同一份说明
 * (六维对比表头 / 列表页 score 列 / 趋势页 chart caption)。
 *
 * 测量学诚实性 ≠ 藏起来怕用户误用,而是展示 + 说清楚边界。这个 modal 是简版 (~10 行),
 * 完整推导 (五层评分管道架构 / ratioToScore 公式 / 多层 gate 与 composite 关系)
 * 在 docs/zh/specs/scoring.md。
 */
export function renderScoringModal(id: string, lang: Lang): string {
  const title = lang === 'zh' ? '综合分怎么算的？' : 'How is composite computed?';
  const intro = lang === 'zh'
    ? '综合分（composite）= 等权均值（{事实, 行为, LLM 评价}）。1-5 制。'
    : 'Composite = unweighted mean of {fact, behavior, LLM judge}. Scale 1-5.';

  const sectionHead = (text: string) => `<tr><td colspan="2" style="padding:14px 0 6px;color:var(--text-primary);font-weight:600;font-size:13px;border-top:1px solid var(--border)">${e(text)}</td></tr>`;
  const row = (label: string, body: string) => `<tr><td style="padding:6px 12px 6px 0;color:var(--text-secondary);font-size:12px;font-weight:500;white-space:nowrap;vertical-align:top;width:120px">${e(label)}</td><td style="padding:6px 0;color:var(--text-secondary);font-size:12px;line-height:1.6">${body}</td></tr>`;

  const calcRows = lang === 'zh' ? [
    row('事实 / 行为', '断言通过率经 <code>1 + 通过率 × 4</code> 线性映射到 1-5 制'),
    row('LLM 评价', '评委模型直接给 1-5 分'),
    row('缺失某层', '自动降维（参与计算的层取均值）'),
  ] : [
    row('Fact / Behavior', 'Assertion pass-rate mapped to 1-5 via <code>1 + ratio × 4</code>'),
    row('LLM judge', 'Judge model returns 1-5 score directly'),
    row('Missing layer', 'Auto-collapse (mean over present layers)'),
  ];

  const limitRows = lang === 'zh' ? [
    row('① 等权聚合', '三层各 1/3 权重不是从需求 derive 的，无显式构造效度论证'),
    row('② 量尺不一致', '事实是 binary 通过率 stretch 到 1-5；评委是真序数评分。直接均值违反量表理论（measurement scale homogeneity）'),
    row('③ 缺失自动降维', '不同 variant / skill 配的层数不同时，综合分数字相同但 construct 不同，<strong>不可机械跨 variant / 跨 skill 比较</strong>'),
  ] : [
    row('① Equal-weight aggregation', 'The 1/3 weight per layer is ad hoc, not derived from stakeholder needs; no explicit construct validity argument'),
    row('② Mixed scales added directly', 'Fact is binary pass-rate stretched to 1-5; judge is true ordinal. Direct mean violates measurement scale homogeneity'),
    row('③ Auto-collapse on missing', 'When variants/skills have different layer coverage, composite numbers look same but represent different constructs — <strong>not mechanically comparable across variants/skills</strong>'),
  ];

  const usageRows = lang === 'zh' ? [
    row('✓ 适用', '同一份 eval-samples 上 A/B 比较，看「分差 + bootstrap CI + 三层独立 gate」联合判断'),
    row('✗ 不适用', '当作 absolute psychometric measure（说「这 skill 4.28/5 分」）'),
  ] : [
    row('✓ Use for', 'A/B comparison on same eval-samples — read "diff + bootstrap CI + per-layer gate" jointly'),
    row('✗ Don\'t use as', 'Absolute psychometric measure (claiming "this skill is 4.28/5")'),
  ];

  const calcSection = lang === 'zh' ? '怎么算的' : 'How it\'s computed';
  const limitSection = lang === 'zh' ? '局限（直白说）' : 'Limitations (frankly)';
  const usageSection = lang === 'zh' ? '推荐用法' : 'Recommended usage';
  const docsLink = lang === 'zh'
    ? '完整推导 / 五层评分管道架构 / 多层 gate 与综合分的关系：<a href="https://github.com/lizhiyao/oh-my-knowledge/blob/main/docs/zh/specs/scoring.md" target="_blank" rel="noopener">docs/zh/specs/scoring.md</a>'
    : 'Full derivation / five-layer scoring pipeline / multi-layer gate & composite relationship: <a href="https://github.com/lizhiyao/oh-my-knowledge/blob/main/docs/zh/specs/scoring.md" target="_blank" rel="noopener">docs/zh/specs/scoring.md</a>';

  return `<div id="${id}" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${id}-title" onclick="if(event.target===this)closeModal('${id}')">
    <div class="modal-content">
      <div class="modal-header">
        <strong id="${id}-title" style="font-size:1rem">${e(title)}</strong>
        <button type="button" class="modal-close" onclick="closeModal('${id}')" aria-label="${lang === 'zh' ? '关闭' : 'Close'}">✕</button>
      </div>
      <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 12px">${e(intro)}</p>
      <table class="modal-table"><tbody>
        ${sectionHead(calcSection)}
        ${calcRows.join('')}
        ${sectionHead(limitSection)}
        ${limitRows.join('')}
        ${sectionHead(usageSection)}
        ${usageRows.join('')}
      </tbody></table>
      <p style="font-size:11px;color:var(--text-muted);margin:14px 0 0;line-height:1.6">${docsLink}</p>
    </div>
  </div>`;
}

/**
 * Cross-sample inter-judge agreement table — only renders when at least one variant
 * has multi-judge ensemble data. This is the v0.20.2 "blog headline" view: shows
 * Pearson + MAD across the whole sample set, the metric that refutes "Claude judge
 * Claude same-modality bias".
 */
export function renderJudgeAgreementBlock(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  const variantsWithEnsemble = variants.filter((v) => summary[v]?.judgeAgreement);
  if (variantsWithEnsemble.length === 0) return '';

  const rows = variantsWithEnsemble.map((v) => {
    const s = summary[v];
    const ag = s.judgeAgreement!;
    const judgeList = (s.judgeModels || []).map((j) => `<code>${e(`${j.executor}:${j.model}`)}</code>`).join(', ');
    const pearsonCell = ag.pearson != null
      ? `<span title="${t('pearsonDesc', lang)}" style="color:${ag.pearson >= 0.7 ? 'var(--green)' : ag.pearson >= 0.4 ? 'var(--yellow)' : 'var(--red)'}"><strong>${ag.pearson}</strong></span>`
      : `<span style="color:var(--text-muted)">—</span>`;
    const madCell = `<span title="${t('madDesc', lang)}" style="color:${ag.meanAbsDiff < 0.5 ? 'var(--green)' : ag.meanAbsDiff < 1.5 ? 'var(--yellow)' : 'var(--red)'}"><strong>${ag.meanAbsDiff}</strong></span>`;
    return `<tr>
      <td><strong>${e(v)}</strong></td>
      <td style="font-size:11px;color:var(--text-muted)">${judgeList}</td>
      <td style="text-align:center">${pearsonCell}</td>
      <td style="text-align:center">${madCell}</td>
      <td style="text-align:center;color:var(--text-muted)">${ag.sampleCount}</td>
      <td style="text-align:center;color:var(--text-muted)">${ag.pairCount}</td>
    </tr>`;
  }).join('');

  return `
    <h2 style="margin-top:24px">${t('agreementHeader', lang)}</h2>
    <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 12px">${t('agreementDesc', lang)}</p>
    <div class="table-wrap">
    <table class="summary-table">
      <thead><tr>
        <th>${t('variants', lang)}</th>
        <th>${t('judgeModelsLabel', lang)}</th>
        <th title="${t('pearsonDesc', lang)}">${t('pearsonLabel', lang)}</th>
        <th title="${t('madDesc', lang)}">${t('madLabel', lang)}</th>
        <th>${lang === 'zh' ? '评测用例数' : 'Samples'}</th>
        <th>${lang === 'zh' ? 'Judge 对数' : 'Pairs'}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

// 方法学审计 — 把「评测本身可靠不」的证据从一级 H2 收进折叠区。
// 用户读完 hero verdict + 实验配置 + 测评结果 已经能下「skill 行不行」的判断；
// 这里包的 4 块是「想验流程的人」才需要的二级证据：
//   1. 评委一致 (judge ensemble Pearson/MAD)
//   2. 差异显著 (pairwise CI)
//   3. 已饱和 (saturation verdict)
//   4. 人工对齐 (Krippendorff α vs gold; 仅当配过 --gold-dir 时存在)
// summary 行用 badge 直接告诉用户「方法学体检结果」,绿勾代表流程健康,
// 任何 ⚠/✗ 立刻把方法学问题暴露出来,用户会主动展开核实。
type AuditBadgeStatus = 'pass' | 'warn' | 'fail' | 'skip';
interface AuditBadge {
  key: string;
  label: string;
  status: AuditBadgeStatus;
  detail: string;
}

function badgeIcon(status: AuditBadgeStatus): string {
  switch (status) {
    case 'pass': return '✓';
    case 'warn': return '⚠';
    case 'fail': return '✗';
    case 'skip': return '—';
  }
}

function computeJudgeAgreementBadge(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): AuditBadge | null {
  const treatment = variants[1] ?? variants[0];
  const ag = summary[treatment]?.judgeAgreement;
  if (!ag || ag.pearson == null) return null;
  const p = ag.pearson;
  const status: AuditBadgeStatus = p >= 0.7 ? 'pass' : p >= 0.4 ? 'warn' : 'fail';
  const verdict = status === 'pass'
    ? (lang === 'zh' ? '评委一致' : 'judges agree')
    : status === 'warn'
      ? (lang === 'zh' ? '评委偏弱一致' : 'judges weakly agree')
      : (lang === 'zh' ? '评委分歧大' : 'judges diverge');
  return {
    key: 'judge',
    label: verdict,
    status,
    detail: lang === 'zh' ? `Pearson ${p}（≥0.7 一致 / 0.4-0.7 偏弱 / <0.4 分歧）` : `Pearson ${p} (≥0.7 agree / 0.4-0.7 weak / <0.4 diverge)`,
  };
}

function computeSignificanceBadge(report: Report, lang: Lang): AuditBadge | null {
  const ci = report.meta?.pairComparisons?.[0]?.diffBootstrapCI;
  if (!ci) return null;
  const status: AuditBadgeStatus = ci.significant ? 'pass' : 'warn';
  const label = ci.significant
    ? (lang === 'zh' ? '差异显著' : 'significant')
    : (lang === 'zh' ? '差异不显著' : 'not significant');
  return {
    key: 'sig',
    label,
    status,
    detail: lang === 'zh' ? `bootstrap 95% CI [${ci.low}, ${ci.high}]${ci.significant ? '（不含 0）' : '（跨过 0）'}` : `Bootstrap 95% CI [${ci.low}, ${ci.high}]${ci.significant ? ' (excludes 0)' : ' (spans 0)'}`,
  };
}

function computeSaturationBadge(report: Report, variants: string[], lang: Lang): AuditBadge | null {
  const sat = report.variance?.saturation?.verdicts;
  if (!sat) return null;
  const treatment = variants[1] ?? variants[0];
  const v = sat[treatment];
  if (!v) return null;
  const status: AuditBadgeStatus = v.saturated
    ? (v.confidence === 'high' ? 'pass' : 'warn')
    : 'warn';
  const label = v.saturated
    ? (lang === 'zh' ? '已饱和' : 'saturated')
    : (lang === 'zh' ? '未饱和' : 'not saturated');
  return {
    key: 'sat',
    label,
    status,
    detail: lang === 'zh'
      ? `${v.saturated ? `于 N=${v.atN ?? '?'} 饱和` : '尚未饱和'}（${v.confidence} confidence）`
      : `${v.saturated ? `saturates at N=${v.atN ?? '?'}` : 'not yet saturated'} (${v.confidence} confidence)`,
  };
}

function computeHumanAlignmentBadge(report: Report, lang: Lang): AuditBadge | null {
  const a = report.meta?.humanAgreement;
  if (!a || a.sampleCount === 0 || Number.isNaN(a.alpha)) return null;
  const status: AuditBadgeStatus = a.alpha >= 0.667 ? 'pass' : a.alpha >= 0.4 ? 'warn' : 'fail';
  const label = status === 'pass'
    ? (lang === 'zh' ? '人工对齐' : 'aligns with humans')
    : status === 'warn'
      ? (lang === 'zh' ? '人工对齐偏弱' : 'weakly aligns')
      : (lang === 'zh' ? '与人工分歧' : 'diverges from humans');
  return {
    key: 'human',
    label,
    status,
    detail: lang === 'zh' ? `Krippendorff α=${a.alpha.toFixed(3)} vs ${a.goldAnnotator}` : `Krippendorff α=${a.alpha.toFixed(3)} vs ${a.goldAnnotator}`,
  };
}

export function renderMethodologyAudit(
  report: Report,
  variants: string[],
  summary: Record<string, VariantSummary>,
  lang: Lang,
): string {
  const judgeBlock = renderJudgeAgreementBlock(variants, summary, lang);
  const pairwiseBlock = renderPairwiseDiff(report.meta?.pairComparisons, lang);
  const humanBlock = renderHumanAgreement(report.meta?.humanAgreement, lang);
  const saturationBlock = renderSaturationCurve(report.variance?.saturation, variants, lang);
  if (!judgeBlock && !pairwiseBlock && !humanBlock && !saturationBlock) return '';

  const badges = [
    computeJudgeAgreementBadge(variants, summary, lang),
    computeSignificanceBadge(report, lang),
    computeSaturationBadge(report, variants, lang),
    computeHumanAlignmentBadge(report, lang),
  ].filter((b): b is AuditBadge => b !== null);

  // 默认折叠;只有 ✗ fail (红色 badge) 才强制展开 — summary 行已经显示
  // ⚠ warn 状态, 用户能自决是否展开; 但 fail 是危险信号必须让用户看证据。
  const hasFailure = badges.some((b) => b.status === 'fail');
  const openAttr = hasFailure ? ' open' : '';
  const summaryLabel = lang === 'zh' ? '测评可信度' : 'Reliability check';
  const summaryHint = lang === 'zh' ? '点击展开看支撑证据(评委一致 / 差异显著 / 饱和度 / 人工对齐)' : 'click to expand evidence (judge agreement / significance / saturation / human alignment)';

  const badgesHtml = badges.length > 0
    ? `<span class="methodology-badges">${badges.map((b) =>
        `<span class="methodology-badge methodology-badge-${b.status}" title="${e(b.detail)}">${badgeIcon(b.status)} ${e(b.label)}</span>`,
      ).join('')}</span>`
    : '';

  const innerSections = [judgeBlock, pairwiseBlock, humanBlock, saturationBlock].filter(Boolean).join('');

  return `<details class="methodology-audit"${openAttr}>
    <summary><span class="methodology-summary-label">${e(summaryLabel)}</span>${badgesHtml}<span class="methodology-summary-hint">${e(summaryHint)}</span></summary>
    <div class="methodology-body">${innerSections}</div>
  </details>`;
}

interface DiagnosticEntry {
  icon: string;
  text: string;
  color: string;
}

function buildDiagnostic(
  metric: VarianceComparisonMetric,
  cfg: BaseDisplayConfig,
  winner: string | null,
  lang: Lang,
): DiagnosticEntry {
  const es = metric.effectSize;
  if (!es || es.primary === 'none') {
    return {
      icon: '—',
      text: lang === 'zh' ? '数据不足，无法判断' : 'insufficient data',
      color: 'var(--text-muted)',
    };
  }
  const isStrong = es.magnitude === 'medium' || es.magnitude === 'large';
  const strongLabelZh = es.magnitude === 'large' ? '大' : '中';
  const strongLabelEn = es.magnitude;

  // Direction word bound into the diagnostic text so readers cannot misread
  // green ✓ as "good for v2" when it actually means "v1 is significantly
  // cheaper / faster / higher-quality". Each metric uses its own natural verb.
  const winnerPhrase = winner
    ? (lang === 'zh'
        ? `${winner} 显著${cfg.winnerWordZh}`
        : `${winner} significantly ${cfg.winnerWordEn.replace(' by', '')}`)
    : '';

  if (metric.significant && isStrong) {
    return {
      icon: '✓',
      text: lang === 'zh'
        ? `${winnerPhrase}（${strongLabelZh}差异）`
        : `${winnerPhrase} (${strongLabelEn} effect)`,
      color: 'var(--green)',
    };
  }
  if (metric.significant && !isStrong) {
    return {
      icon: '⚠',
      text: lang === 'zh'
        ? '统计显著但效应微弱，别过度解读'
        : 'significant but effect is trivial — do not overinterpret',
      color: 'var(--yellow)',
    };
  }
  if (!metric.significant && isStrong) {
    const leadPhrase = winner
      ? (lang === 'zh'
          ? `${winner} 看似${cfg.winnerWordZh}但用例不足，建议加大 --repeat`
          : `${winner} looks ${cfg.winnerWordEn.replace(' by', '')} but underpowered — increase --repeat`)
      : (lang === 'zh'
          ? `${strongLabelZh}差异但用例不足，建议加大 --repeat`
          : `${strongLabelEn} effect but underpowered — increase --repeat`);
    return {
      icon: '⚠',
      text: leadPhrase,
      color: 'var(--yellow)',
    };
  }
  return {
    icon: '—',
    text: lang === 'zh' ? '两变体相当，无实质差异' : 'no meaningful difference',
    color: 'var(--text-muted)',
  };
}

// Metric-aware formatting config.
// - `higherIsBetter` drives which variant wins for a given sign of meanDiff.
// - `winnerWord` is the natural-language verb shown next to the winner.
// - `showRawEffectSize` is false for metrics where Cohen's d / Hedges' g are
//   technically computable but uninformative (deterministic raw-unit metrics
//   where within-group variance is trivial, making d always astronomical).
//   In that case we show only the magnitude label + n, not the raw numbers.
// - `showPercent` controls whether the gap cell shows a "X% cheaper/faster"
//   relative difference as a second detail line.
// Display-only fields shared by both metric and layer rows. Extracted so the
// layer-breakdown sub-table can reuse `buildMetricRowCells` without widening
// the MetricDisplayConfig.key union (layer keys live in their own namespace).
interface BaseDisplayConfig {
  labelZh: string;
  labelEn: string;
  higherIsBetter: boolean;
  winnerWordZh: string;
  winnerWordEn: string;
  formatValue: (v: number) => string;
  showRawEffectSize: boolean;
  showPercent: boolean;
  percentWordZh: string;
  percentWordEn: string;
}

interface MetricDisplayConfig extends BaseDisplayConfig {
  // 'composite' 指 VarianceComparison 顶层 flat 字段(事实/行为/LLM 评价三层合成分),
  // 在方差与显著性表里作为"整体"对比行。和 VarianceLayerKey 的 'fact'/'behavior'/'judge'
  // 是不同层次:三层是 byLayer 独立拆开,composite 是三层平均。两者并存不冲突。
  key: 'composite' | 'cost' | 'efficiency';
}

// Three-layer breakdown labels (PR-2). Rendered inside the expandable
// `<details>` beneath each comparison; composite still lives on the top table.
// UI 命名:事实 / 行为 / LLM 评价(字段 judge)——前两层规则验证,第三层 LLM 主观评分。
const LAYER_LABELS: Record<VarianceLayerKey, { zh: string; en: string }> = {
  fact: { zh: '事实', en: 'Fact' },
  behavior: { zh: '行为', en: 'Behavior' },
  judge: { zh: 'LLM 评价', en: 'LLM judge' },
};

const METRIC_CONFIGS: MetricDisplayConfig[] = [
  {
    key: 'composite',
    labelZh: '质量',
    labelEn: 'Quality',
    higherIsBetter: true,
    winnerWordZh: '胜出',
    winnerWordEn: 'wins by',
    formatValue: (v) => `${v.toFixed(2)} 分`,
    showRawEffectSize: true,
    showPercent: true,
    percentWordZh: '高',
    percentWordEn: 'higher',
  },
  {
    key: 'cost',
    labelZh: '成本',
    labelEn: 'Cost',
    higherIsBetter: false,
    winnerWordZh: '更便宜',
    winnerWordEn: 'cheaper by',
    formatValue: (v) => `$${v.toFixed(4)}`,
    showRawEffectSize: true,
    showPercent: true,
    percentWordZh: '便宜',
    percentWordEn: 'cheaper',
  },
  {
    key: 'efficiency',
    labelZh: '效率',
    labelEn: 'Efficiency',
    higherIsBetter: false,
    winnerWordZh: '更快',
    winnerWordEn: 'faster by',
    formatValue: (v) => `${(v / 1000).toFixed(1)}s`,
    showRawEffectSize: true,
    showPercent: true,
    percentWordZh: '快',
    percentWordEn: 'faster',
  },
];

function pickMetricFromComparison(comp: VarianceComparison, key: MetricDisplayConfig['key']): VarianceComparisonMetric | null {
  if (key === 'composite') {
    return {
      meanDiff: comp.meanDiff,
      tStatistic: comp.tStatistic,
      df: comp.df,
      significant: comp.significant,
      effectSize: comp.effectSize,
    };
  }
  return comp.byMetric?.[key] ?? null;
}

function getVariantMetricMean(variance: VarianceData, variant: string, key: MetricDisplayConfig['key']): number | null {
  const v = variance.perVariant[variant];
  if (!v) return null;
  if (key === 'composite') return v.mean;
  return v.byMetric?.[key]?.mean ?? null;
}

export function renderVarianceComparisons(variance: VarianceData | undefined, lang: Lang, layeredStatsOpen = false, summary?: Record<string, VariantSummary>): string {
  if (!variance || !variance.comparisons || variance.comparisons.length === 0) return '';

  // 任一 variant 的 exec 或 judge cost 未报告 → cost 行跳过(显示「—」会跟"持平"难区分,
  // 索性直接不渲染该指标行)。判 cost 列前看 summary,缺 summary 当全 reported 走旧路径。
  const allCostReported = !summary || Object.values(summary).every((v) =>
    v.execCostReported !== false && v.judgeCostReported !== false);

  const modalId = 'guide-variance-comparisons';
  const title = lang === 'zh' ? '方差与显著性' : 'Variance & Significance';
  const guideTitle = lang === 'zh' ? '如何阅读这张表？' : 'How to read this table?';

  const headerLabels = lang === 'zh'
    ? ['对比', '维度', '差距', '效应量', '显著性', '诊断']
    : ['Comparison', 'Metric', 'Gap', 'Effect size', 'Significance', 'Diagnostic'];

  const thead = `<tr>${headerLabels.map((h, i) => {
    const cls = i === 5 ? ' class="diagnostic-cell"' : '';
    return `<th${cls}>${h}</th>`;
  }).join('')}</tr>`;

  const magnitudeZh: Record<string, string> = { negligible: '可忽略', small: '小效应', medium: '中效应', large: '大效应' };
  const magnitudeEn: Record<string, string> = { negligible: 'negligible', small: 'small effect', medium: 'medium effect', large: 'large effect' };

  // Determine the winning variant for a given metric. Returns null if tied.
  function pickWinner(metric: VarianceComparisonMetric, cfg: BaseDisplayConfig, a: string, b: string): string | null {
    const diffAbs = Math.abs(metric.meanDiff);
    if (diffAbs < 1e-9) return null;
    const rawHigherVariant = metric.meanDiff > 0 ? a : b;
    return cfg.higherIsBetter ? rawHigherVariant : (metric.meanDiff > 0 ? b : a);
  }

  function buildMetricRowCells(
    metric: VarianceComparisonMetric,
    cfg: BaseDisplayConfig,
    a: string,
    b: string,
    aMean: number | null,
    bMean: number | null,
    fadeDiagnostic: boolean,
  ): string {
    // Gap cell — metric-aware direction word + optional relative percent
    const winner = pickWinner(metric, cfg, a, b);
    const diffAbs = Math.abs(metric.meanDiff);
    let gapCell: string;
    if (!winner) {
      gapCell = `<div class="verdict-line">${lang === 'zh' ? '持平' : 'tied'}</div>`;
    } else {
      const winnerWord = lang === 'zh' ? cfg.winnerWordZh : cfg.winnerWordEn;

      const detailParts: string[] = [cfg.formatValue(diffAbs)];
      if (cfg.showPercent && aMean != null && bMean != null) {
        const denom = Math.max(Math.abs(aMean), Math.abs(bMean));
        if (denom > 0) {
          const pct = (diffAbs / denom) * 100;
          const pctWord = lang === 'zh' ? cfg.percentWordZh : cfg.percentWordEn;
          detailParts.push(lang === 'zh' ? `${pctWord} ${pct.toFixed(0)}%` : `${pct.toFixed(0)}% ${pctWord}`);
        }
      }

      gapCell = `
        <div class="verdict-line"><strong>${e(winner)}</strong> ${winnerWord}</div>
        <div class="detail-line">${detailParts.join(' · ')}</div>`;
    }

    // Effect size cell
    const es = metric.effectSize;
    let esCell: string;
    if (!es || es.primary === 'none') {
      esCell = `<div class="verdict-line">${lang === 'zh' ? '数据不足' : 'insufficient data'}</div>`;
    } else {
      const magnitudeLabel = (lang === 'zh' ? magnitudeZh : magnitudeEn)[es.magnitude] || es.magnitude;
      const detail = cfg.showRawEffectSize
        ? `g=${Math.abs(es.hedgesG).toFixed(2)} · d=${Math.abs(es.cohensD).toFixed(2)} · n=${es.n1}+${es.n2}`
        : `n=${es.n1}+${es.n2}`;
      esCell = `
        <div class="verdict-line">${magnitudeLabel}</div>
        <div class="detail-line">${detail}</div>`;
    }

    // Significance cell — uniform binary verdict. Both sides just say
    // "显著" or "不显著"; the p-value bucket is shown in the detail line
    // so readers can distinguish "barely significant" from "strongly significant".
    const sigText = metric.significant
      ? (lang === 'zh' ? '显著' : 'significant')
      : (lang === 'zh' ? '不显著' : 'not significant');
    const pBucket = pValueCategory(metric.tStatistic, metric.df);
    const sigCell = `
      <div class="verdict-line">${sigText}</div>
      <div class="detail-line">p${pBucket} · t=${metric.tStatistic.toFixed(2)} · df=${metric.df}</div>`;

    // Diagnostic cell: colored icon + bold colored text with direction bound in.
    // Visually fade if this diagnostic text is a consecutive duplicate of the row above.
    const diag = buildDiagnostic(metric, cfg, winner, lang);
    const fadeClass = fadeDiagnostic ? ' diag-faded' : '';
    // inline-flex so the td's text-align:center centers the icon+text unit as
    // a whole (a plain flex div would stretch to fill the cell and align left).
    const diagCell = `
      <div class="diag-cell${fadeClass}" style="display:inline-flex;align-items:center;gap:6px;line-height:1.5;text-align:left">
        <span style="color:${diag.color};font-size:14px;flex-shrink:0">${diag.icon}</span>
        <strong style="color:${diag.color}">${diag.text}</strong>
      </div>`;

    const metricLabel = lang === 'zh' ? cfg.labelZh : cfg.labelEn;
    return `
      <td class="verdict-line">${metricLabel}</td>
      <td>${gapCell}</td>
      <td>${esCell}</td>
      <td>${sigCell}</td>
      <td class="diagnostic-cell">${diagCell}</td>`;
  }

  // Per-layer display config — same shape as composite quality, just re-labeled.
  // Composite rows live in METRIC_CONFIGS (the outer variance table); layer rows
  // live inside an expandable <details> and only render when byLayer data exists.
  function layerCfg(key: VarianceLayerKey): BaseDisplayConfig {
    const labels = LAYER_LABELS[key];
    return {
      labelZh: labels.zh,
      labelEn: labels.en,
      higherIsBetter: true,
      winnerWordZh: '胜出',
      winnerWordEn: 'wins by',
      formatValue: (v: number) => lang === 'zh' ? `${v.toFixed(2)} 分` : `${v.toFixed(2)} pts`,
      showRawEffectSize: true,
      showPercent: true,
      percentWordZh: '高',
      percentWordEn: 'higher',
    };
  }

  function renderLayerBreakdown(comp: VarianceComparison): string {
    if (!comp.byLayer || Object.keys(comp.byLayer).length === 0) return '';
    const layerRows = (['fact', 'behavior', 'judge'] as const).map((key) => {
      const m = comp.byLayer?.[key];
      if (!m) return '';
      const aMean = variance!.perVariant[comp.a]?.byLayer?.[key]?.mean ?? null;
      const bMean = variance!.perVariant[comp.b]?.byLayer?.[key]?.mean ?? null;
      const cfg = layerCfg(key);
      return `<tr>${buildMetricRowCells(m, cfg, comp.a, comp.b, aMean, bMean, false)}</tr>`;
    }).filter(Boolean).join('');
    if (!layerRows) return '';
    const summaryLabel = lang === 'zh'
      ? '展开三层独立显著性（fact / behavior / judge）'
      : 'Show three-layer independent significance (fact / behavior / judge)';
    const openAttr = layeredStatsOpen ? ' open' : '';
    // 多重比较 disclaimer:三层独立 t 检验,family-wise error 未矫正;小样本下 Cohen's d 不稳(stats 术语,见 terminology-spec §6 例外)。
    // 不默默修改 significant 判定(避免用户被"自动矫正"误导),而是把判读责任明示交给读者。
    const disclaimerText = lang === 'zh'
      ? '⚠ 三层独立检验:p 值未做多重比较矫正(建议按 Bonferroni α/3 = 0.017 判断显著);小样本(n ≤ 10)下 Cohen\'s d 效应量标签仅供探索参考,不作结论'
      : '⚠ Three independent tests: p values are NOT corrected for multiple comparisons (use Bonferroni α/3 = 0.017 as the stricter threshold). With small samples (n ≤ 10), Cohen\'s d magnitude labels are exploratory only';
    return `
      <tr class="layer-breakdown-row">
        <td colspan="6">
          <details class="layer-breakdown"${openAttr}>
            <summary>${e(summaryLabel)}</summary>
            <div class="layer-breakdown-disclaimer">${e(disclaimerText)}</div>
            <table class="summary-table variance-table layer-sub-table">
              <tbody>${layerRows}</tbody>
            </table>
          </details>
        </td>
      </tr>`;
  }

  const rows = variance.comparisons.map((comp) => {
    // Collect available metric rows for this comparison
    const availableMetrics: Array<{ cfg: MetricDisplayConfig; metric: VarianceComparisonMetric }> = [];
    for (const cfg of METRIC_CONFIGS) {
      // cost 行:任一 variant 不报 cost 时跳过(数据是占位 0,显示"持平"误导)
      if (cfg.key === 'cost' && !allCostReported) continue;
      const m = pickMetricFromComparison(comp, cfg.key);
      if (m) availableMetrics.push({ cfg, metric: m });
    }
    if (availableMetrics.length === 0) return '';

    const rowspan = availableMetrics.length;
    const comparisonCell = `<td rowspan="${rowspan}" class="verdict-line comparison-cell"><strong>${e(comp.a)}</strong> <span style="color:var(--text-muted)">vs</span> <strong>${e(comp.b)}</strong></td>`;

    // Build all metric rows first so we can detect consecutive duplicate diagnostics
    // (for visual fade), then emit.
    const preBuilt = availableMetrics.map((row) => {
      const winner = pickWinner(row.metric, row.cfg, comp.a, comp.b);
      const diag = buildDiagnostic(row.metric, row.cfg, winner, lang);
      return { ...row, diagText: `${diag.icon}|${diag.text}` };
    });
    let prevDiagKey = '';
    const mainRows = preBuilt.map((row, idx) => {
      const lead = idx === 0 ? comparisonCell : '';
      const aMean = getVariantMetricMean(variance!, comp.a, row.cfg.key);
      const bMean = getVariantMetricMean(variance!, comp.b, row.cfg.key);
      const fade = idx > 0 && row.diagText === prevDiagKey;
      prevDiagKey = row.diagText;
      return `<tr>${lead}${buildMetricRowCells(row.metric, row.cfg, comp.a, comp.b, aMean, bMean, fade)}</tr>`;
    }).join('');

    return mainRows + renderLayerBreakdown(comp);
  }).join('');

  // Glossary rows — structured data instead of a giant HTML string.
  // Each "row" is either a top-level term or a sub-item under the previous term.
  interface GlossaryRow { label: string; desc: string; sub?: boolean }
  const glossaryZh: GlossaryRow[] = [
    { label: '差距', desc: '跨轮均值胜出者 + 绝对差值（原始单位）' },
    { label: '效应量', desc: '差距相对标准差的倍数。阈值：0.2=小 / 0.5=中 / 0.8=大' },
    { label: "Hedges' g", desc: '小样本修正版（统计术语）；n1+n2<20 时优先参考', sub: true },
    { label: "Cohen's d", desc: '未修正版，n1+n2≥20 时是学术惯例', sub: true },
    { label: '显著性', desc: 't 检验结论，基于 p<0.05 阈值。回答"差异真不真"，和效应量"差多大"互补' },
    { label: 'p 值', desc: '假设真的没差异时，观察到当前差距的概率。越小越可信。0.05 只是约定阈值', sub: true },
    { label: 't 值', desc: '均值差 ÷ 估计误差，需配合 df 和效应量解读，不能单独看', sub: true },
    { label: 'df 自由度', desc: '≈"有效评测用例数"。--repeat 3 时通常 2~4；想达到 20+ 需 --repeat 10+', sub: true },
  ];
  const glossaryEn: GlossaryRow[] = [
    { label: 'Gap', desc: 'Cross-run mean winner + absolute difference (raw units)' },
    { label: 'Effect size', desc: 'Gap measured in standard deviations. Thresholds: 0.2=small / 0.5=medium / 0.8=large' },
    { label: "Hedges' g", desc: 'Small-sample corrected; preferred when n1+n2<20', sub: true },
    { label: "Cohen's d", desc: 'Uncorrected; conventional when n1+n2≥20', sub: true },
    { label: 'Significance', desc: 't-test verdict based on p<0.05 threshold. Complements effect size ("how real" vs "how big")' },
    { label: 'p value', desc: 'Probability of seeing the current gap if variants were truly identical. Smaller = more confident. 0.05 is a convention', sub: true },
    { label: 't value', desc: 'Mean diff ÷ estimated error. Must be read alongside df and effect size', sub: true },
    { label: 'df', desc: '≈"effective sample size". --repeat 3 usually lands at 2~4; df 20+ needs --repeat 10+', sub: true },
  ];
  const glossaryRows = lang === 'zh' ? glossaryZh : glossaryEn;
  const glossaryHtml = glossaryRows.map((r) => {
    if (r.sub) {
      return `<div class="modal-glossary-sub"><div class="modal-glossary-sub-label">${e(r.label)}</div><div class="modal-glossary-sub-desc">${e(r.desc)}</div></div>`;
    }
    return `<div class="modal-glossary-row"><div class="modal-glossary-label">${e(r.label)}</div><div class="modal-glossary-desc">${e(r.desc)}</div></div>`;
  }).join('');

  // Four-quadrant diagnostic rules, rendered as card rows matching the table's
  // "icon + text" visual language instead of colored table text.
  interface DiagRule { variant: 'good' | 'warn' | 'neutral'; icon: string; title: string; desc: string; example: string }
  const diagRulesZhData: DiagRule[] = [
    { variant: 'good', icon: '✓', title: '显著差异（中/大效应）', desc: '差异真实且有实际意义，可作为结论', example: '示例：v1 更便宜 · 显著 · g=1.04' },
    { variant: 'warn', icon: '⚠', title: '显著但效应微弱', desc: '差异真实但太小没实际价值，别过度解读', example: '示例：p<0.05 但 g≈0.1（--repeat 很大时易出现）' },
    { variant: 'warn', icon: '⚠', title: '大效应但用例不足', desc: '差距看似大但用例太少，建议加大 --repeat 再判断', example: '示例：v2 胜出 0.30 · g=1.04 · 不显著' },
    { variant: 'neutral', icon: '—', title: '两变体相当', desc: '既不显著也效应微弱，可视为无差异', example: '示例：Δ≈0 · 不显著 · g<0.2' },
  ];
  const diagRulesEnData: DiagRule[] = [
    { variant: 'good', icon: '✓', title: 'Significant, medium/large effect', desc: 'Real and meaningful — acceptable as a conclusion', example: 'e.g. v1 cheaper · significant · g=1.04' },
    { variant: 'warn', icon: '⚠', title: 'Significant but trivial effect', desc: 'Real but tiny — do not overinterpret', example: 'e.g. p<0.05 but g≈0.1 (common with large --repeat)' },
    { variant: 'warn', icon: '⚠', title: 'Large effect but underpowered', desc: 'Gap looks real but sample is too small — increase --repeat', example: 'e.g. v2 leads by 0.30 · g=1.04 · not significant' },
    { variant: 'neutral', icon: '—', title: 'No meaningful difference', desc: 'Neither significant nor large — treat as equivalent', example: 'e.g. Δ≈0 · not significant · g<0.2' },
  ];
  const diagRulesData = lang === 'zh' ? diagRulesZhData : diagRulesEnData;
  const diagRulesHtml = diagRulesData.map((rule) => `
    <div class="diag-rule-row rule-${rule.variant}">
      <span class="diag-rule-icon rule-${rule.variant}">${rule.icon}</span>
      <div class="diag-rule-body">
        <div class="diag-rule-title">${e(rule.title)}</div>
        <div class="diag-rule-desc">${e(rule.desc)}</div>
        <div class="diag-rule-example">${e(rule.example)}</div>
      </div>
    </div>`).join('');

  const orderHint = lang === 'zh' ? '以下按表格列顺序排列' : 'Below follows the table column order';
  const sectionTitle = lang === 'zh' ? '四象限诊断规则' : 'Four-quadrant diagnostic rules';
  const closeLabel = lang === 'zh' ? '关闭' : 'Close';

  return `
    <section style="margin-top:24px">
      <h2 style="display:flex;align-items:center;gap:4px">${title} <button type="button" class="hint-btn" onclick="openModal('${modalId}')" aria-label="${e(guideTitle)}" aria-haspopup="dialog">?</button></h2>
      <div id="${modalId}" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${modalId}-title" onclick="if(event.target===this)closeModal('${modalId}')">
        <div class="modal-content">
          <div class="modal-header">
            <strong id="${modalId}-title" style="font-size:1rem">${e(guideTitle)}</strong>
            <button type="button" class="modal-close" onclick="closeModal('${modalId}')" aria-label="${closeLabel}">✕</button>
          </div>
          <p class="modal-glossary-hint">${e(orderHint)}</p>
          <div class="modal-glossary">${glossaryHtml}</div>
          <div class="modal-section">
            <div class="modal-section-title">${e(sectionTitle)}</div>
            <div class="diag-rules">${diagRulesHtml}</div>
          </div>
        </div>
      </div>
      <div class="table-wrap">
        <table class="summary-table variance-table">
          <thead>${thead}</thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

const CONCLUSION_TYPES = new Set([
  'efficiency_gap', 'tool_count_gap', 'high_cost_sample',
]);

function isConclusion(insight: Insight): boolean {
  return CONCLUSION_TYPES.has(insight.type);
}

function severityDot(severity: string): string {
  const color: Record<string, string> = {
    error: 'var(--red)',
    warning: 'var(--yellow)',
    info: 'var(--accent)',
  };
  return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color[severity] || 'var(--text-muted)'};margin-right:8px;flex-shrink:0;margin-top:6px"></span>`;
}

function renderSummaryStructured(summary: string, lang: Lang): string {
  const markerRegex = /【([^】]+)】/g;
  const markers: Array<{ label: string; start: number; contentStart: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = markerRegex.exec(summary)) !== null) {
    markers.push({ label: match[1], start: match.index, contentStart: match.index + match[0].length });
  }

  const sections: Array<{ label: string; content: string }> = [];
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? markers[i + 1].start : summary.length;
    sections.push({ label: markers[i].label, content: summary.slice(markers[i].contentStart, end).trim() });
  }

  if (sections.length === 0) {
    return `<div style="padding:14px 18px;font-size:13px;line-height:1.8;color:var(--text-secondary);background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">${e(summary)}</div>`;
  }

  const labelMap: Record<string, Record<Lang, string>> = {
    结论: { zh: '结论', en: 'Conclusion' },
    Conclusion: { zh: '结论', en: 'Conclusion' },
    '关键差异': { zh: '关键差异', en: 'Key differences' },
    'Key differences': { zh: '关键差异', en: 'Key differences' },
    综合洞察: { zh: '综合洞察', en: 'Synthesis' },
    Synthesis: { zh: '综合洞察', en: 'Synthesis' },
  };
  const sectionHtml = sections.map((section) => `
      <div style="display:flex;gap:12px;align-items:baseline">
        <span style="flex-shrink:0;font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.03em;min-width:56px">${e(labelMap[section.label]?.[lang] || section.label)}</span>
        <span style="color:var(--text-secondary);font-size:13px;line-height:1.7">${e(section.content)}</span>
      </div>`).join('');

  return `
    <div style="padding:14px 18px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      ${sectionHtml}
    </div>`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function localizedInsightMessage(insight: Insight, report: Report | undefined, lang: Lang): string {
  const details = asRecord(insight.details);
  const detailItems = asArray(insight.details);
  const totalSamples = report?.results?.length || detailItems.length || num(details.total) || 0;
  const type = insight.type;

  switch (type) {
    case 'low_discrimination_all_passed': {
      const count = detailItems.length;
      return lang === 'zh'
        ? `${count} 个断言所有变体均通过，区分度低`
        : `${count} assertions passed for every variant, so they have low discrimination power`;
    }
    case 'low_discrimination_all_failed': {
      const count = detailItems.length;
      return lang === 'zh'
        ? `${count} 个断言所有变体均失败，断言可能过严或配置有误`
        : `${count} assertions failed for every variant; they may be too strict or misconfigured`;
    }
    case 'uniform_scores': {
      const count = detailItems.length;
      return lang === 'zh'
        ? `${count}/${totalSamples} 个评测用例在变体间分差 < 0.5，区分度较低`
        : `${count}/${totalSamples} samples differ by less than 0.5 across variants, so they have low discrimination power`;
    }
    case 'all_pass':
      return lang === 'zh'
        ? '所有断言在所有变体上全部通过，断言可能过于宽松'
        : 'All assertions passed for all variants; the assertions may be too loose';
    case 'all_fail':
      return lang === 'zh'
        ? '所有断言在所有变体上全部失败，请检查断言配置'
        : 'All assertions failed for all variants; check the assertion configuration';
    case 'suggest_repeat': {
      const variant = String(details.variant || 'variant');
      const min = num(details.min);
      const max = num(details.max);
      const range = min != null && max != null ? `${min}~${max}` : '';
      return lang === 'zh'
        ? `${variant} 的分数跨度较大${range ? `（${range}）` : ''}，建议使用 --repeat 多轮评测`
        : `${variant} has a wide score range${range ? ` (${range})` : ''}; run with --repeat to measure variance`;
    }
    case 'low_tool_success_rate': {
      const variant = String(details.variant || 'variant');
      const rate = num(details.toolSuccessRate);
      const pct = rate != null ? `${(rate * 100).toFixed(0)}%` : 'low';
      return lang === 'zh'
        ? `${variant} 的工具调用成功率仅 ${pct}，可能存在工具选择或参数问题`
        : `${variant} has only ${pct} tool-call success, which may indicate tool-selection or parameter issues`;
    }
    case 'tool_permission_error': {
      const count = detailItems.length;
      return lang === 'zh'
        ? `检测到 ${count} 次工具权限错误，实验结论可能被环境问题污染`
        : `${count} tool permission errors were detected; the conclusion may be contaminated by environment issues`;
    }
    case 'trace_integrity_gap': {
      const count = detailItems.length;
      return lang === 'zh'
        ? `${count} 个 variant 的 trace 覆盖率低于 75%，报告可能不足以解释 agent 行为差异`
        : `${count} variants have trace coverage below 75%, so the report may not fully explain agent behavior differences`;
    }
    case 'agent_assertion_discrimination_low': {
      const total = num(details.total) || 0;
      const discriminative = num(details.discriminative) || 0;
      const pct = total > 0 ? Math.round((discriminative / total) * 100) : 0;
      return lang === 'zh'
        ? `agent 断言区分度偏低，只有 ${pct}% 的断言真正拉开了变体差异`
        : `Agent assertion discrimination is low; only ${pct}% of assertions separate variants`;
    }
    case 'agent_assertion_discrimination_ok': {
      const total = num(details.total) || 0;
      const discriminative = num(details.discriminative) || 0;
      const pct = total > 0 ? Math.round((discriminative / total) * 100) : 0;
      return lang === 'zh'
        ? `agent 断言区分度达标，${pct}% 的断言能区分变体差异`
        : `Agent assertion discrimination is healthy; ${pct}% of assertions separate variants`;
    }
    case 'efficiency_gap': {
      const variant = String(details.variant || 'variant');
      const baseline = String(details.baseline || 'baseline');
      return lang === 'zh'
        ? `${variant} 与 ${baseline} 在效率维度存在明显差异`
        : `${variant} differs materially from ${baseline} on efficiency`;
    }
    case 'tool_count_gap': {
      const variant = String(details.variant || 'variant');
      const baseline = String(details.baseline || 'baseline');
      const baseTools = num(details.baseTools);
      const otherTools = num(details.otherTools);
      const delta = baseTools != null && otherTools != null ? Math.abs(otherTools - baseTools).toFixed(1) : '';
      return lang === 'zh'
        ? `${variant} 与 ${baseline} 的工具调用次数差异明显${delta ? `（差 ${delta} 次）` : ''}`
        : `${variant} differs materially from ${baseline} in tool-call count${delta ? ` (${delta} calls apart)` : ''}`;
    }
    case 'high_cost_sample': {
      const count = detailItems.length;
      return lang === 'zh'
        ? `${count} 个评测用例成本显著高于平均值`
        : `${count} samples cost materially more than average`;
    }
    default:
      return lang === 'zh'
        ? `结构化诊断：${type}`
        : `Structured diagnostic: ${type}`;
  }
}

function localizedSuggestion(insight: Insight, lang: Lang): string {
  switch (insight.type) {
    case 'low_discrimination_all_passed':
      return lang === 'zh'
        ? '把全通过断言替换为能检测 skill 独有细节的断言，例如特定参数名、配置值或流程要求'
        : 'Replace always-passing assertions with checks for artifact-specific details, such as parameter names, config values, or workflow requirements';
    case 'low_discrimination_all_failed':
      return lang === 'zh'
        ? '检查断言条件是否正确，或降低匹配要求，避免 broken 用例污染结论'
        : 'Check whether the assertion condition is correct, or relax the matcher to avoid broken samples contaminating the conclusion';
    case 'uniform_scores':
      return lang === 'zh'
        ? '增加更有挑战性的评测用例，或把 rubric 写得更能区分优劣'
        : 'Add more challenging samples, or make the rubric more discriminative';
    case 'all_pass':
      return lang === 'zh'
        ? '增加更严格的断言来区分不同变体的质量'
        : 'Add stricter assertions that can distinguish variant quality';
    case 'all_fail':
      return lang === 'zh'
        ? '优先检查评测配置和断言目标，确认用例不是整体不可达'
        : 'Check the evaluation config and assertion target first; make sure the sample is reachable';
    case 'suggest_repeat':
      return lang === 'zh'
        ? '使用 --repeat 3 或更多轮次获取方差、置信区间和显著性检验'
        : 'Run with --repeat 3 or more to obtain variance, confidence intervals, and significance tests';
    case 'low_tool_success_rate':
      return lang === 'zh'
        ? '检查失败工具调用，必要时在 skill 中补充工具选择和参数约束'
        : 'Inspect failed tool calls and, if needed, add tool-selection and parameter guidance to the artifact';
    case 'tool_permission_error':
      return lang === 'zh'
        ? '先解决工具权限或工作目录问题，再解读分数差异'
        : 'Fix tool permission or working-directory issues before interpreting score differences';
    case 'trace_integrity_gap':
      return lang === 'zh'
        ? '补齐 turns、toolCalls、timing 和完整输出采集，确保报告能解释行为差异'
        : 'Capture turns, tool calls, timing, and full output so the report can explain behavior differences';
    case 'agent_assertion_discrimination_low':
      return lang === 'zh'
        ? '重写 agent 断言时优先约束工具路径、关键文件读取和 turns 上限'
        : 'When rewriting agent assertions, prioritize tool path, key file reads, and turn-limit constraints';
    default:
      return lang === 'zh'
        ? '查看结构化 details 字段定位原因'
        : 'Inspect the structured details field for the underlying evidence';
  }
}

export function renderAnalysis(report: Report | undefined, lang: Lang): string {
  const analysis = report?.analysis;
  if (!analysis) return '';
  const { insights } = analysis;
  if ((!insights || insights.length === 0) && !report) return '';

  const issues = (insights || []).filter((insight) => !isConclusion(insight));
  const issueLabel = lang === 'zh' ? '问题与建议' : 'Issues & Suggestions';
  const safeSuggestions = issues.map((issue) => localizedSuggestion(issue, lang));

  let issuesHtml = '';
  if (issues.length > 0) {
    const maxRows = issues.length;
    const rows: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const issue = issues[i];
      const suggestion = safeSuggestions[i];
      const issueContent = issue
        ? `${severityDot(issue.severity)}<span>${e(localizedInsightMessage(issue, report, lang))}</span>`
        : '';
      const suggestionContent = suggestion
        ? e(suggestion)
        : `<span style="color:var(--text-faint)">—</span>`;

      rows.push(`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:10px 16px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:flex-start;color:var(--text-secondary);font-size:12.5px;line-height:1.6">${issueContent}</div>
          <div style="color:var(--text-muted);font-size:12.5px;line-height:1.6">${suggestionContent}</div>
        </div>`);
    }

    issuesHtml = `
      <div style="margin-top:12px">
        <h3 style="font-size:12px;color:var(--text-muted);font-weight:600;margin:0 0 8px;letter-spacing:0.03em">${issueLabel}</h3>
        <div style="background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:8px 16px;border-bottom:1px solid var(--border)">
            <div style="font-size:11px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${lang === 'zh' ? '问题' : 'Issue'}</div>
            <div style="font-size:11px;font-weight:500;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em">${lang === 'zh' ? '建议' : 'Suggestion'}</div>
          </div>
          ${rows.join('')}
        </div>
      </div>
    `;
  }

  const generatedSummary = report ? generateAnalysisSummary(report, lang) : undefined;
  const summaryHtml = generatedSummary
    ? renderSummaryStructured(generatedSummary, lang)
    : '';

  if (!summaryHtml && !issuesHtml) return '';

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${summaryHtml}
    ${issuesHtml}
  `;
}

export function renderAgentOverview(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  const hasAgentData = variants.some((variant) => summary[variant]?.avgToolCalls != null && summary[variant].avgToolCalls! > 0);
  if (!hasAgentData) return '';

  // v0.30 — Agent 执行概览弱化为 ctx-row(单行 inline)样式,跟实验配置并排放在 context-strip 里。
  // 主要数字:轮次 / 工具调用数 / 成功率,加 tooltip 显示工具分布。
  const variantRows = variants.map((variant, i) => {
    const stats = summary[variant];
    if (!stats) return '';
    const color = COLORS[i % COLORS.length];
    const avgTools = stats.avgToolCalls ?? 0;
    const successRate = stats.toolSuccessRate != null ? `${(stats.toolSuccessRate * 100).toFixed(0)}%` : '—';
    const successRateColor = (stats.toolSuccessRate ?? 1) >= 0.8 ? 'var(--green)' : 'var(--red)';
    const turns = stats.avgFullNumTurns ?? stats.avgNumTurns ?? 0;
    const distributionEntries = Object.entries(stats.toolDistribution || {}).sort((a, b) => b[1] - a[1]);
    const distSummary = distributionEntries.length > 0
      ? distributionEntries.slice(0, 5).map(([tool, count]) => `${tool}×${count}`).join(' · ')
      : '';
    const tooltip = distSummary ? `${t('agentToolDist', lang)}: ${distSummary}` : '';

    return `<div class="ctx-row" style="border-left:3px solid ${color}"${tooltip ? ` title="${e(tooltip)}"` : ''}>
      <span class="ctx-row-name">${e(variant)}</span>
      <span class="ctx-row-bits">
        <span>${turns} ${t('turnsPerReq', lang)}</span>
        <span class="ctx-sep">·</span>
        <span>${avgTools} ${lang === 'zh' ? '工具/次' : 'tools/req'}</span>
        <span class="ctx-sep">·</span>
        <span style="color:${successRateColor}">${successRate} OK</span>
      </span>
    </div>`;
  }).join('');

  return `
    <div class="ctx-block">
      <div class="ctx-h">${t('agentOverview', lang)}</div>
      <div class="ctx-sub">${lang === 'zh' ? '工具调用统计 · 轮次 / 调用数 / 成功率' : 'Tool call stats · turns / calls / success rate'}</div>
      <div class="ctx-rows">${variantRows}</div>
    </div>
  `;
}

export function renderCoverageSection(coverage: Record<string, KnowledgeCoverage> | undefined, lang: Lang): string {
  if (!coverage || Object.keys(coverage).length === 0) return '';

  const variantSections = Object.entries(coverage).map(([variant, knowledgeCoverage]) => {
    if (knowledgeCoverage.filesTotal === 0) return '';

    const pct = Math.round(knowledgeCoverage.fileCoverageRate * 100);
    const pctColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
    const barW = Math.max(2, pct);

    const fileRows = knowledgeCoverage.entries
      .sort((a, b) => (a.accessed === b.accessed ? 0 : a.accessed ? -1 : 1))
      .map((entry) => {
        const icon = entry.accessed ? '✓' : '✗';
        const color = entry.accessed ? 'var(--green)' : 'var(--text-muted)';
        const countBadge = entry.accessCount > 1
          ? `<span style="font-size:10px;color:var(--accent);margin-left:4px">×${entry.accessCount}</span>`
          : '';
        const lines = entry.lineCount ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px">${entry.lineCount}L</span>` : '';
        const typeTag = `<span style="font-size:10px;padding:1px 4px;border-radius:2px;background:var(--bg-surface);color:var(--text-muted);margin-left:4px">${e(entry.type)}</span>`;
        return `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px">
          <span style="color:${color};width:16px;text-align:center">${icon}</span>
          <span style="color:${entry.accessed ? 'var(--text-primary)' : 'var(--text-muted)'};${entry.accessed ? '' : 'text-decoration:line-through;opacity:0.6'}">${e(entry.path)}</span>
          ${typeTag}${lines}${countBadge}
        </div>`;
      }).join('');

    const uncoveredByType: Record<string, string[]> = {};
    for (const entry of knowledgeCoverage.entries.filter((item) => !item.accessed)) {
      const category = entry.path.startsWith('repos/') ? 'code' : entry.type;
      (uncoveredByType[category] = uncoveredByType[category] || []).push(entry.path);
    }
    const hintLines: string[] = [];
    const typeLabels: Record<string, string> = lang === 'zh'
      ? { principle: '原则文件', semantic: '语义索引', design: '设计文档', code: '代码路径', script: '脚本工具', other: '其他知识' }
      : { principle: 'Principles', semantic: 'Semantic index', design: 'Design docs', code: 'Code paths', script: 'Scripts', other: 'Other' };
    for (const [type, files] of Object.entries(uncoveredByType)) {
      const label = typeLabels[type] || type;
      hintLines.push(`<strong>${label}</strong>（${files.length}）：${files.slice(0, 3).map((file) => `<code>${e(file)}</code>`).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`);
    }
    const uncoveredHint = hintLines.length > 0
      ? `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
          <div style="margin-bottom:4px">${lang === 'zh' ? '💡 以下知识未被任何用例覆盖,建议补充评测用例:' : '💡 These knowledge files were not accessed by any sample — consider adding test cases:'}</div>
          ${hintLines.map((line) => `<div style="margin:2px 0">${line}</div>`).join('')}
        </div>`
      : '';

    return `<div style="flex:1;min-width:280px;padding:16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <strong>${e(variant)}</strong>
        <span style="font-size:20px;font-weight:600;color:${pctColor}">${pct}%</span>
      </div>
      <div style="height:8px;background:var(--bg-card);border-radius:4px;margin-bottom:8px">
        <div style="width:${barW}%;height:100%;background:${pctColor};border-radius:4px"></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${knowledgeCoverage.filesCovered}/${knowledgeCoverage.filesTotal} ${lang === 'zh' ? '个文件被访问' : 'files accessed'} · ${knowledgeCoverage.grepPatternsUsed} ${lang === 'zh' ? '次搜索' : 'searches'}</div>
      ${fileRows}
      ${uncoveredHint}
    </div>`;
  }).join('');

  const title = lang === 'zh' ? '本次测评的知识使用情况' : 'Knowledge usage in this evaluation';
  const desc = lang === 'zh'
    ? '本次测评中，哪些知识没有被使用。数字低说明评测用例没覆盖到的角落多，不是知识库内容缺失——配合下方"本次测评的知识盲区"一起看才完整。'
    : 'Which knowledge files were NOT exercised by this evaluation. Low coverage means test cases leave KB corners untouched, not that the KB is incomplete. Pair with "knowledge gaps" below for the full picture.';

  return `
    <section style="margin-top:24px">
      <h2>${title}</h2>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:12px">${desc}</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${variantSections}
      </div>
    </section>
  `;
}

/**
 * Render the knowledge gap section: per-variant gap rate + mandatory test set
 * watermark + signal classification + inventory of individual signals.
 * See docs/specs/knowledge-gap-signal-spec.md for the semantics.
 */
/**
 * Combined knowledge-interaction section: coverage + gap side-by-side per variant.
 *
 * v0.17 起替代原独立的 renderCoverageSection + renderGapSection。两者都是"测评集
 * × 知识库交互"的产物(spec §二),分开展示会让读者只看一个指标得出误判结论。合并后
 * 每个 variant 一张 card,左右两栏并排展示"用了多少"vs"撞了多少",形成完整诊断画像。
 */
export function renderKnowledgeInteractionSection(
  coverage: Record<string, KnowledgeCoverage> | undefined,
  gapReports: Record<string, GapReport> | undefined,
  lang: Lang,
): string {
  const hasCov = coverage && Object.keys(coverage).length > 0;
  const hasGap = gapReports && Object.keys(gapReports).length > 0;
  if (!hasCov && !hasGap) return '';

  // 所有 variant 的 coverage 都不可用 (filesTotal === 0) 且所有 gap 都是 0%(无信号)
  // 时,整个 section 没有可读信息 — 渲染只会占大段纵向空间显示「数据不可用 / 0%」
  // 干扰用户阅读流。直接跳过比强行展示「显式无信号」更尊重读者。
  const usefulCoverage = hasCov && Object.values(coverage!).some((c) => c.filesTotal > 0);
  const usefulGap = hasGap && Object.values(gapReports!).some((g) => g.gapRate > 0 || g.signals.length > 0);
  if (!usefulCoverage && !usefulGap) return '';

  const title = lang === 'zh' ? '本次测评：评测用例 × 知识库' : 'This Evaluation: Test Set × Knowledge Base';
  const desc = lang === 'zh'
    ? '展示本次评测用例和知识库的交互画像——用到哪些知识（使用情况）· 哪些知识想找但没找到或任务执行模型表达不确定（盲区）。'
    : 'How this test set interacts with the KB — which knowledge was exercised (usage) · which knowledge the task execution model missed or flagged as uncertain (gaps).';
  const readHint = lang === 'zh'
    ? '💡 读表：两者同时高 → 知识库内容有问题（有文件但答不出）· 同时低 → 评测用例太浅（没触到复杂场景）· 使用高 + 盲区低 → 理想但警惕用例驯化'
    : '💡 Read together: both high → KB content issues (files exist but can\'t answer) · both low → test set too shallow · high use + low gap → ideal, but beware sample-set overfitting';

  // 聚合所有 variant(coverage / gap 任一侧存在即纳入)
  const allVariants = Array.from(new Set<string>([
    ...(hasCov ? Object.keys(coverage!) : []),
    ...(hasGap ? Object.keys(gapReports!) : []),
  ]));

  const signalTypeLabels: Record<GapSignalRef['type'], { zh: string; en: string }> = {
    failed_search: { zh: '搜索未命中', en: 'Search miss' },
    explicit_marker: { zh: '任务执行模型标记缺口', en: 'Execution model flag' },
    hedging: { zh: '表达不确定', en: 'Hedging' },
    repeated_failure: { zh: '反复未命中', en: 'Repeated miss' },
  };
  const pickSignalLabel = (key: GapSignalRef['type']): string => signalTypeLabels[key][lang === 'zh' ? 'zh' : 'en'];
  // severity 按 SIGNAL_WEIGHTS 映射:strong (weight 1.0) → 红色 · weak (0.5) → 灰/黄
  const signalSeverity: Record<GapSignalRef['type'], 'strong' | 'medium' | 'weak'> = {
    failed_search: 'strong',
    repeated_failure: 'strong',
    explicit_marker: 'medium',
    hedging: 'weak',
  };

  const cards = allVariants.map((variant, i) => {
    const cov = coverage?.[variant];
    const gap = gapReports?.[variant];
    const variantColor = COLORS[i % COLORS.length];

    // ─── 左栏:知识使用(coverage)────────────────────────
    let covInner = '';
    if (cov && cov.filesTotal > 0) {
      const pct = Math.round(cov.fileCoverageRate * 100);
      const pctColor = pct >= 80 ? 'var(--green)' : pct >= 50 ? 'var(--yellow)' : 'var(--red)';
      const barW = Math.max(2, pct);
      const barLabel = lang === 'zh' ? '知识使用' : 'Knowledge used';
      const fileRows = cov.entries
        .slice()
        .sort((a, b) => (a.accessed === b.accessed ? 0 : a.accessed ? -1 : 1))
        .map((entry) => {
          const icon = entry.accessed ? '✓' : '✗';
          const color = entry.accessed ? 'var(--green)' : 'var(--text-muted)';
          const countBadge = entry.accessCount > 1
            ? `<span style="font-size:10px;color:var(--accent);margin-left:4px">×${entry.accessCount}</span>`
            : '';
          const lines = entry.lineCount ? `<span style="font-size:10px;color:var(--text-muted);margin-left:4px">${entry.lineCount}L</span>` : '';
          const typeTag = `<span style="font-size:10px;padding:1px 4px;border-radius:2px;background:var(--bg-card);color:var(--text-muted);margin-left:4px">${e(entry.type)}</span>`;
          return `<div style="display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px">
            <span style="color:${color};width:16px;text-align:center">${icon}</span>
            <span style="color:${entry.accessed ? 'var(--text-primary)' : 'var(--text-muted)'};${entry.accessed ? '' : 'text-decoration:line-through;opacity:0.6'};word-break:break-all">${e(entry.path)}</span>
            ${typeTag}${lines}${countBadge}
          </div>`;
        }).join('');
      const uncoveredByType: Record<string, string[]> = {};
      for (const entry of cov.entries.filter((item) => !item.accessed)) {
        const category = entry.path.startsWith('repos/') ? 'code' : entry.type;
        (uncoveredByType[category] = uncoveredByType[category] || []).push(entry.path);
      }
      const typeLabels: Record<string, string> = lang === 'zh'
        ? { principle: '原则文件', semantic: '语义索引', design: '设计文档', code: '代码路径', script: '脚本工具', other: '其他知识' }
        : { principle: 'Principles', semantic: 'Semantic index', design: 'Design docs', code: 'Code paths', script: 'Scripts', other: 'Other' };
      const hintLines: string[] = [];
      for (const [type, files] of Object.entries(uncoveredByType)) {
        const label = typeLabels[type] || type;
        hintLines.push(`<strong>${label}</strong>（${files.length}）：${files.slice(0, 3).map((file) => `<code>${e(file)}</code>`).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}`);
      }
      const uncoveredHint = hintLines.length > 0
        ? `<div style="font-size:11px;color:var(--text-muted);margin-top:10px;border-top:1px solid var(--border);padding-top:8px">
            <div style="margin-bottom:4px">${lang === 'zh' ? '💡 以下知识未被任何用例覆盖,建议补充评测用例:' : '💡 These knowledge files were not accessed — consider adding test cases:'}</div>
            ${hintLines.map((line) => `<div style="margin:2px 0">${line}</div>`).join('')}
          </div>`
        : '';
      const uncoveredCount = cov.filesTotal - cov.filesCovered;
      const summaryParts = [
        `${cov.filesCovered} ${lang === 'zh' ? '命中' : 'hit'}`,
        `${uncoveredCount} ${lang === 'zh' ? '未命中' : 'miss'}`,
        `${cov.grepPatternsUsed} ${lang === 'zh' ? '次搜索' : 'searches'}`,
      ].join(' · ');
      const detailsLabel = lang === 'zh' ? `展开 ${cov.filesTotal} 个文件清单` : `Show all ${cov.filesTotal} files`;
      covInner = `
        <div class="ki-col-header">
          <span class="ki-col-title">${lang === 'zh' ? '知识使用' : 'Knowledge used'}</span>
          <span class="ki-col-value" style="color:${pctColor}">${pct}%</span>
        </div>
        <div class="ki-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${e(barLabel)}">
          <div class="ki-bar-fill" style="width:${barW}%;background:${pctColor}"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted)">${summaryParts}</div>
        <details class="ki-details"><summary>${detailsLabel}</summary>
          ${fileRows}
          ${uncoveredHint}
        </details>`;
    } else {
      covInner = `<div style="color:var(--text-muted);font-size:12px">${lang === 'zh' ? '知识使用数据不可用' : 'Coverage data unavailable'}</div>`;
    }

    // ─── 右栏:知识盲区(gap)────────────────────────────
    let gapInner = '';
    if (gap) {
      const pct = Math.round(gap.gapRate * 100);
      const pctColor = pct <= 10 ? 'var(--green)' : pct <= 30 ? 'var(--yellow)' : 'var(--red)';
      const barW = Math.max(2, pct);
      const barLabel = lang === 'zh' ? '知识盲区' : 'Knowledge gaps';
      const weightedPct = Math.round(gap.weightedGapRate * 100);
      const softShare = pct - weightedPct;
      const weightedHint = lang === 'zh'
        ? (softShare >= 10
            ? `<strong>实际盲区 ${weightedPct}%</strong> · 另 ${softShare}% 为任务执行模型表达不确定(软信号,建议对照清单复核)`
            : `<strong>实际盲区 ${weightedPct}%</strong> · 主要来自确定的搜索未命中`)
        : (softShare >= 10
            ? `<strong>real gaps ${weightedPct}%</strong> · another ${softShare}% is hedging (review list below)`
            : `<strong>real gaps ${weightedPct}%</strong> · mostly confirmed search misses`);

      const typeBadges = (Object.keys(gap.byType) as GapSignalRef['type'][])
        .filter((key) => gap.byType[key] > 0)
        .map((key) => `<span style="display:inline-block;padding:2px 8px;border-radius:var(--radius);background:var(--bg-card);font-size:var(--fs-micro);color:var(--text-secondary);margin:2px 4px 2px 0">${e(pickSignalLabel(key))} × ${gap.byType[key]}</span>`)
        .join('');

      const INVENTORY_CAP = 6;
      // inventory 行用 border-left-color 按 signal severity 上色,不再重复标"类型"文字
      const inventory = gap.signals.slice(0, INVENTORY_CAP).map((sig) => {
        const severity = signalSeverity[sig.type];
        const turnPart = sig.turn != null ? ` · ${lang === 'zh' ? '第' : 'turn'} ${sig.turn}${lang === 'zh' ? ' 轮' : ''}` : '';
        return `<div class="ki-inventory-item" data-severity="${severity}">
          <div class="ki-inventory-item-meta"><strong style="color:var(--text-secondary)">${e(sig.sampleId)}</strong>${turnPart}</div>
          <div class="ki-inventory-item-ctx">${e(sig.context)}</div>
        </div>`;
      }).join('');
      const overflowHint = gap.signals.length > INVENTORY_CAP
        ? `<div style="font-size:var(--fs-micro);color:var(--text-muted);margin-top:6px">${lang === 'zh' ? `另 ${gap.signals.length - INVENTORY_CAP} 条未展示` : `+${gap.signals.length - INVENTORY_CAP} more not shown`}</div>`
        : '';

      const detailsLabel = lang === 'zh'
        ? `展开 ${gap.signals.length} 条证据（按严重度上色: 红=确定 / 黄=执行模型自述 / 灰=犹豫）`
        : `Show all ${gap.signals.length} evidence items (red=confirmed · yellow=self-flagged · gray=hedging)`;
      gapInner = `
        <div class="ki-col-header">
          <span class="ki-col-title">${lang === 'zh' ? '知识盲区' : 'Knowledge gaps'}</span>
          <span class="ki-col-value" style="color:${pctColor}">${pct}%</span>
        </div>
        <div class="ki-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${e(barLabel)}">
          <div class="ki-bar-fill" style="width:${barW}%;background:${pctColor}"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${gap.samplesWithGap}/${gap.sampleCount} ${lang === 'zh' ? '个评测用例出现搜索未命中或表达不确定' : 'samples with search miss / hedging'}</div>
        <div style="font-size:var(--fs-detail);color:var(--text-secondary);margin-bottom:8px">${weightedHint}</div>
        ${typeBadges ? `<div>${typeBadges}</div>` : ''}
        ${inventory ? `<details class="ki-details"><summary>${detailsLabel}</summary>
          ${inventory}
          ${overflowHint}
        </details>` : ''}`;
    } else {
      gapInner = `<div style="color:var(--text-muted);font-size:12px">${lang === 'zh' ? '知识盲区数据不可用' : 'Gap data unavailable'}</div>`;
    }

    // ─── Watermark(spec §7.1):test set 标识 ───
    const watermarkBits: string[] = [];
    if (gap?.testSetPath) {
      const basename = gap.testSetPath.split('/').pop() || gap.testSetPath;
      watermarkBits.push(`<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${e(basename)}</span>`);
    }
    if (gap) watermarkBits.push(`n=${gap.sampleCount}`);
    if (gap?.testSetHash) watermarkBits.push(`sha:${e(gap.testSetHash)}`);
    const watermark = watermarkBits.length > 0
      ? `<div class="ki-card-meta">${watermarkBits.join(' · ')}</div>`
      : '';

    return `<div class="ki-card" style="border-left:3px solid ${variantColor}">
      <div class="ki-card-header">
        <span class="ki-card-title">${e(variant)}</span>
        ${watermark}
      </div>
      <div class="ki-columns">
        <div class="ki-col">${covInner}</div>
        <div class="ki-col">${gapInner}</div>
      </div>
    </div>`;
  }).join('');

  return `
    <section style="margin-top:28px;padding-top:20px;border-top:1px solid var(--border)">
      <h2>${title}</h2>
      <p class="ki-desc">${desc}</p>
      <div class="ki-desc-hint">${readHint}</div>
      ${cards}
    </section>
  `;
}

export function renderGapSection(gapReports: Record<string, GapReport> | undefined, lang: Lang): string {
  if (!gapReports || Object.keys(gapReports).length === 0) return '';

  const title = lang === 'zh' ? '本次测评的知识盲区' : 'Knowledge gaps in this evaluation';
  const desc = lang === 'zh'
    ? '本次测评中，哪些知识想找但没找到、或任务执行模型表达不确定。数字高不一定代表知识库不全——也可能是评测用例问的领域知识库未覆盖。'
    : 'Which knowledge the task execution model tried to find but missed, or expressed uncertainty about. High numbers do not necessarily mean the KB is incomplete — the test set may be asking about areas the KB never covered.';

  const signalTypeLabels: Record<GapSignalRef['type'], { zh: string; en: string }> = {
    failed_search: { zh: '搜索未命中', en: 'Search miss' },
    explicit_marker: { zh: '任务执行模型标记缺口', en: 'Execution model flag' },
    hedging: { zh: '表达不确定', en: 'Hedging' },
    repeated_failure: { zh: '反复未命中', en: 'Repeated miss' },
  };
  const pickLabel = (key: GapSignalRef['type']): string => signalTypeLabels[key][lang === 'zh' ? 'zh' : 'en'];

  const variantSections = Object.entries(gapReports).map(([variant, report]) => {
    const pct = Math.round(report.gapRate * 100);
    // Color: lower gap rate is better (inverse of coverage). Gate at 10% / 30%.
    const pctColor = pct <= 10 ? 'var(--green)' : pct <= 30 ? 'var(--yellow)' : 'var(--red)';
    const barW = Math.max(2, pct);

    // v0.2 加权严重度 (spec §6):weightedGapRate 按用例最强信号权重聚合,总是 ≤ gapRate,
    // 差值反映"软信号(hedging / explicit_marker)占比"——若差值大,说明 gap_rate 被软信号
    // 拉高,读者该复核弱信号的真实含义。若差值小,说明信号以硬证据为主,结论可信度高。
    const weightedPct = Math.round(report.weightedGapRate * 100);
    const softSignalShare = pct - weightedPct;
    const weightedHint = lang === 'zh'
      ? (softSignalShare >= 10
          ? `<strong>实际盲区 ${weightedPct}%</strong> · 另外 ${softSignalShare}% 为任务执行模型表达不确定(软信号,建议对照右侧清单复核)`
          : `<strong>实际盲区 ${weightedPct}%</strong> · 主要来自确定的搜索未命中`)
      : (softSignalShare >= 10
          ? `<strong>real gaps ${weightedPct}%</strong> · another ${softSignalShare}% is hedging (soft signals — review the list on the right)`
          : `<strong>real gaps ${weightedPct}%</strong> · mostly from confirmed search misses`);

    // Watermark (spec §7.1): test set path + sample count + hash + explicit caveat
    const watermarkBits: string[] = [];
    if (report.testSetPath) {
      const basename = report.testSetPath.split('/').pop() || report.testSetPath;
      watermarkBits.push(`<span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${e(basename)}</span>`);
    }
    watermarkBits.push(`n=${report.sampleCount}`);
    if (report.testSetHash) watermarkBits.push(`sha:${e(report.testSetHash)}`);
    const watermark = `<div style="font-size:var(--fs-micro);color:var(--text-muted);margin-bottom:8px;font-weight:400">${watermarkBits.join(' · ')}</div>`;

    // Classification: per-type counts
    const typeBadges = (Object.keys(report.byType) as GapSignalRef['type'][])
      .filter((key) => report.byType[key] > 0)
      .map((key) => `<span style="display:inline-block;padding:2px 8px;border-radius:var(--radius);background:var(--bg-card);font-size:var(--fs-micro);color:var(--text-secondary);margin:2px 4px 2px 0">${e(pickLabel(key))} × ${report.byType[key]}</span>`)
      .join('');

    // Inventory: list of specific signals (cap at 8 to keep the panel compact)
    const INVENTORY_CAP = 8;
    const inventory = report.signals.slice(0, INVENTORY_CAP).map((sig) => {
      const typeLabel = pickLabel(sig.type);
      const turnPart = sig.turn != null ? ` / ${lang === 'zh' ? '第' : 'turn'} ${sig.turn}${lang === 'zh' ? ' 轮' : ''}` : '';
      return `<div style="padding:6px 10px;margin:4px 0;background:var(--bg-card);border-left:2px solid var(--border-hover);border-radius:4px;font-size:var(--fs-detail);line-height:1.5">
        <div style="color:var(--text-muted);font-size:var(--fs-micro);margin-bottom:2px">
          <strong style="color:var(--text-secondary)">${e(sig.sampleId)}</strong>${turnPart} · ${e(typeLabel)}
        </div>
        <div style="color:var(--text-secondary);word-break:break-all">${e(sig.context)}</div>
      </div>`;
    }).join('');

    const overflowHint = report.signals.length > INVENTORY_CAP
      ? `<div style="font-size:var(--fs-micro);color:var(--text-muted);margin-top:6px">${lang === 'zh' ? `还有 ${report.signals.length - INVENTORY_CAP} 条未展示` : `+${report.signals.length - INVENTORY_CAP} more not shown`}</div>`
      : '';

    // caveat 已从底部移除:副标题已经讲清楚"撞墙多不等于知识库不全"。重复说一遍反而稀释主信号。

    return `<div style="flex:1;min-width:320px;padding:16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <strong>${e(variant)}</strong>
        <span style="font-size:20px;font-weight:600;color:${pctColor}">${pct}%</span>
      </div>
      ${watermark}
      <div style="height:8px;background:var(--bg-card);border-radius:4px;margin-bottom:10px">
        <div style="width:${barW}%;height:100%;background:${pctColor};border-radius:4px"></div>
      </div>
      <div style="font-size:var(--fs-detail);color:var(--text-muted);margin-bottom:4px">
        ${report.samplesWithGap} / ${report.sampleCount} ${lang === 'zh' ? '个评测用例出现搜索未命中或表达不确定' : 'samples with search miss or hedging'}
      </div>
      <div style="font-size:var(--fs-detail);color:var(--text-secondary);margin-bottom:10px">${weightedHint}</div>
      ${typeBadges ? `<div style="margin-bottom:10px">${typeBadges}</div>` : ''}
      ${inventory ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
        <div style="font-size:var(--fs-micro);color:var(--text-muted);margin-bottom:4px">${lang === 'zh' ? '具体哪些知识未命中' : 'Missed knowledge inventory'}</div>
        ${inventory}
        ${overflowHint}
      </div>` : ''}
    </div>`;
  }).join('');

  return `
    <section style="margin-top:24px">
      <h2>${title}</h2>
      <p style="font-size:var(--fs-detail);color:var(--text-muted);margin-bottom:12px">${desc}</p>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${variantSections}
      </div>
    </section>
  `;
}
