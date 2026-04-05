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

const SEVERITY_ICON: Record<string, string> = {
  error: '&#xe001;',   // placeholder — we use colored dots instead
  warning: '&#xe001;',
  info: '&#xe001;',
};

function severityDot(severity: string): string {
  const color: Record<string, string> = {
    error: 'var(--red)',
    warning: 'var(--yellow)',
    info: 'var(--accent)',
  };
  return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${color[severity] || 'var(--text-muted)'};margin-right:8px;flex-shrink:0;margin-top:6px"></span>`;
}

/**
 * Parse summary text with 【section】 markers into structured HTML.
 * Each section gets its own visual treatment.
 */
function renderSummaryStructured(summary: string): string {
  // Split by 【label】 markers — collect all marker positions first, then slice
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

  // Fallback: no sections found, render as plain text
  if (sections.length === 0) {
    return `<div style="padding:14px 18px;font-size:13px;line-height:1.8;color:var(--text-secondary);background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border)">${e(summary)}</div>`;
  }

  const sectionHtml = sections.map((sec) => {
    const color = 'var(--text-muted)';

    return `
      <div style="display:flex;gap:12px;align-items:baseline">
        <span style="flex-shrink:0;font-size:11px;font-weight:600;color:${color};letter-spacing:0.03em;min-width:56px">${e(sec.label)}</span>
        <span style="color:var(--text-secondary);font-size:13px;line-height:1.7">${e(sec.content)}</span>
      </div>`;
  }).join('');

  return `
    <div style="padding:14px 18px;background:var(--bg-surface);border-radius:var(--radius);border:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      ${sectionHtml}
    </div>`;
}

export function renderAnalysis(analysis: AnalysisResult | undefined, lang: Lang): string {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  // Issues = everything except conclusions (conclusions are covered by summary)
  const issues = (insights || []).filter((ins) => !isConclusion(ins));

  const issueLabel = lang === 'zh' ? '问题与建议' : 'Issues & Suggestions';
  const safesuggestions = suggestions || [];

  let issuesHtml = '';
  if (issues.length > 0 || safesuggestions.length > 0) {
    const maxRows = Math.max(issues.length, safesuggestions.length);
    const rows: string[] = [];
    for (let i = 0; i < maxRows; i++) {
      const issue = issues[i];
      const suggestion = safesuggestions[i];

      const issueContent = issue
        ? `${severityDot(issue.severity)}<span>${e(issue.message)}</span>`
        : '';
      const suggestContent = suggestion
        ? e(suggestion)
        : `<span style="color:var(--text-faint)">—</span>`;

      rows.push(`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:10px 16px;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:flex-start;color:var(--text-secondary);font-size:12.5px;line-height:1.6">${issueContent}</div>
          <div style="color:var(--text-muted);font-size:12.5px;line-height:1.6">${suggestContent}</div>
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
