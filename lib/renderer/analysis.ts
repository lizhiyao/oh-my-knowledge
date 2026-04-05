import { e } from './helpers.js';
import { t } from './i18n.js';
import type { Lang, AnalysisResult, Insight } from '../types.js';

// Part 1: Experiment conclusions — only objective comparison findings
const CONCLUSION_TYPES = new Set([
  'efficiency_gap', 'tool_count_gap', 'high_cost_sample',
]);

function isConclusion(ins: Insight): boolean {
  return CONCLUSION_TYPES.has(ins.type);
}

export function renderAnalysis(analysis: AnalysisResult | undefined, lang: Lang): string {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const severityBorder: Record<string, string> = { error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--accent)' };

  // Split into two parts
  const conclusions = (insights || []).filter((ins) => isConclusion(ins));
  const issues = (insights || []).filter((ins) => !isConclusion(ins));

  // Part 1: Experiment conclusions
  const conclusionLabel = lang === 'zh' ? '实验结论' : 'Findings';
  const conclusionsHtml = conclusions.length > 0 ? `
    <h3 style="font-size:13px;color:var(--text-muted);font-weight:600;margin:12px 0 6px">${conclusionLabel}</h3>
    ${conclusions.map((ins) => {
      return `<div style="border-left:3px solid var(--accent);padding:8px 14px;margin:6px 0;font-size:13px;color:var(--text-primary);background:var(--bg-surface);border-radius:var(--radius)">${e(ins.message)}</div>`;
    }).join('')}
  ` : '';

  // Part 2: Issues + suggestions paired in a table
  // Try to pair each issue with a corresponding suggestion (by index)
  const issueLabel = lang === 'zh' ? '问题与建议' : 'Issues & Suggestions';
  const issueColHeader = lang === 'zh' ? '问题' : 'Issue';
  const suggestColHeader = lang === 'zh' ? '建议' : 'Suggestion';
  const safesuggestions = suggestions || [];

  let issuesTableHtml = '';
  if (issues.length > 0 || safesuggestions.length > 0) {
    const maxRows = Math.max(issues.length, safesuggestions.length);
    const rows: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const issue = issues[i];
      const suggestion = safesuggestions[i];
      const issueCell = issue
        ? e(issue.message)
        : '';
      const suggestCell = suggestion ? e(suggestion) : `<span style="color:var(--text-muted)">—</span>`;
      rows.push(`<tr><td style="vertical-align:top">${issueCell}</td><td style="vertical-align:top">${suggestCell}</td></tr>`);
    }

    issuesTableHtml = `
      <h3 style="font-size:13px;color:var(--text-muted);font-weight:600;margin:16px 0 6px">${issueLabel}</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${issueColHeader}</th><th>${suggestColHeader}</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
    `;
  }

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${conclusionsHtml}
    ${issuesTableHtml}
  `;
}
