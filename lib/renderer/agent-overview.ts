import { e, COLORS } from './helpers.js';
import { t } from './i18n.js';
import type { Lang, VariantSummary } from '../types.js';

/**
 * Render agent execution overview section.
 * Only renders when any variant has tool call data.
 */
export function renderAgentOverview(variants: string[], summary: Record<string, VariantSummary>, lang: Lang): string {
  const hasAgentData = variants.some((v) => summary[v]?.avgToolCalls != null && summary[v].avgToolCalls! > 0);
  if (!hasAgentData) return '';

  // Per-variant agent metrics cards
  const variantCards = variants.map((v, i) => {
    const s = summary[v];
    if (!s) return '';
    const color = COLORS[i % COLORS.length];
    const avgTools = s.avgToolCalls ?? 0;
    const successRate = s.toolSuccessRate != null ? `${(s.toolSuccessRate * 100).toFixed(0)}%` : '-';
    const srColor = (s.toolSuccessRate ?? 1) >= 0.8 ? 'var(--green)' : 'var(--red)';
    const turns = s.avgNumTurns || 0;

    // Tool distribution bar
    const dist = s.toolDistribution || {};
    const distEntries = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    const maxCount = distEntries.length > 0 ? distEntries[0][1] : 0;
    const distBars = distEntries.map(([tool, count]) => {
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
      <div style="font-weight:600;margin-bottom:12px">${e(v)}</div>
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
          <div style="font-size:20px;font-weight:600;color:${srColor}">${successRate}</div>
        </div>
      </div>
      ${distEntries.length > 0 ? `
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${t('agentToolDist', lang)}</div>
        ${distBars}
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
