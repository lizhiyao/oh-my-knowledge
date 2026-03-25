import { e, fmtNum, delta, COLORS } from './helpers.mjs';
import { t } from './i18n.mjs';

export function renderSampleTable(variants, results, report, lang) {
  const headerCols = variants.map((v) =>
    `<th>${e(v)} <span data-i18n="scoreCol">${t('scoreCol', lang)}</span></th><th>${e(v)} <span data-i18n="tokensCol">${t('tokensCol', lang)}</span></th><th>${e(v)} <span data-i18n="msCol">${t('msCol', lang)}</span></th>`
  ).join('');

  const sampleRows = results.map((r) => {
    const cols = variants.map((v, i) => {
      const d = r.variants?.[v];
      if (!d) return '<td>-</td><td>-</td><td>-</td>';

      const score = d.compositeScore ?? d.llmScore;
      const scoreClass = d.ok ? 'badge-ok' : 'badge-err';
      const scoreText = typeof score === 'number' ? score : (d.ok ? 'OK' : 'ERR');

      let assertionHtml = '';
      if (d.assertions?.details) {
        const items = d.assertions.details.map((a) => {
          const icon = a.passed ? '&#10003;' : '&#10007;';
          const cls = a.passed ? 'badge-pass' : 'badge-fail';
          return `<li><span class="badge ${cls}" style="font-size:10px;padding:1px 4px">${icon}</span> ${e(a.type)}: ${e(a.value)}</li>`;
        }).join('');
        assertionHtml = `<ul class="assertion-list">${items}</ul>`;
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
        ? `<br><span style="font-size:11px;color:#64748b">${e(d.llmReason.slice(0, 80))}</span>`
        : '';

      const firstV = r.variants?.[variants[0]];
      const tokenDelta = i > 0 && firstV ? delta(firstV.totalTokens, d.totalTokens, true) : '';
      const msDelta = i > 0 && firstV ? delta(firstV.durationMs, d.durationMs, true) : '';

      const existingFeedback = (r.humanFeedback || []).filter((f) => f.variant === v);
      const feedbackDisplay = existingFeedback.length > 0
        ? existingFeedback.map((f) => `<div style="font-size:11px;color:#64748b;margin-top:2px">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} ${f.comment ? e(f.comment) : ''}</div>`).join('')
        : '';

      return `<td><span class="badge ${scoreClass}">${scoreText}</span>${reasonHtml}${assertionHtml}${dimHtml}${feedbackDisplay}</td><td>${fmtNum(d.totalTokens)}${tokenDelta}</td><td>${fmtNum(d.durationMs)}${msDelta}</td>`;
    }).join('');

    const feedbackCols = renderFeedbackRow(variants, r, report, lang);

    return `<tr><td><strong>${e(r.sample_id)}</strong></td>${cols}</tr>
    <tr style="background:#fafafa"><td style="font-size:11px;color:#94a3b8" data-i18n="feedback">${t('feedback', lang)}</td>${feedbackCols}</tr>`;
  }).join('');

  return `
    <h2 data-i18n="perSampleDetail">${t('perSampleDetail', lang)}</h2>
    <table>
      <thead><tr><th data-i18n="sample">${t('sample', lang)}</th>${headerCols}</tr></thead>
      <tbody>${sampleRows}</tbody>
    </table>`;
}

function renderFeedbackRow(variants, r, report, lang) {
  return variants.map((v) => {
    const formId = `fb-${r.sample_id}-${v}`.replace(/[^a-zA-Z0-9-]/g, '_');
    return `<td colspan="3">
      <div style="display:flex;align-items:center;gap:6px;font-size:12px" id="${formId}">
        <span class="stars" style="cursor:pointer;font-size:16px" data-rating="0"
          onclick="(function(el,evt){var t=evt.target;if(t.dataset.star){var r=+t.dataset.star;el.dataset.rating=r;var s=el.children;for(var i=0;i<5;i++){s[i].style.color=i<r?'#f59e0b':'#cbd5e1'}}})(this,event)">
          <span data-star="1" style="color:#cbd5e1">&#9733;</span>
          <span data-star="2" style="color:#cbd5e1">&#9733;</span>
          <span data-star="3" style="color:#cbd5e1">&#9733;</span>
          <span data-star="4" style="color:#cbd5e1">&#9733;</span>
          <span data-star="5" style="color:#cbd5e1">&#9733;</span>
        </span>
        <input type="text" placeholder="${t('feedbackPlaceholder', lang)}" data-i18n="feedbackPlaceholder" style="border:1px solid #e2e8f0;border-radius:4px;padding:2px 6px;font-size:12px;width:120px" />
        <button onclick="submitFeedback('${e(report.id)}','${e(r.sample_id)}','${e(v)}',this)" style="padding:2px 8px;border:1px solid #e2e8f0;border-radius:4px;background:#f8fafc;cursor:pointer;font-size:12px" data-i18n="feedbackSubmit">${t('feedbackSubmit', lang)}</button>
      </div>
    </td>`;
  }).join('');
}
