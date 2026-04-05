import { e, fmtNum, fmtCost, fmtDuration, COLORS } from './helpers.js';
import { t } from './i18n.js';
import type { Lang, VariantSummary } from '../types.js';

export function renderSummaryCards(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  // Build comparison table: variants as rows, dimensions as columns
  const headerCols = [
    { key: 'dimQuality', label: t('dimQuality', lang) },
    { key: 'dimCost', label: t('dimCost', lang) },
    { key: 'dimEfficiency', label: t('dimEfficiency', lang) },
    { key: 'dimStability', label: t('dimStability', lang) },
  ];

  const thead = `<tr><th data-i18n="variants">${t('variants', lang)}</th>${headerCols.map((c) => `<th data-i18n="${c.key}">${c.label}</th>`).join('')}</tr>`;

  const rows = variants.map((v, i) => {
    const s = summary[v] || {} as VariantSummary;
    const color = COLORS[i % COLORS.length];

    // Quality — show composite + layered breakdown
    const score = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
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

    if (layeredDetailParts.length === 0) {
      // Fallback to old style if no layered scores
      if (s.minCompositeScore != null) { layeredDetailParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); hintParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); }
      if (s.avgAssertionScore != null) { layeredDetailParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); hintParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); }
      if (s.avgLlmScore != null) { layeredDetailParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); hintParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); }
    }

    const scoreNum = typeof score === 'number' ? score : 0;
    const scoreColor = scoreNum >= 4 ? 'var(--green)' : scoreNum >= 3 ? 'var(--yellow)' : scoreNum > 0 ? 'var(--red)' : 'var(--text-primary)';
    const qualityCell = `<td class="summary-cell"><div class="summary-value summary-value-primary" style="color:${scoreColor}">${score}</div><div class="summary-detail">${layeredDetailParts.join(' · ')}</div></td>`;

    // Cost — only show execution cost (judge cost is tool overhead, not skill cost)
    const execCost = s.totalExecCostUSD || 0;
    const hasCost = execCost > 0 || (s.avgTotalTokens || 0) > 0;
    const costCell = hasCost
      ? `<td class="summary-cell"><div class="summary-value">${fmtCost(execCost)}</div><div class="summary-detail">${fmtNum(s.avgTotalTokens)} tokens/${t('tokPerReq', lang).replace('tokens/', '')}</div></td>`
      : `<td class="summary-cell"><span style="color:var(--text-muted)">N/A</span></td>`;

    // Efficiency
    const effDetails: string[] = [];
    if ((s.avgNumTurns || 0) > 0) effDetails.push(`${s.avgNumTurns} ${t('turnsPerReq', lang)}`);
    if (s.avgToolCalls != null && s.avgToolCalls > 0) {
      const srPct = s.toolSuccessRate != null ? ` (${(s.toolSuccessRate * 100).toFixed(0)}% OK)` : '';
      effDetails.push(`${s.avgToolCalls} tools/req${srPct}`);
    }
    const totalDurationMs = (s.avgDurationMs || 0) * (s.successCount || 0);
    if (totalDurationMs > 0) effDetails.push(`${lang === 'zh' ? '总计' : 'total'} ${fmtDuration(totalDurationMs)}`);
    const effDetail = effDetails.length > 0 ? `<div class="summary-detail">${effDetails.join(' · ')}</div>` : '';
    const avgLabel = lang === 'zh' ? '次' : 'req';
    const effCell = `<td class="summary-cell"><div class="summary-value">${fmtDuration(s.avgDurationMs)}<span class="summary-unit">/${avgLabel}</span></div>${effDetail}</td>`;

    // Stability: primary = score range, detail = success rate + CV
    const total = s.totalSamples || 0;
    const successCount = s.successCount || 0;
    const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;

    let stabValue: string;
    let stabColor: string;
    if (s.minCompositeScore != null && s.maxCompositeScore != null) {
      const spread = s.maxCompositeScore - s.minCompositeScore;
      stabValue = s.minCompositeScore === s.maxCompositeScore
        ? `${s.minCompositeScore}`
        : `${s.minCompositeScore}~${s.maxCompositeScore}`;
      stabColor = spread <= 0.5 ? 'var(--green)' : spread <= 2 ? 'var(--yellow)' : 'var(--red)';
    } else {
      stabValue = `${successRate}%`;
      stabColor = successRate === 100 ? 'var(--green)' : successRate >= 90 ? 'var(--yellow)' : 'var(--red)';
    }

    const stabDetails: string[] = [];
    if ((s.errorCount || 0) > 0) {
      stabDetails.push(`<span style="color:var(--red)">${s.errorCount} ${t('errors', lang)}</span>`);
    }
    stabDetails.push(`${t('successRate', lang)} ${successRate}%`);
    if (s.scoreCV != null) {
      const cvPct = (s.scoreCV * 100).toFixed(0);
      stabDetails.push(`${lang === 'zh' ? '变异系数' : 'CV'} ${cvPct}%`);
    }
    const stabDetail = `<div class="summary-detail">${stabDetails.join(' · ')}</div>`;
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
    <tr><td ${dim}>${icon('🛡️')} <strong>稳定性</strong></td><td ${dimDesc}>多个样本间分数的波动程度</td></tr>
    <tr><td ${sub}>分数范围</td><td ${subDesc}>所有样本中的最低分 ~ 最高分，范围越窄越稳定</td></tr>
    <tr><td ${sub}>成功率</td><td ${subDesc}>评测任务成功完成的比例，失败包括超时、API 错误等</td></tr>
    <tr><td ${sub}>变异系数</td><td ${subDesc}>质量分数的标准差 ÷ 质量分数的平均值，衡量分数波动程度。越低越稳定，0% = 所有样本得分一致</td></tr>
  ` : `
    <tr><td ${dimFirst}>${icon('📊')} <strong>Quality</strong></td><td ${dimFirstDesc}>Equal-weight average of three layers (1-5): (Fact + Behavior + Quality) ÷ 3</td></tr>
    <tr><td ${sub}>Factual</td><td ${subDesc}>Are factual claims correct (keyword matching, format validation assertions)</td></tr>
    <tr><td ${sub}>Behavioral</td><td ${subDesc}>Is execution compliant (tool paths, turn limits, cost constraints)</td></tr>
    <tr><td ${sub}>Quality</td><td ${subDesc}>LLM judge subjective score on output quality</td></tr>
    <tr><td ${dim}>${icon('💰')} <strong>Cost</strong></td><td ${dimDesc}>API expense (execution only, excludes judge cost)</td></tr>
    <tr><td ${dim}>${icon('⚡')} <strong>Efficiency</strong></td><td ${dimDesc}>Average time per evaluation, with turn and tool call stats</td></tr>
    <tr><td ${dim}>${icon('🛡️')} <strong>Stability</strong></td><td ${dimDesc}>Score variance across samples</td></tr>
    <tr><td ${sub}>Score range</td><td ${subDesc}>Min ~ Max score across all samples. Narrower = more stable</td></tr>
    <tr><td ${sub}>Success rate</td><td ${subDesc}>Percentage of tasks completed successfully (failures include timeouts, API errors)</td></tr>
    <tr><td ${sub}>CV</td><td ${subDesc}>Coefficient of Variation = StdDev ÷ Mean. Lower is more stable, 0% = identical scores</td></tr>
  `;

  return `
    <h2 data-i18n="dimQuality" style="display:flex;align-items:center;gap:4px">${t('reportTitle', lang) === t('reportTitle', 'zh') ? '四维对比' : 'Comparison'} <span class="hint hint-click" tabindex="0" onclick="document.getElementById('${guideModalId}').style.display='flex'" aria-label="${e(guideTitle)}">?</span></h2>
    <div id="${guideModalId}" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${guideModalId}-title" onclick="if(event.target===this)this.style.display='none'">
      <div class="modal-content">
        <div class="modal-header">
          <strong id="${guideModalId}-title" style="font-size:1rem">${e(guideTitle)}</strong>
          <button class="modal-close" onclick="document.getElementById('${guideModalId}').style.display='none'" aria-label="${lang === 'zh' ? '关闭' : 'Close'}">✕</button>
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
