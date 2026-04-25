import { e, fmtNum, fmtCost, fmtDuration, COLORS, t } from './layout.js';
import { pValueCategory } from '../eval-core/statistics.js';
import type { AnalysisResult, GapReport, GapSignalRef, Insight, KnowledgeCoverage, Lang, VarianceComparison, VarianceComparisonMetric, VarianceData, VarianceLayerKey, VariantPairComparison, VariantSummary } from '../types.js';

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

export function renderSummaryCards(variants: string[], summary: Record<string, VariantSummary>, lang: Lang, variance?: VarianceData): string {
  // 六维对比表格:事实 / 行为 / LLM 评价 / 成本 / 效率 / 稳定性。
  // 前三列(事实/行为/LLM 评价)是 task 级原始指标的 variant 聚合;成本/效率同。
  // 稳定性是 variant 级散度度量(需 --repeat ≥ 2)。
  //
  // composite 合成分 (= (fact + behavior + judge) / 3) 从 v0.16 起不再在此表主视觉呈现,
  // 仅保留在 report JSON 数据层 + Variance & Significance 表顶层 flat 字段(legacy)。
  // 理由见 docs/terminology-spec.md 三-6 节:三层独立呈现避免合成分掩盖结构性差异。
  const headerCols = [
    { key: 'dimFact', label: t('dimFact', lang) },
    { key: 'dimBehavior', label: t('dimBehavior', lang) },
    { key: 'dimJudge', label: t('dimJudge', lang) },
    { key: 'dimCost', label: t('dimCost', lang) },
    { key: 'dimEfficiency', label: t('dimEfficiency', lang) },
    { key: 'dimStability', label: t('dimStability', lang) },
  ];

  const thead = `<tr><th data-i18n="variants">${t('variants', lang)}</th>${headerCols.map((c) => `<th data-i18n="${c.key}">${c.label}</th>`).join('')}</tr>`;

  // 渲染单层分数 cell(事实/行为/LLM 评价通用)。
  // 优先读跨 run 均值(byLayer[key].mean),fallback 到 summary 的单 run avg。
  // 缺数据时显示 "—" + 灰色,让读者明确看到"这一层这批样本/评委没测到",不假装有值。
  function renderLayerCell(varianceMean: number | undefined, summaryValue: number | undefined, detailHtml = ''): string {
    const v = varianceMean ?? summaryValue;
    const hasValue = typeof v === 'number' && v > 0;
    const color = hasValue
      ? (v >= 4 ? 'var(--green)' : v >= 3 ? 'var(--yellow)' : 'var(--red)')
      : 'var(--text-muted)';
    const display = hasValue ? v.toFixed(2) : '—';
    return `<td class="summary-cell"><div class="summary-value summary-value-primary" style="color:${color}">${display}</div>${detailHtml}</td>`;
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

    // Stability — 多次运行分数一致性（test-retest reliability），统计学定义的稳定性。
    // 主视觉:白话定性词 + ±σ 直观量级,让读者一眼判断。
    // 副区:CV (变异系数 = σ / mean) 分两行展示 + 95% CI(置信区间)。
    // 无 --repeat(variance 缺失) 时主值显示 "—" + 明示需多跑,不虚报 100%——
    // 符合 omk 叙事底线"诚实交代测不到什么"。
    //
    // 跨样本 min~max range 不是稳定性(反映样本难度差异,非 variant 波动),已从此列移除。
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
      // No cross-run data → honestly say "not measurable with single run".
      stabValue = '—';
      stabColor = 'var(--text-muted)';
      stabDetails.push(`<span style="color:var(--text-muted)">${lang === 'zh' ? '需 --repeat ≥ 2' : 'needs --repeat ≥ 2'}</span>`);
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

  const guideModalId = 'guide-six-dims';
  const guideTitle = lang === 'zh' ? '如何阅读六维对比？' : 'How to read this 6-dim comparison?';
  const guideIntro = lang === 'zh'
    ? '每行是一个实验分组（Variant），六列分别衡量不同维度：'
    : 'Each row is a Variant. Six columns measure independent dimensions:';
  const icon = (emoji: string) => `<span aria-hidden="true">${emoji}</span>`;
  // 维度分隔加粗(border-top 2px),让六维的视觉边界更明显。sub 缩进从 28 收到 22。
  const dim = 'style="padding:12px 0 4px;border-top:2px solid var(--border);color:var(--text-primary);font-weight:600"';
  const dimDesc = 'style="padding:12px 0 4px;border-top:2px solid var(--border);color:var(--text-secondary)"';
  const dimFirst = 'style="padding:4px 0 4px;color:var(--text-primary);font-weight:600"';
  const dimFirstDesc = 'style="padding:4px 0 4px;color:var(--text-secondary)"';
  const sub = 'style="padding:2px 0 2px 22px;font-size:12px;color:var(--text-secondary);font-weight:500"';
  const subDesc = 'style="padding:2px 0;font-size:12px;color:var(--text-muted)"';
  const guideRows = lang === 'zh' ? `
    <tr><td ${dimFirst}>${icon('📋')} <strong>事实</strong></td><td ${dimFirstDesc}>模型的输出说得对不对（事实声明层面）。靠规则断言判：关键词是否出现、JSON 格式是否合法等，答错了直接不给分。</td></tr>
    <tr><td ${dim}>${icon('🛠️')} <strong>行为</strong></td><td ${dimDesc}>模型做事的过程有没有走对路。靠规则断言判：该调的工具有没有调、有没有超过轮次/成本上限。</td></tr>
    <tr><td ${dim}>${icon('💬')} <strong>LLM 评价</strong></td><td ${dimDesc}>请一个 LLM 当评委，让它读被测模型的输出内容，按预先写好的评分规则（英文叫 rubric）打个 1-5 分。主观但能抓到规则断言判不了的"整体好不好"——比如回答是否清晰、有没有答非所问。</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>成本</strong></td><td ${dimDesc}>跑这次评测花了多少 API 调用费（只算执行成本，评委那个 LLM 的钱不算进来）。</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>效率</strong></td><td ${dimDesc}>一次评测平均跑多久；附带轮次数和工具调用次数。</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>稳定性</strong></td><td ${dimDesc}>同一份测试跑很多次，分数抖不抖。抖得越少越稳定。<strong>跑一次看不出稳定性</strong>——至少要 <code>--repeat ≥ 2</code>，不然显示"—"。</td></tr>
    <tr><td ${sub}>稳定 / 较稳 / 波动大</td><td ${subDesc}>分数波动比例 &lt;5% = 稳定 · 5~15% = 一般 · &gt;15% = 波动大</td></tr>
    <tr><td ${sub}>±σ</td><td ${subDesc}>每次跑出的分数，大概在平均分上下浮动多少。1-5 分数里 ±0.05 几乎不抖、±0.5 抖得很厉害</td></tr>
    <tr><td ${sub}>CV</td><td ${subDesc}>分数抖动幅度占平均分的比例（例：CV 2% = 分数波动大约是平均分的 2%）</td></tr>
    <tr><td ${sub}>95% CI</td><td ${subDesc}>如果跑无数次求平均，真实平均分有 95% 概率落在这个范围里——范围越窄，这次测出的均值越可信</td></tr>
  ` : `
    <tr><td ${dimFirst}>${icon('📋')} <strong>Fact</strong></td><td ${dimFirstDesc}>Whether the model's output is factually correct. Checked by rule-based assertions — keyword matches, JSON schema validity, etc. Wrong = zero.</td></tr>
    <tr><td ${dim}>${icon('🛠️')} <strong>Behavior</strong></td><td ${dimDesc}>Whether the model followed the right process. Checked by rule-based assertions — did it call the expected tools, stay within turn/cost limits.</td></tr>
    <tr><td ${dim}>${icon('💬')} <strong>LLM judge</strong></td><td ${dimDesc}>A separate LLM acts as judge: it reads the tested model's output and scores it 1-5 against a predefined rubric. Subjective, but catches "overall feel" that rule-based assertions miss — e.g., whether the answer is clear, whether it's on-topic.</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>Cost</strong></td><td ${dimDesc}>API cost of this run (execution only — the judge LLM's cost isn't included here).</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>Efficiency</strong></td><td ${dimDesc}>Average time per evaluation, plus turn counts and tool call stats.</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>Stability</strong></td><td ${dimDesc}>How much the score swings when you repeat the same test. Less swing = more stable. <strong>You can't measure stability from a single run</strong> — need <code>--repeat ≥ 2</code>, otherwise shows "—".</td></tr>
    <tr><td ${sub}>Stable / Moderate / Variable</td><td ${subDesc}>Score swing as % of mean: &lt;5% = Stable · 5~15% = Moderate · &gt;15% = Variable</td></tr>
    <tr><td ${sub}>±σ</td><td ${subDesc}>How much each run's score typically swings around the mean. On a 1-5 scale, ±0.05 barely moves, ±0.5 swings a lot</td></tr>
    <tr><td ${sub}>CV</td><td ${subDesc}>Score swing as a percentage of the mean (e.g., CV 2% = swings are about 2% of the mean)</td></tr>
    <tr><td ${sub}>95% CI</td><td ${subDesc}>If you ran infinitely many times, the true mean has a 95% chance of falling in this range — narrower = you can trust the measured mean more</td></tr>
  `;

  return `
    <h2 style="display:flex;align-items:center;gap:4px">${lang === 'zh' ? '六维对比' : '6-Dim Comparison'} <button type="button" class="hint-btn" onclick="openModal('${guideModalId}')" aria-label="${e(guideTitle)}" aria-haspopup="dialog">?</button></h2>
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
    </div>
    ${renderJudgeAgreementBlock(variants, summary, lang)}`;
}

/**
 * Cross-sample inter-judge agreement table — only renders when at least one variant
 * has multi-judge ensemble data. This is the v0.20.2 "blog headline" view: shows
 * Pearson + MAD across the whole sample set, the metric that refutes "Claude judge
 * Claude same-modality bias".
 */
function renderJudgeAgreementBlock(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  const variantsWithEnsemble = variants.filter((v) => summary[v]?.judgeAgreement);
  if (variantsWithEnsemble.length === 0) return '';

  const rows = variantsWithEnsemble.map((v) => {
    const s = summary[v];
    const ag = s.judgeAgreement!;
    const judgeList = (s.judgeModels || []).map((j) => `<code>${e(j)}</code>`).join(', ');
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
        <th>${lang === 'zh' ? '用例数' : 'Samples'}</th>
        <th>${lang === 'zh' ? 'Judge 对数' : 'Pairs'}</th>
      </tr></thead>
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

export function renderVarianceComparisons(variance: VarianceData | undefined, lang: Lang, layeredStatsOpen = false): string {
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
    // 多重比较 disclaimer:三层独立 t 检验,family-wise error 未矫正;小样本 Cohen's d 不稳。
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
          <div style="margin-bottom:4px">${lang === 'zh' ? '💡 以下知识未被任何用例覆盖,建议补充测评用例:' : '💡 These knowledge files were not accessed by any sample — consider adding test cases:'}</div>
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
    ? '本次测评中，哪些知识没有被使用。数字低说明测试用例没覆盖到的角落多，不是知识库内容缺失——配合下方"本次测评的知识盲区"一起看才完整。'
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
 * See docs/knowledge-gap-signal-spec.md for the semantics.
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

  const title = lang === 'zh' ? '本次测评：测试用例 × 知识库' : 'This Evaluation: Test Set × Knowledge Base';
  const desc = lang === 'zh'
    ? '展示本次测评用例和知识库的交互画像——用到哪些知识（使用情况）· 哪些知识想找但没找到或模型表达不确定（盲区）。'
    : 'How this test set interacts with the KB — which knowledge was exercised (usage) · which was missed or flagged as uncertain (gaps).';
  const readHint = lang === 'zh'
    ? '💡 读表：两者同时高 → 知识库内容有问题（有文件但答不出）· 同时低 → 测评用例太浅（没触到复杂场景）· 使用高 + 盲区低 → 理想但警惕用例驯化'
    : '💡 Read together: both high → KB content issues (files exist but can\'t answer) · both low → test set too shallow · high use + low gap → ideal, but beware sample-set overfitting';

  // 聚合所有 variant(coverage / gap 任一侧存在即纳入)
  const allVariants = Array.from(new Set<string>([
    ...(hasCov ? Object.keys(coverage!) : []),
    ...(hasGap ? Object.keys(gapReports!) : []),
  ]));

  const signalTypeLabels: Record<GapSignalRef['type'], { zh: string; en: string }> = {
    failed_search: { zh: '搜索未命中', en: 'Search miss' },
    explicit_marker: { zh: '模型标记缺口', en: 'Model-flagged gap' },
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
            <div style="margin-bottom:4px">${lang === 'zh' ? '💡 以下知识未被任何用例覆盖,建议补充测评用例:' : '💡 These knowledge files were not accessed — consider adding test cases:'}</div>
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
            ? `<strong>实际盲区 ${weightedPct}%</strong> · 另 ${softShare}% 为模型表达不确定(软信号,建议对照清单复核)`
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
        ? `展开 ${gap.signals.length} 条证据（按严重度上色: 红=确定 / 黄=模型自述 / 灰=犹豫）`
        : `Show all ${gap.signals.length} evidence items (red=confirmed · yellow=self-flagged · gray=hedging)`;
      gapInner = `
        <div class="ki-col-header">
          <span class="ki-col-title">${lang === 'zh' ? '知识盲区' : 'Knowledge gaps'}</span>
          <span class="ki-col-value" style="color:${pctColor}">${pct}%</span>
        </div>
        <div class="ki-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="${e(barLabel)}">
          <div class="ki-bar-fill" style="width:${barW}%;background:${pctColor}"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${gap.samplesWithGap}/${gap.sampleCount} ${lang === 'zh' ? '个用例出现搜索未命中或表达不确定' : 'samples with search miss / hedging'}</div>
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
    ? '本次测评中，哪些知识想找但没找到、或模型表达不确定。数字高不一定代表知识库不全——也可能是测试用例问的领域知识库未覆盖。'
    : 'Which knowledge the model tried to find but missed, or expressed uncertainty about. High numbers do not necessarily mean the KB is incomplete — the test set may be asking about areas the KB never covered.';

  const signalTypeLabels: Record<GapSignalRef['type'], { zh: string; en: string }> = {
    failed_search: { zh: '搜索未命中', en: 'Search miss' },
    explicit_marker: { zh: '模型标记缺口', en: 'Model-flagged gap' },
    hedging: { zh: '表达不确定', en: 'Hedging' },
    repeated_failure: { zh: '反复未命中', en: 'Repeated miss' },
  };
  const pickLabel = (key: GapSignalRef['type']): string => signalTypeLabels[key][lang === 'zh' ? 'zh' : 'en'];

  const variantSections = Object.entries(gapReports).map(([variant, report]) => {
    const pct = Math.round(report.gapRate * 100);
    // Color: lower gap rate is better (inverse of coverage). Gate at 10% / 30%.
    const pctColor = pct <= 10 ? 'var(--green)' : pct <= 30 ? 'var(--yellow)' : 'var(--red)';
    const barW = Math.max(2, pct);

    // v0.2 加权严重度 (spec §6):weightedGapRate 按样本最强信号权重聚合,总是 ≤ gapRate,
    // 差值反映"软信号(hedging / explicit_marker)占比"——若差值大,说明 gap_rate 被软信号
    // 拉高,读者该复核弱信号的真实含义。若差值小,说明信号以硬证据为主,结论可信度高。
    const weightedPct = Math.round(report.weightedGapRate * 100);
    const softSignalShare = pct - weightedPct;
    const weightedHint = lang === 'zh'
      ? (softSignalShare >= 10
          ? `<strong>实际盲区 ${weightedPct}%</strong> · 另外 ${softSignalShare}% 为模型表达不确定(软信号,建议对照右侧清单复核)`
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
        ${report.samplesWithGap} / ${report.sampleCount} ${lang === 'zh' ? '个样本出现搜索未命中或表达不确定' : 'samples with search miss or hedging'}
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
