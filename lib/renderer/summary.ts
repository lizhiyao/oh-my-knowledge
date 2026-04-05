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
    const factTip = lang === 'zh' ? '输出内容中的事实性声明是否正确（关键词匹配、格式校验等）' : 'Are factual claims in the output correct';
    const behaviorTip = lang === 'zh' ? '执行过程是否合规（工具调用路径、轮次限制、成本约束等）' : 'Is the execution process compliant';
    const qualityTip3 = lang === 'zh' ? 'LLM 评委对输出整体质量的主观评分' : 'LLM judge subjective score on overall output quality';

    // Layered detail (HTML for rendering)
    const layeredDetailParts: string[] = [];
    // Plain text for hint tooltip
    const hintParts: string[] = [];

    if (s.avgFactScore != null) {
      layeredDetailParts.push(`<span title="${e(factTip)}" style="cursor:help;border-bottom:1px dotted var(--text-muted)">${factLabel}: ${s.avgFactScore}</span>`);
      hintParts.push(`${factLabel}: ${s.avgFactScore}`);
    }
    if (s.avgBehaviorScore != null) {
      layeredDetailParts.push(`<span title="${e(behaviorTip)}" style="cursor:help;border-bottom:1px dotted var(--text-muted)">${behaviorLabel}: ${s.avgBehaviorScore}</span>`);
      hintParts.push(`${behaviorLabel}: ${s.avgBehaviorScore}`);
    }
    if (s.avgQualityScore != null) {
      layeredDetailParts.push(`<span title="${e(qualityTip3)}" style="cursor:help;border-bottom:1px dotted var(--text-muted)">${qualityLabel}: ${s.avgQualityScore}</span>`);
      hintParts.push(`${qualityLabel}: ${s.avgQualityScore}`);
    }

    if (layeredDetailParts.length === 0) {
      // Fallback to old style if no layered scores
      if (s.minCompositeScore != null) { layeredDetailParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); hintParts.push(`${s.minCompositeScore}~${s.maxCompositeScore}`); }
      if (s.avgAssertionScore != null) { layeredDetailParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); hintParts.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`); }
      if (s.avgLlmScore != null) { layeredDetailParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); hintParts.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`); }
    }

    const hintText = hintParts.join(' · ');
    const qualityHint = hintText ? `<span class="hint" tabindex="0" aria-label="${e(hintText)}">?<span class="hint-tip">${e(hintText)}</span></span>` : '';
    const qualityCell = `<td class="summary-cell"><div class="summary-value summary-value-primary">${score}${qualityHint}</div><div class="summary-detail">${layeredDetailParts.join(' · ')}</div></td>`;

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
      const cvHint = `<span class="hint" tabindex="0" aria-label="${e(t('cvDesc', lang))}">?<span class="hint-tip">${e(t('cvDesc', lang))}</span></span>`;
      stabDetails.push(`CV ${cvPct}%${cvHint}`);
    }
    const stabDetail = `<div class="summary-detail">${stabDetails.join(' · ')}</div>`;
    const stabCell = `<td class="summary-cell"><div class="summary-value" style="color:${stabColor}">${stabValue}</div>${stabDetail}</td>`;

    return `<tr><td style="border-left:3px solid ${color};padding-left:12px"><strong>${e(v)}</strong></td>${qualityCell}${costCell}${effCell}${stabCell}</tr>`;
  }).join('');

  const guideModalId = 'guide-four-dims';
  const guideContent = lang === 'zh' ? `
    <h3>如何阅读四维对比</h3>
    <p>每行是一个实验分组（Variant），四列分别衡量不同维度：</p>
    <table style="width:100%;font-size:13px;margin:12px 0">
      <tr><td style="padding:6px 0"><strong>📊 质量</strong></td><td style="padding:6px 0">综合三层评分的平均值（1-5 分）</td></tr>
      <tr><td style="padding:6px 0;padding-left:20px">事实性</td><td style="padding:6px 0;color:var(--text-muted)">输出内容中的事实声明是否正确（关键词匹配、格式校验等断言）</td></tr>
      <tr><td style="padding:6px 0;padding-left:20px">行为合规</td><td style="padding:6px 0;color:var(--text-muted)">执行过程是否合规（工具调用路径、轮次限制、成本约束等断言）</td></tr>
      <tr><td style="padding:6px 0;padding-left:20px">质量</td><td style="padding:6px 0;color:var(--text-muted)">LLM 评委对输出整体质量的主观评分</td></tr>
      <tr><td style="padding:6px 0"><strong>💰 成本</strong></td><td style="padding:6px 0">API 调用费用（仅执行成本，不含评分成本）</td></tr>
      <tr><td style="padding:6px 0"><strong>⚡ 效率</strong></td><td style="padding:6px 0">单次评测的平均耗时，含轮次和工具调用统计</td></tr>
      <tr><td style="padding:6px 0"><strong>🛡️ 稳定性</strong></td><td style="padding:6px 0">多个样本间分数的波动程度（分数范围、成功率、变异系数）</td></tr>
    </table>
  ` : `
    <h3>How to read this table</h3>
    <p>Each row is a Variant. Four columns measure different dimensions:</p>
    <table style="width:100%;font-size:13px;margin:12px 0">
      <tr><td style="padding:6px 0"><strong>📊 Quality</strong></td><td style="padding:6px 0">Average of three scoring layers (1-5)</td></tr>
      <tr><td style="padding:6px 0;padding-left:20px">Factual</td><td style="padding:6px 0;color:var(--text-muted)">Are factual claims correct (keyword matching, format validation assertions)</td></tr>
      <tr><td style="padding:6px 0;padding-left:20px">Behavioral</td><td style="padding:6px 0;color:var(--text-muted)">Is execution compliant (tool paths, turn limits, cost constraints assertions)</td></tr>
      <tr><td style="padding:6px 0;padding-left:20px">Quality</td><td style="padding:6px 0;color:var(--text-muted)">LLM judge subjective score on output quality</td></tr>
      <tr><td style="padding:6px 0"><strong>💰 Cost</strong></td><td style="padding:6px 0">API expense (execution only, excludes judge cost)</td></tr>
      <tr><td style="padding:6px 0"><strong>⚡ Efficiency</strong></td><td style="padding:6px 0">Average time per evaluation, with turn and tool call stats</td></tr>
      <tr><td style="padding:6px 0"><strong>🛡️ Stability</strong></td><td style="padding:6px 0">Score variance across samples (range, success rate, CV)</td></tr>
    </table>
  `;

  return `
    <h2 data-i18n="dimQuality" style="display:flex;align-items:center;gap:4px">${t('reportTitle', lang) === t('reportTitle', 'zh') ? '四维对比' : 'Comparison'} <span class="hint" tabindex="0" onclick="document.getElementById('${guideModalId}').style.display='flex'" style="cursor:pointer">?</span></h2>
    <div id="${guideModalId}" style="display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.6);align-items:center;justify-content:center" onclick="if(event.target===this)this.style.display='none'">
      <div style="background:var(--bg-card,#1e293b);border:1px solid var(--border);border-radius:var(--radius);max-width:600px;max-height:80vh;overflow:auto;padding:24px;margin:20px;width:90%">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:15px">${lang === 'zh' ? '四维对比' : 'Comparison'}</strong>
          <button onclick="document.getElementById('${guideModalId}').style.display='none'" style="cursor:pointer;background:none;border:none;color:var(--text-muted);font-size:18px">✕</button>
        </div>
        ${guideContent}
      </div>
    </div>
    <div class="table-wrap">
    <table class="summary-table">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}
