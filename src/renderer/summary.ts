import { e, fmtNum, fmtCost, fmtDuration, COLORS, t } from './layout.js';
import { pValueCategory } from '../eval-core/statistics.js';
import type { AnalysisResult, Insight, KnowledgeCoverage, Lang, VarianceComparison, VarianceComparisonMetric, VarianceData, VariantSummary } from '../types.js';

export function renderSummaryCards(variants: string[], summary: Record<string, VariantSummary>, lang: Lang, variance?: VarianceData): string {
  // Build comparison table: variants as rows, dimensions as columns.
  // When variance data exists, the quality column shows cross-run means (for
  // consistency with the Variance & Significance section below). The data
  // source is inferable from the experiment summary at top + the matching
  // numbers in the significance section — no redundant per-column labelling.
  const headerCols = [
    { key: 'dimQuality', label: t('dimQuality', lang) },
    { key: 'dimCost', label: t('dimCost', lang) },
    { key: 'dimEfficiency', label: t('dimEfficiency', lang) },
    { key: 'dimStability', label: t('dimStability', lang) },
  ];

  const thead = `<tr><th data-i18n="variants">${t('variants', lang)}</th>${headerCols.map((c) => `<th data-i18n="${c.key}">${c.label}</th>`).join('')}</tr>`;

  const rows = variants.map((v, i) => {
    const s = summary[v] || {} as VariantSummary;
    const vd = variance?.perVariant[v];
    const color = COLORS[i % COLORS.length];

    // Quality — show composite + layered breakdown.
    // When variance exists (--repeat), use the cross-run mean as the source of
    // truth so this table agrees with the Variance & Significance section below.
    // Otherwise fall back to the single-run summary aggregate.
    const crossRunMean = vd?.mean;
    const score = crossRunMean ?? s.avgCompositeScore ?? s.avgLlmScore ?? '-';
    const factLabel = lang === 'zh' ? '事实' : 'Fact';
    const behaviorLabel = lang === 'zh' ? '行为' : 'Behavior';
    const qualityLabel = lang === 'zh' ? '质量' : 'Quality';

    const layeredDetailParts: string[] = [];
    const hintParts: string[] = [];

    if (s.avgFactScore != null) {
      layeredDetailParts.push(`<span>${factLabel}: ${s.avgFactScore}</span>`);
      hintParts.push(`${factLabel}: ${s.avgFactScore}`);
    }
    if (s.avgBehaviorScore != null) {
      layeredDetailParts.push(`<span>${behaviorLabel}: ${s.avgBehaviorScore}</span>`);
      hintParts.push(`${behaviorLabel}: ${s.avgBehaviorScore}`);
    }
    if (s.avgFactVerifiedRate != null) {
      const pct = Math.round(s.avgFactVerifiedRate * 100);
      layeredDetailParts.push(`<span>${lang === 'zh' ? '事实验证' : 'Verified'}: ${pct}%</span>`);
      hintParts.push(`${lang === 'zh' ? '事实验证' : 'Verified'}: ${pct}%`);
    }
    if (s.avgQualityScore != null) {
      layeredDetailParts.push(`<span>${qualityLabel}: ${s.avgQualityScore}</span>`);
      hintParts.push(`${qualityLabel}: ${s.avgQualityScore}`);
    }

    // Cross-run context is marked once in the column header, not per row.

    if (layeredDetailParts.length === 0) {
      // Fallback to old style if no layered scores
      if (s.minCompositeScore != null) { layeredDetailParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); hintParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); }
      if (s.avgAssertionScore != null) { layeredDetailParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); hintParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); }
      if (s.avgLlmScore != null) { layeredDetailParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); hintParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); }
    }

    const scoreNum = typeof score === 'number' ? score : 0;
    const scoreColor = scoreNum >= 4 ? 'var(--green)' : scoreNum >= 3 ? 'var(--yellow)' : scoreNum > 0 ? 'var(--red)' : 'var(--text-primary)';
    const scoreDisplay = typeof score === 'number' ? score.toFixed(2) : score;
    const qualityCell = `<td class="summary-cell"><div class="summary-value summary-value-primary" style="color:${scoreColor}">${scoreDisplay}</div><div class="summary-detail">${layeredDetailParts.join(' · ')}</div></td>`;

    // Cost — only show execution cost (judge cost is tool overhead, not skill cost)
    const execCost = s.totalExecCostUSD || 0;
    const hasCost = execCost > 0 || (s.avgTotalTokens || 0) > 0;
    const costCell = hasCost
      ? `<td class="summary-cell"><div class="summary-value">${fmtCost(execCost)}</div><div class="summary-detail">${fmtNum(s.avgTotalTokens)} tokens/${t('tokPerReq', lang).replace('tokens/', '')}</div></td>`
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

    // Stability — variant-internal attributes only: success rate + sample-level
    // score spread. Cross-run dispersion (σ, CV, CI) now lives exclusively in
    // the Variance & Significance section so that the two tables never
    // overlap conceptually.
    const total = s.totalSamples || 0;
    const successCount = s.successCount || 0;
    const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;

    const stabValue = `${successRate}%`;
    const stabColor = successRate === 100 ? 'var(--green)' : successRate >= 90 ? 'var(--yellow)' : 'var(--red)';

    const stabDetails: string[] = [];
    if ((s.errorCount || 0) > 0) {
      stabDetails.push(`<span style="color:var(--red)">${s.errorCount} ${t('errors', lang)}</span>`);
    }
    if (s.minCompositeScore != null && s.maxCompositeScore != null && s.minCompositeScore !== s.maxCompositeScore) {
      stabDetails.push(`${lang === 'zh' ? '分数' : 'range'} ${s.minCompositeScore}~${s.maxCompositeScore}`);
    }
    const stabDetail = stabDetails.length > 0 ? `<div class="summary-detail">${stabDetails.join(' · ')}</div>` : '';

    const stabCell = `<td class="summary-cell"><div class="summary-value" style="color:${stabColor}">${stabValue}</div>${stabDetail}</td>`;

    return `<tr><td style="border-left:3px solid ${color};padding-left:12px"><strong>${e(v)}</strong></td>${qualityCell}${costCell}${effCell}${stabCell}</tr>`;
  }).join('');

  const guideModalId = 'guide-four-dims';
  const guideTitle = lang === 'zh' ? '如何阅读四维对比？' : 'How to read this table?';
  const guideIntro = lang === 'zh'
    ? '每行是一个实验分组（Variant），四列分别衡量不同维度：'
    : 'Each row is a Variant. Four columns measure different dimensions:';
  const icon = (emoji: string) => `<span aria-hidden="true">${emoji}</span>`;
  const dim = 'style="padding:8px 0 4px;border-top:1px solid var(--border);color:var(--text-primary)"';
  const dimDesc = 'style="padding:8px 0 4px;border-top:1px solid var(--border);color:var(--text-secondary)"';
  const dimFirst = 'style="padding:4px 0 4px;color:var(--text-primary)"';
  const dimFirstDesc = 'style="padding:4px 0 4px;color:var(--text-secondary)"';
  const sub = 'style="padding:2px 0 2px 28px;font-size:12px;color:var(--text-secondary);font-weight:500"';
  const subDesc = 'style="padding:2px 0;font-size:12px;color:var(--text-muted)"';
  const guideRows = lang === 'zh' ? `
    <tr><td ${dimFirst}>${icon('📊')} <strong>质量</strong></td><td ${dimFirstDesc}>三层评分的等权平均值（1-5 分），计算公式：(事实 + 行为 + 质量) ÷ 3</td></tr>
    <tr><td ${sub}>事实性</td><td ${subDesc}>输出中的事实声明是否正确（关键词匹配、格式校验等断言）</td></tr>
    <tr><td ${sub}>行为合规</td><td ${subDesc}>执行过程是否合规（工具调用路径、轮次限制、成本约束等断言）</td></tr>
    <tr><td ${sub}>质量</td><td ${subDesc}>LLM 评委对输出整体质量的主观评分</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>成本</strong></td><td ${dimDesc}>API 调用费用（仅执行成本，不含评分成本）</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>效率</strong></td><td ${dimDesc}>单次评测的平均耗时，含轮次和工具调用统计</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>稳定性</strong></td><td ${dimDesc}>变体在本次评测中的内在稳定性，仅反映样本间表现</td></tr>
    <tr><td ${sub}>成功率</td><td ${subDesc}>评测任务成功完成的比例，失败包括超时、API 错误等</td></tr>
    <tr><td ${sub}>分数范围</td><td ${subDesc}>样本间最低分 ~ 最高分，范围越窄越稳定</td></tr>
    <tr><td style="padding:6px 0 0;color:var(--text-muted);font-size:11px" colspan="2">💡 跨轮方差、置信区间、效应量、显著性等"对比类指标"不在本表，请看下面的「方差与显著性」区块。</td></tr>
  ` : `
    <tr><td ${dimFirst}>${icon('📊')} <strong>Quality</strong></td><td ${dimFirstDesc}>Equal-weight average of three layers (1-5): (Fact + Behavior + Quality) ÷ 3</td></tr>
    <tr><td ${sub}>Factual</td><td ${subDesc}>Are factual claims correct (keyword matching, format validation assertions)</td></tr>
    <tr><td ${sub}>Behavioral</td><td ${subDesc}>Is execution compliant (tool paths, turn limits, cost constraints)</td></tr>
    <tr><td ${sub}>Quality</td><td ${subDesc}>LLM judge subjective score on output quality</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>Cost</strong></td><td ${dimDesc}>API expense (execution only, excludes judge cost)</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>Efficiency</strong></td><td ${dimDesc}>Average time per evaluation, with turn and tool call stats</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>Stability</strong></td><td ${dimDesc}>Variant-internal stability across samples, not cross-variant comparison</td></tr>
    <tr><td ${sub}>Success rate</td><td ${subDesc}>Percentage of tasks completed successfully (failures include timeouts, API errors)</td></tr>
    <tr><td ${sub}>Score range</td><td ${subDesc}>Min ~ Max score across all samples. Narrower = more stable</td></tr>
    <tr><td style="padding:6px 0 0;color:var(--text-muted);font-size:11px" colspan="2">💡 Cross-run variance, CI, effect size and significance live in the "Variance & Significance" section below — not here.</td></tr>
  `;

  return `
    <h2 data-i18n="dimQuality" style="display:flex;align-items:center;gap:4px">${t('reportTitle', lang) === t('reportTitle', 'zh') ? '四维对比' : 'Comparison'} <button type="button" class="hint-btn" onclick="openModal('${guideModalId}')" aria-label="${e(guideTitle)}" aria-haspopup="dialog">?</button></h2>
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
    <div class="table-wrap">
    <table class="summary-table">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}

interface DiagnosticEntry {
  icon: string;
  text: string;
  color: string;
}

function buildDiagnostic(
  metric: VarianceComparisonMetric,
  cfg: MetricDisplayConfig,
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
          ? `${winner} 看似${cfg.winnerWordZh}但样本不足，建议加大 --repeat`
          : `${winner} looks ${cfg.winnerWordEn.replace(' by', '')} but underpowered — increase --repeat`)
      : (lang === 'zh'
          ? `${strongLabelZh}差异但样本不足，建议加大 --repeat`
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
interface MetricDisplayConfig {
  key: 'quality' | 'cost' | 'efficiency';
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

const METRIC_CONFIGS: MetricDisplayConfig[] = [
  {
    key: 'quality',
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
  if (key === 'quality') {
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
  if (key === 'quality') return v.mean;
  return v.byMetric?.[key]?.mean ?? null;
}

export function renderVarianceComparisons(variance: VarianceData | undefined, lang: Lang): string {
  if (!variance || !variance.comparisons || variance.comparisons.length === 0) return '';

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
  function pickWinner(metric: VarianceComparisonMetric, cfg: MetricDisplayConfig, a: string, b: string): string | null {
    const diffAbs = Math.abs(metric.meanDiff);
    if (diffAbs < 1e-9) return null;
    const rawHigherVariant = metric.meanDiff > 0 ? a : b;
    return cfg.higherIsBetter ? rawHigherVariant : (metric.meanDiff > 0 ? b : a);
  }

  function buildMetricRowCells(
    metric: VarianceComparisonMetric,
    cfg: MetricDisplayConfig,
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

  const rows = variance.comparisons.map((comp) => {
    // Collect available metric rows for this comparison
    const availableMetrics: Array<{ cfg: MetricDisplayConfig; metric: VarianceComparisonMetric }> = [];
    for (const cfg of METRIC_CONFIGS) {
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
    return preBuilt.map((row, idx) => {
      const lead = idx === 0 ? comparisonCell : '';
      const aMean = getVariantMetricMean(variance!, comp.a, row.cfg.key);
      const bMean = getVariantMetricMean(variance!, comp.b, row.cfg.key);
      const fade = idx > 0 && row.diagText === prevDiagKey;
      prevDiagKey = row.diagText;
      return `<tr>${lead}${buildMetricRowCells(row.metric, row.cfg, comp.a, comp.b, aMean, bMean, fade)}</tr>`;
    }).join('');
  }).join('');

  // Glossary rows — structured data instead of a giant HTML string.
  // Each "row" is either a top-level term or a sub-item under the previous term.
  interface GlossaryRow { label: string; desc: string; sub?: boolean }
  const glossaryZh: GlossaryRow[] = [
    { label: '差距', desc: '跨轮均值胜出者 + 绝对差值（原始单位）' },
    { label: '效应量', desc: '差距相对标准差的倍数。阈值：0.2=小 / 0.5=中 / 0.8=大' },
    { label: "Hedges' g", desc: '小样本修正版，n1+n2<20 时优先参考', sub: true },
    { label: "Cohen's d", desc: '未修正版，n1+n2≥20 时是学术惯例', sub: true },
    { label: '显著性', desc: 't 检验结论，基于 p<0.05 阈值。回答"差异真不真"，和效应量"差多大"互补' },
    { label: 'p 值', desc: '假设真的没差异时，观察到当前差距的概率。越小越可信。0.05 只是约定阈值', sub: true },
    { label: 't 值', desc: '均值差 ÷ 估计误差，需配合 df 和效应量解读，不能单独看', sub: true },
    { label: 'df 自由度', desc: '≈"有效样本量"。--repeat 3 时通常 2~4；想达到 20+ 需 --repeat 10+', sub: true },
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
    { variant: 'warn', icon: '⚠', title: '大效应但样本不足', desc: '差距看似大但样本太少，建议加大 --repeat 再判断', example: '示例：v2 胜出 0.30 · g=1.04 · 不显著' },
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

function renderSummaryStructured(summary: string): string {
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

  const sectionHtml = sections.map((section) => `
      <div style="display:flex;gap:12px;align-items:baseline">
        <span style="flex-shrink:0;font-size:11px;font-weight:600;color:var(--text-muted);letter-spacing:0.03em;min-width:56px">${e(section.label)}</span>
        <span style="color:var(--text-secondary);font-size:13px;line-height:1.7">${e(section.content)}</span>
      </div>`).join('');

  return `
    <div style="padding:14px 18px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      ${sectionHtml}
    </div>`;
}

export function renderAnalysis(analysis: AnalysisResult | undefined, lang: Lang): string {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const issues = (insights || []).filter((insight) => !isConclusion(insight));
  const issueLabel = lang === 'zh' ? '问题与建议' : 'Issues & Suggestions';
  const safeSuggestions = suggestions || [];

  let issuesHtml = '';
  if (issues.length > 0 || safeSuggestions.length > 0) {
    const maxRows = Math.max(issues.length, safeSuggestions.length);
    const rows: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const issue = issues[i];
      const suggestion = safeSuggestions[i];
      const issueContent = issue
        ? `${severityDot(issue.severity)}<span>${e(issue.message)}</span>`
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

  const summaryHtml = analysis.summary
    ? renderSummaryStructured(analysis.summary)
    : '';

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${summaryHtml}
    ${issuesHtml}
  `;
}

