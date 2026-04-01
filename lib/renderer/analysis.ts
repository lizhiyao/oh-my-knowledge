import { e } from './helpers.js';
import { t } from './i18n.js';
import type { Lang, AnalysisResult } from '../types.js';

export function renderAnalysis(analysis: AnalysisResult | undefined, lang: Lang): string {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const severityBorder: Record<string, string> = { error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--accent)' };

  const hasInsights = insights && insights.length > 0;
  const hasSuggestions = suggestions && suggestions.length > 0;

  const insightsHtml = hasInsights ? `
    <h3 style="font-size:13px;color:var(--text-muted);font-weight:600;margin:12px 0 6px">${lang === 'zh' ? '发现的问题' : 'Issues Found'}</h3>
    ${insights.map((ins) => {
      const border = severityBorder[ins.severity] || 'var(--border)';
      return `<div role="alert" style="border-left:3px solid ${border};padding:8px 14px;margin:6px 0;font-size:13px;color:var(--text-primary);background:var(--bg-surface);border-radius:var(--radius)">${e(ins.message)}</div>`;
    }).join('')}` : '';

  const suggestionsHtml = hasSuggestions ? `
    <h3 style="font-size:13px;color:var(--text-muted);font-weight:600;margin:16px 0 6px">${lang === 'zh' ? '改进建议' : 'Suggestions'}</h3>
    ${suggestions.map((s, i) => {
      const prefix = suggestions.length > 1 ? `<span style="color:var(--text-muted);margin-right:6px">${i + 1}.</span>` : '';
      return `<div style="border-left:3px solid var(--green);padding:8px 14px;margin:6px 0;font-size:13px;color:var(--text-primary);background:var(--bg-surface);border-radius:var(--radius)">${prefix}${e(s)}</div>`;
    }).join('')}` : '';

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${insightsHtml}
    ${suggestionsHtml}
  `;
}
