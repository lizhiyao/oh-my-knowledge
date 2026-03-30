import { e, fmtNum, fmtCost, COLORS } from './helpers.mjs';
import { t } from './i18n.mjs';

export function renderSummaryCards(variants, summary, lang) {
  // Build comparison table: variants as rows, dimensions as columns
  const headerCols = [
    { key: 'dimQuality', label: t('dimQuality', lang) },
    { key: 'dimCost', label: t('dimCost', lang) },
    { key: 'dimEfficiency', label: t('dimEfficiency', lang) },
    { key: 'dimStability', label: t('dimStability', lang) },
  ];

  const thead = `<tr><th></th>${headerCols.map((c) => `<th data-i18n="${c.key}">${c.label}</th>`).join('')}</tr>`;

  const rows = variants.map((v, i) => {
    const s = summary[v] || {};
    const color = COLORS[i % COLORS.length];

    // Quality
    const score = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
    const qualityDetail = [];
    if (s.minCompositeScore != null) qualityDetail.push(`${s.minCompositeScore}~${s.maxCompositeScore}`);
    if (s.avgAssertionScore != null) qualityDetail.push(`${t('assertions', lang)}: ${s.avgAssertionScore}`);
    if (s.avgLlmScore != null) qualityDetail.push(`${t('llmJudge', lang)}: ${s.avgLlmScore}`);
    const qualityTip = qualityDetail.length ? qualityDetail.join(' · ') : '';
    const qualityHint = qualityTip ? `<span class="hint" tabindex="0" aria-label="${e(qualityTip)}">?<span class="hint-tip">${e(qualityTip)}</span></span>` : '';
    const qualityCell = `<td class="summary-cell"><div class="summary-value summary-value-primary">${score}${qualityHint}</div></td>`;

    // Cost
    const hasCost = s.totalCostUSD > 0 || s.avgTotalTokens > 0;
    const costCell = hasCost
      ? `<td class="summary-cell"><div class="summary-value">${fmtCost(s.totalCostUSD)}</div><div class="summary-detail">${fmtNum(s.avgTotalTokens)} tokens/${t('tokPerReq', lang).replace('tokens/', '')}</div></td>`
      : `<td class="summary-cell"><span style="color:var(--text-muted)">N/A</span></td>`;

    // Efficiency
    const turnsDetail = s.avgNumTurns > 0 ? `<div class="summary-detail">${s.avgNumTurns} ${t('turnsPerReq', lang)}</div>` : '';
    const effCell = `<td class="summary-cell"><div class="summary-value">${fmtNum(s.avgDurationMs)}<span class="summary-unit">ms</span></div>${turnsDetail}</td>`;

    // Stability: primary = score range, detail = success rate + CV
    const total = s.totalSamples || 0;
    const successCount = s.successCount || 0;
    const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;

    let stabValue;
    let stabColor;
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

    const stabDetails = [];
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

  return `
    <h2 data-i18n="dimQuality">${t('reportTitle', lang) === t('reportTitle', 'zh') ? '四维对比' : 'Comparison'}</h2>
    <div class="table-wrap">
    <table class="summary-table">
      <thead>${thead}</thead>
      <tbody>${rows}</tbody>
    </table>
    </div>`;
}