export function renderAgentOverview(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  const hasAgentData = variants.some((variant) => summary[variant]?.avgToolCalls != null && summary[variant].avgToolCalls! > 0);
  if (!hasAgentData) return '';

  const variantCards = variants.map((variant, i) => {
    const stats = summary[variant];
    if (!stats) return '';
    const color = COLORS[i % COLORS.length];
    const avgTools = stats.avgToolCalls ?? 0;
    const successRate = stats.toolSuccessRate != null ? `${(stats.toolSuccessRate * 100).toFixed(0)}%` : '-';
    const successRateColor = (stats.toolSuccessRate ?? 1) >= 0.8 ? 'var(--green)' : 'var(--red)';
    const turns = stats.avgFullNumTurns ?? stats.avgNumTurns ?? 0;
    const distributionEntries = Object.entries(stats.toolDistribution || {}).sort((a, b) => b[1] - a[1]);
    const maxCount = distributionEntries.length > 0 ? distributionEntries[0][1] : 0;
    const distributionBars = distributionEntries.map(([tool, count]) => {
      const pct = maxCount > 0 ? Math.max(8, (count / maxCount) * 100) : 0;
      return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">
        <span style="font-size:11px;color:var(--text-muted);width:100px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0" title="${e(tool)}">${e(tool)}</span>
        <div style="flex:1;height:8px;background:var(--bg-surface);border-radius:4px">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:4px"></div>
        </div>
        <span style="font-size:11px;color:var(--text-secondary);min-width:20px">${count}</span>
      </div>`;
    }).join('');

    return `<div style="flex:1;min-width:240px;padding:16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius);border-left:3px solid ${color}">
      <div style="font-weight:600;margin-bottom:12px">${e(variant)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${t('agentAvgTurns', lang)}</div>
          <div style="font-size:20px;font-weight:600">${turns}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${t('agentAvgTools', lang)}</div>
          <div style="font-size:20px;font-weight:600">${avgTools}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted)">${t('agentToolSuccess', lang)}</div>
          <div style="font-size:20px;font-weight:600;color:${successRateColor}">${successRate}</div>
        </div>
      </div>
      ${distributionEntries.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${t('agentToolDist', lang)}</div>
        ${distributionBars}
      ` : ''}
    </div>`;
  }).join('');

  return `
    <section style="margin-top:24px">
      <h2>${t('agentOverview', lang)}</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap">
        ${variantCards}
      </div>
    </section>
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
          <div style="margin-bottom:4px">${lang === 'zh' ? '💡 建议从以下维度补充测试用例：' : '💡 Consider adding test cases for:'}</div>
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
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">${knowledgeCoverage.filesCovered}/${knowledgeCoverage.filesTotal} ${lang === 'zh' ? '文件被访问' : 'files accessed'} · ${knowledgeCoverage.grepPatternsUsed} ${lang === 'zh' ? '次搜索' : 'searches'}</div>
      ${fileRows}
      ${uncoveredHint}
    </div>`;
  }).join('');

  const title = lang === 'zh' ? '测评用例知识覆盖率' : 'Test Case Knowledge Coverage';
  const desc = lang === 'zh'
    ? '当前测试用例触及了 artifact 知识域中多少文件。覆盖率低说明需要补充测试样本，而非知识本身不完整。'
    : 'How much of the artifact\'s knowledge domain was exercised by current test cases. Low coverage suggests more test samples are needed.';

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
