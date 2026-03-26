import { e, fmtNum, fmtCost, COLORS } from './helpers.mjs';
import { t } from './i18n.mjs';

export function renderSummaryCards(variants, summary, lang) {
  const dimensionSections = [
    {
      titleKey: 'dimQuality',
      descKey: 'dimQualityDesc',
      render: (s) => {
        const mainScore = s.avgCompositeScore ?? s.avgLlmScore ?? '-';
        const range = s.minCompositeScore != null
          ? `<div><span data-i18n="scoreRange">${t('scoreRange', lang)}</span>: ${s.minCompositeScore} ~ ${s.maxCompositeScore}</div>`
          : '';
        return `
          <div class="card-value">${mainScore}</div>
          <div class="card-sub" data-i18n="compositeScore">${t('compositeScore', lang)}</div>
          <div style="margin-top:8px;font-size:13px">
            ${range}
            ${s.avgAssertionScore != null ? `<div title="${t('assertionsDesc', lang)}"><span data-i18n="assertions">${t('assertions', lang)}</span>: ${s.avgAssertionScore}</div>` : ''}
            ${s.avgLlmScore != null ? `<div title="${t('llmJudgeDesc', lang)}"><span data-i18n="llmJudge">${t('llmJudge', lang)}</span>: ${s.avgLlmScore} (${s.minLlmScore}~${s.maxLlmScore})</div>` : ''}
          </div>`;
      },
    },
    {
      titleKey: 'dimCost',
      descKey: 'dimCostDesc',
      render: (s) => {
        const hasData = s.totalCostUSD > 0 || s.avgTotalTokens > 0;
        if (!hasData) {
          return `
            <div class="card-value" style="color:#94a3b8">N/A</div>
            <div class="card-sub" style="color:#475569">脚本模式下无法自动采集</div>`;
        }
        return `
          <div class="card-value">${fmtCost(s.totalCostUSD)}</div>
          <div class="card-sub" data-i18n="totalCost">${t('totalCost', lang)}</div>
          <div style="margin-top:8px;font-size:13px">
            <div><span data-i18n="inputTokens">${t('inputTokens', lang)}</span>: ${fmtNum(s.avgInputTokens)} tokens</div>
            <div><span data-i18n="outputTokens">${t('outputTokens', lang)}</span>: ${fmtNum(s.avgOutputTokens)} tokens</div>
            <div><span data-i18n="totalTokens">${t('totalTokens', lang)}</span>: ${fmtNum(s.avgTotalTokens)} ${t('tokPerReq', lang)}</div>
          </div>`;
      },
    },
    {
      titleKey: 'dimEfficiency',
      descKey: 'dimEfficiencyDesc',
      render: (s) => `
        <div class="card-value">${fmtNum(s.avgDurationMs)}<span style="font-size:14px">ms</span></div>
        <div class="card-sub" data-i18n="avgLatency">${t('avgLatency', lang)}</div>`,
    },
    {
      titleKey: 'dimStability',
      descKey: 'dimStabilityDesc',
      render: (s) => {
        const total = s.totalSamples || 0;
        const successCount = s.successCount || 0;
        const successRate = total > 0 ? Number((successCount / total * 100).toFixed(1)) : 0;
        const rateColor = successRate === 100 ? '#4ade80' : successRate >= 90 ? '#fbbf24' : '#f87171';
        return `
          <div class="card-value" style="color:${rateColor}">${successRate}%</div>
          <div class="card-sub" data-i18n="successRate">${t('successRate', lang)}</div>
          <div style="margin-top:8px;font-size:13px">
            <div><span data-i18n="success">${t('success', lang)}</span>: ${successCount}/${total}</div>
            ${s.errorCount > 0 ? `<div><span data-i18n="errors">${t('errors', lang)}</span>: ${s.errorCount}</div>` : ''}
          </div>`;
      },
    },
  ];

  return dimensionSections.map((dim) => {
    const variantCards = variants.map((v, i) => {
      const s = summary[v] || {};
      const color = COLORS[i % COLORS.length];
      return `<div class="card" style="border-top:3px solid ${color}">
        <div class="card-label">${e(v)}</div>
        ${dim.render(s)}
      </div>`;
    }).join('');
    return `<h2 data-i18n="${dim.titleKey}">${t(dim.titleKey, lang)}</h2><span class="dim-desc" data-i18n="${dim.descKey}">${t(dim.descKey, lang)}</span><div class="cards">${variantCards}</div>`;
  }).join('');
}
