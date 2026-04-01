import { e, fmtNum, delta } from './helpers.js';
import { t } from './i18n.js';
import type { Lang, ResultEntry, Report } from '../types.js';

export function renderSampleTable(variants: string[], results: ResultEntry[], report: { meta: { variants: string[] } }, lang: Lang): string {
  const headerCols = variants.map((v) =>
    `<th>${e(v)} <span data-i18n="scoreCol">${t('scoreCol', lang)}</span></th><th>${e(v)} <span data-i18n="tokensCol">${t('tokensCol', lang)}</span></th><th>${e(v)} <span data-i18n="msCol">${t('msCol', lang)}</span></th>`
  ).join('');

  const sampleRows = results.map((r) => {
    const cols = variants.map((v, i) => {
      const d = r.variants?.[v];
      if (!d) return '<td>-</td><td>-</td><td>-</td>';

      const score = d.compositeScore ?? d.llmScore;
      const hasScore = typeof score === 'number';
      const scoreClass = !d.ok ? 'badge-err' : hasScore ? 'badge-ok' : 'badge-muted';
      const scoreText = hasScore ? score : (d.ok ? '-' : 'ERR');

      const errorHtml = !d.ok && d.error
        ? `<br><span class="error-detail">${e(d.error)}</span>`
        : '';

      // Only show failed assertions
      let assertionHtml = '';
      if (d.assertions?.details) {
        const failed = d.assertions.details.filter((a) => !a.passed);
        if (failed.length > 0) {
          const items = failed.map((a) =>
            `<li><span class="badge badge-fail" style="font-size:10px;padding:1px 4px">&#10007;</span> ${e(a.type)}: ${e(a.value)}</li>`
          ).join('');
          assertionHtml = `<ul class="assertion-list">${items}</ul>`;
        }
      }

      let dimHtml = '';
      if (d.dimensions) {
        const tags = Object.entries(d.dimensions).map(([dim, info]) => {
          const s = typeof info === 'object' ? info.score : info;
          return `<span class="dim-tag">${e(dim)}: ${s}</span>`;
        }).join('');
        dimHtml = `<div class="dim-scores">${tags}</div>`;
      }

      const reasonHtml = d.llmReason
        ? `<br><span style="font-size:11px;color:var(--text-muted)">${e(d.llmReason?.slice(0, 80))}</span>`
        : '';

      const firstV = r.variants?.[variants[0]];
      const tokenDelta = i > 0 && firstV ? delta(firstV.totalTokens, d.totalTokens, true) : '';
      const msDelta = i > 0 && firstV ? delta(firstV.durationMs, d.durationMs, true) : '';

      return `<td><span class="badge ${scoreClass}">${scoreText}</span>${errorHtml}${reasonHtml}${assertionHtml}${dimHtml}</td><td>${fmtNum(d.totalTokens)}${tokenDelta}</td><td>${fmtNum(d.durationMs)}${msDelta}</td>`;
    }).join('');

    return `<tr><td><strong>${e(r.sample_id)}</strong></td>${cols}</tr>`;
  }).join('');

  return `
    <h2 data-i18n="perSampleDetail">${t('perSampleDetail', lang)}</h2>
    <div class="table-wrap">
    <table>
      <thead><tr><th data-i18n="sample">${t('sample', lang)}</th>${headerCols}</tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>
    </div>`;
}
