import { e } from './helpers.js';
import { t } from './i18n.js';
import type { Lang, AnalysisResult, Insight } from '../types.js';

// Classify insights into three categories
const FINDING_TYPES = new Set([
  'efficiency_gap', 'tool_count_gap', 'uniform_scores', 'high_cost_sample',
  'agent_assertion_discrimination_ok',
]);

const ISSUE_TYPES = new Set([
  'low_tool_success_rate', 'tool_permission_error', 'trace_integrity_gap',
  'all_fail',
]);

// Everything else is methodology (low_discrimination_*, all_pass, suggest_repeat, agent_assertion_discrimination_low)

function classifyInsight(ins: Insight): 'finding' | 'issue' | 'methodology' {
  if (FINDING_TYPES.has(ins.type)) return 'finding';
  if (ISSUE_TYPES.has(ins.type)) return 'issue';
  return 'methodology';
}

export function renderAnalysis(analysis: AnalysisResult | undefined, lang: Lang): string {
  if (!analysis) return '';
  const { insights, suggestions } = analysis;
  if ((!insights || insights.length === 0) && (!suggestions || suggestions.length === 0)) return '';

  const severityBorder: Record<string, string> = { error: 'var(--red)', warning: 'var(--yellow)', info: 'var(--accent)' };

  const findings = (insights || []).filter((ins) => classifyInsight(ins) === 'finding');
  const issues = (insights || []).filter((ins) => classifyInsight(ins) === 'issue');
  const methodology = (insights || []).filter((ins) => classifyInsight(ins) === 'methodology');

  function renderGroup(items: Insight[]): string {
    return items.map((ins) => {
      const border = severityBorder[ins.severity] || 'var(--border)';
      return `<div style="border-left:3px solid ${border};padding:8px 14px;margin:6px 0;font-size:13px;color:var(--text-primary);background:var(--bg-surface);border-radius:var(--radius)">${e(ins.message)}</div>`;
    }).join('');
  }

  const findingsLabel = lang === 'zh' ? '实验结论' : 'Findings';
  const issuesLabel = lang === 'zh' ? '需要关注' : 'Issues';
  const methodLabel = lang === 'zh' ? '测评方法改进' : 'Methodology';
  const suggestLabel = lang === 'zh' ? '改进建议' : 'Suggestions';

  const sectionStyle = 'font-size:13px;color:var(--text-muted);font-weight:600;margin:16px 0 6px';

  const findingsHtml = findings.length > 0
    ? `<h3 style="${sectionStyle}">${findingsLabel}</h3>${renderGroup(findings)}`
    : '';

  const issuesHtml = issues.length > 0
    ? `<h3 style="${sectionStyle}">${issuesLabel}</h3>${renderGroup(issues)}`
    : '';

  const methodHtml = methodology.length > 0
    ? `<h3 style="${sectionStyle}">${methodLabel}</h3>${renderGroup(methodology)}`
    : '';

  const suggestionsHtml = suggestions && suggestions.length > 0 ? `
    <h3 style="${sectionStyle}">${suggestLabel}</h3>
    ${suggestions.map((s, i) => {
      const prefix = suggestions.length > 1 ? `<span style="color:var(--text-muted);margin-right:6px">${i + 1}.</span>` : '';
      return `<div style="border-left:3px solid var(--green);padding:8px 14px;margin:6px 0;font-size:13px;color:var(--text-primary);background:var(--bg-surface);border-radius:var(--radius)">${prefix}${e(s)}</div>`;
    }).join('')}` : '';

  return `
    <h2 data-i18n="autoAnalysis">${t('autoAnalysis', lang)}</h2>
    ${findingsHtml}
    ${issuesHtml}
    ${methodHtml}
    ${suggestionsHtml}
  `;
}
