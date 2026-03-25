/**
 * HTML report renderer — orchestrates sub-modules.
 */

import { e, fmtCost, fmtLocalTime, barChart, COLORS } from './renderer/helpers.mjs';
import { DEFAULT_LANG, t } from './renderer/i18n.mjs';
import { layout } from './renderer/layout.mjs';
import { renderSummaryCards } from './renderer/summary.mjs';
import { renderAnalysis } from './renderer/analysis.mjs';
import { renderSampleTable } from './renderer/table.mjs';

export function renderRunList(runs, lang = DEFAULT_LANG) {
  if (!runs || runs.length === 0) {
    return layout(t('title', lang), `
      <h1>${t('title', lang)}</h1>
      <p class="subtitle">${t('subtitle', lang)}</p>
      <p style="color:#94a3b8;margin-top:40px">${t('noRuns', lang)}</p>
    `, lang);
  }

  const rows = runs.map((run) => {
    const m = run.meta || {};
    const variants = (m.variants || []).join(', ');
    const hasScores = Object.values(run.summary || {}).some((s) =>
      typeof s.avgCompositeScore === 'number' || typeof s.avgLlmScore === 'number'
    );
    const scoreCol = hasScores
      ? Object.entries(run.summary || {}).map(([v, s]) =>
          `${e(v)}: ${s.avgCompositeScore ?? s.avgLlmScore ?? '-'}`
        ).join('<br>')
      : '-';
    return `<tr>
      <td><a href="/run/${e(run.id)}">${e(run.id)}</a></td>
      <td>${e(variants)}</td>
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td>${fmtCost(m.totalCostUSD)}</td>
      <td>${e(m.timestamp ? fmtLocalTime(m.timestamp) : '-')}</td>
      <td><button onclick="deleteRun('${e(run.id)}',this)" style="padding:4px 10px;border:1px solid #e2e8f0;border-radius:4px;background:#fff;cursor:pointer;font-size:12px;color:#dc2626" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
    </tr>`;
  }).join('');

  return layout(t('title', lang), `
    <h1>${t('title', lang)}</h1>
    <p class="subtitle" data-i18n="subtitle">${t('subtitle', lang)} &middot; ${runs.length} runs</p>
    <table>
      <thead><tr>
        <th data-i18n="runId">${t('runId', lang)}</th>
        <th data-i18n="variants">${t('variants', lang)}</th>
        <th data-i18n="model">${t('model', lang)}</th>
        <th data-i18n="samples">${t('samples', lang)}</th>
        <th data-i18n="score">${t('score', lang)}</th>
        <th data-i18n="cost">${t('cost', lang)}</th>
        <th data-i18n="time">${t('time', lang)}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/runs">/api/runs</a></p>
    <script>
    function deleteRun(id, btn) {
      var lang = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
      if (!confirm(I18N[lang].deleteConfirm + ' ' + id + ' ?')) return;
      fetch('/api/run/' + encodeURIComponent(id), { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) { btn.closest('tr').remove(); }
          else { alert(I18N[lang].deleteFail + ': ' + (d.error || 'unknown')); }
        })
        .catch(function(err) { alert(I18N[lang].deleteFail + ': ' + err.message); });
    }
    </script>
  `, lang);
}

export function renderRunDetail(report, lang = DEFAULT_LANG) {
  if (!report) {
    return layout('OMK Bench', `
      <div class="nav"><a href="/">${t('backToList', lang)}</a></div>
      <h1>Run not found</h1>
    `, lang);
  }

  const m = report.meta || {};
  const variants = m.variants || [];
  const summary = report.summary || {};
  const results = report.results || [];

  const cards = renderSummaryCards(variants, summary, lang);

  const maxTokens = Math.max(...variants.map((v) => summary[v]?.avgTotalTokens || 0));
  const maxDuration = Math.max(...variants.map((v) => summary[v]?.avgDurationMs || 0));

  const tokenChart = barChart(
    variants.map((v, i) => ({ label: v, value: summary[v]?.avgTotalTokens || 0, color: COLORS[i % COLORS.length] })),
    maxTokens,
  );
  const durationChart = barChart(
    variants.map((v, i) => ({ label: v, value: summary[v]?.avgDurationMs || 0, color: COLORS[i % COLORS.length] })),
    maxDuration,
  );

  const sampleTable = renderSampleTable(variants, results, report, lang);

  return layout(`OMK Bench - ${report.id}`, `
    <div class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></div>
    <h1 data-i18n="reportTitle">${t('reportTitle', lang)}</h1>
    <p class="subtitle">${e(report.id)} &middot; ${t('model', lang)}: ${e(m.model)} &middot; ${t('judge', lang)}: ${e(m.judgeModel || 'none')} &middot; ${t('executor', lang)}: ${e(m.executor || 'claude')} &middot; ${t('cost', lang)}: ${fmtCost(m.totalCostUSD)}${m.blind ? ` &middot; <span class="badge badge-ok" data-i18n="blindLabel">${t('blindLabel', lang)}</span>` : ''}</p>
    ${m.blind ? `
    <div style="margin:12px 0">
      <button onclick="document.getElementById('blind-reveal').style.display=document.getElementById('blind-reveal').style.display==='none'?'block':'none'" style="padding:6px 14px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;cursor:pointer;font-size:13px" data-i18n="revealBlind">${t('revealBlind', lang)}</button>
      <div id="blind-reveal" style="display:none;margin-top:8px;padding:12px;background:#f1f5f9;border-radius:6px;font-size:14px">
        ${Object.entries(m.blindMap || {}).map(([label, real]) => `<div><strong>Variant ${e(label)}</strong> → ${e(real)}</div>`).join('')}
      </div>
    </div>` : ''}

    ${cards}

    <h2 data-i18n="tokenComparison">${t('tokenComparison', lang)}</h2>
    ${tokenChart}

    <h2 data-i18n="latencyComparison">${t('latencyComparison', lang)}</h2>
    ${durationChart}

    ${renderAnalysis(report.analysis, lang)}

    ${sampleTable}

    <p style="margin-top:16px;font-size:12px;color:#94a3b8">API: <a href="/api/run/${e(report.id)}">/api/run/${e(report.id)}</a></p>
    <script>
    function submitFeedback(runId, sampleId, variant, btn) {
      var lang = document.documentElement.dataset.lang || '${DEFAULT_LANG}';
      var container = btn.parentElement;
      var starsEl = container.querySelector('.stars');
      var rating = parseInt(starsEl.dataset.rating) || 0;
      if (rating === 0) { alert(I18N[lang].feedbackSelectRating); return; }
      var comment = container.querySelector('input').value || '';
      fetch('/api/run/' + encodeURIComponent(runId) + '/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sample_id: sampleId, variant: variant, rating: rating, comment: comment })
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.ok) { btn.textContent = I18N[lang].feedbackSubmitted; btn.disabled = true; btn.style.color = '#16a34a'; }
        else { alert(I18N[lang].feedbackFail + ': ' + (d.error || 'unknown')); }
      }).catch(function(err) { alert(I18N[lang].feedbackFail + ': ' + err.message); });
    }
    </script>
  `, lang);
}
