import { e } from './helpers.mjs';
import { t } from './i18n.mjs';

export function renderAnalysis(analysis, lang) {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const severityColors = { error: '#fee2e2', warning: '#fef3c7', info: '#dbeafe' };
  const severityTextColors = { error: '#991b1b', warning: '#92400e', info: '#1e40af' };

  const insightCards = (insights || []).map((ins) => {
    const bg = severityColors[ins.severity] || '#f1f5f9';
    const fg = severityTextColors[ins.severity] || '#334155';
    return `<div style="background:${bg};color:${fg};padding:12px 16px;border-radius:6px;margin:6px 0;font-size:14px">${e(ins.message)}</div>`;
  }).join('');

  const suggestionList = (suggestions || []).length > 0
    ? `<ul style="margin:8px 0;padding-left:20px;font-size:14px;color:#475569">${suggestions.map((s) => `<li>${e(s)}</li>`).join('')}</ul>`
    : '';

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${insightCards}
    ${suggestionList}
  `;
}
