/**
 * HTML report renderer — orchestrates sub-modules.
 */

import { e, fmtCost } from './renderer/helpers.mjs';
import { DEFAULT_LANG, t } from './renderer/i18n.mjs';
import { layout } from './renderer/layout.mjs';
import { renderSummaryCards } from './renderer/summary.mjs';
import { renderAnalysis } from './renderer/analysis.mjs';
import { renderSampleTable } from './renderer/table.mjs';

export function renderRunList(runs, lang = DEFAULT_LANG) {
  if (!runs || runs.length === 0) {
    return layout(t('title', lang), `
      <main>
      <h1>${t('title', lang)}</h1>
      <p class="subtitle">${t('subtitle', lang)}</p>
      <p style="color:var(--text-muted);margin-top:40px">${t('noRuns', lang)}</p>
      </main>
    `, lang);
  }

  const rows = runs.map((run) => {
    const m = run.meta || {};
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
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td>${fmtCost(m.totalCostUSD)}</td>
      <td><button onclick="deleteRun('${e(run.id)}',this)" class="btn-danger" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
    </tr>`;
  }).join('');

  const runCount = lang === 'zh' ? `${runs.length} 次评测` : `${runs.length} runs`;
  return layout(`${t('title', lang)} — ${runCount}`, `
    <main>
    <h1>${t('title', lang)}</h1>
    <p class="subtitle" data-i18n="subtitle">${t('subtitle', lang)} &middot; ${runCount}</p>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th data-i18n="runId">${t('runId', lang)}</th>
        <th data-i18n="model">${t('model', lang)}</th>
        <th data-i18n="samples">${t('samples', lang)}</th>
        <th data-i18n="score">${t('score', lang)}</th>
        <th data-i18n="cost">${t('cost', lang)}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
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
    </main>
  `, lang);
}

export function renderRunDetail(report, lang = DEFAULT_LANG) {
  if (!report) {
    return layout('OMK Bench', `
      <main>
      <nav class="nav"><a href="/">${t('backToList', lang)}</a></nav>
      <h1>Run not found</h1>
      </main>
    `, lang);
  }

  const m = report.meta || {};
  const variants = m.variants || [];
  const summary = report.summary || {};
  const results = report.results || [];

  const cards = renderSummaryCards(variants, summary, lang);
  const sampleTable = renderSampleTable(variants, results, report, lang);

  return layout(`OMK Bench - ${report.id}`, `
    <main>
    <nav class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${e(report.id)}</h1>
    <div class="meta-tags">
      <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
      <span class="meta-tag">${t('judge', lang)}: ${e(m.judgeModel || 'none')}</span>
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'claude')}</span>
      <span class="meta-tag">${t('cost', lang)}: ${fmtCost(m.totalCostUSD)}</span>
      ${m.blind ? `<span class="meta-tag" style="color:var(--green)" data-i18n="blindLabel">${t('blindLabel', lang)}</span>` : ''}
    </div>
    ${m.blind ? `
    <div style="margin:12px 0">
      <button onclick="document.getElementById('blind-reveal').style.display=document.getElementById('blind-reveal').style.display==='none'?'block':'none'" data-i18n="revealBlind">${t('revealBlind', lang)}</button>
      <div id="blind-reveal" style="display:none;margin-top:8px;padding:12px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)" role="region" aria-label="Blind variant mapping">
        ${Object.entries(m.blindMap || {}).map(([label, real]) => `<div style="font-size:13px;color:var(--text-secondary)"><strong>Variant ${e(label)}</strong> → ${e(real)}</div>`).join('')}
      </div>
    </div>` : ''}

    <section>${cards}</section>

    ${renderAnalysis(report.analysis, lang)}

    <section>${sampleTable}</section>

    </main>
  `, lang);
}

export function renderEachRunDetail(report, lang = DEFAULT_LANG) {
  if (!report) {
    return layout('OMK Bench', `
      <main>
      <nav class="nav"><a href="/">${t('backToList', lang)}</a></nav>
      <h1>Run not found</h1>
      </main>
    `, lang);
  }

  const m = report.meta || {};
  const overview = report.overview || {};
  const skills = report.skills || [];

  // Overview table
  const overviewRows = (overview.skills || []).map((sk) => {
    const bs = typeof sk.baselineScore === 'number' ? sk.baselineScore.toFixed(2) : '-';
    const ss = typeof sk.skillScore === 'number' ? sk.skillScore.toFixed(2) : '-';
    const imp = sk.improvement || '-';
    const impColor = imp.startsWith('+') ? 'var(--green)' : imp.startsWith('-') ? 'var(--red)' : 'var(--text-muted)';
    return `<tr>
      <td><a href="#skill-${e(sk.name)}">${e(sk.name)}</a></td>
      <td>${bs}</td>
      <td>${ss}</td>
      <td style="color:${impColor};font-weight:600">${imp}</td>
    </tr>`;
  }).join('');

  // Per-skill detail sections
  const skillSections = skills.map((sk) => {
    const variants = ['baseline', 'skill'];
    const summary = sk.summary || {};
    const cards = renderSummaryCards(variants, summary, lang);
    const sampleTable = renderSampleTable(variants, sk.results, { meta: { variants } }, lang);

    return `
      <section id="skill-${e(sk.name)}" style="margin-top:36px;padding-top:20px;border-top:1px solid var(--border)">
        <h2>${e(sk.name)}</h2>
        <p style="font-size:12px;color:var(--text-muted)">${t('samples', lang)}: ${sk.sampleCount} &middot; Hash: ${e(sk.skillHash || '-')}</p>
        ${cards}
        ${sampleTable}
      </section>
    `;
  }).join('');

  return layout(`${t('reportTitle', lang)} - ${report.id}`, `
    <main>
    <nav class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${e(report.id)}</h1>
    <div class="meta-tags">
      <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
      <span class="meta-tag">${t('judge', lang)}: ${e(m.judgeModel || 'none')}</span>
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'claude')}</span>
      <span class="meta-tag">${t('cost', lang)}: ${fmtCost(m.totalCostUSD)}</span>
    </div>

    <section>
    <h2>${t('eachOverview', lang)}</h2>
    <p style="font-size:13px;color:var(--text-muted)">${overview.totalSkills || 0} ${t('eachSkills', lang)} &middot; ${overview.totalSamples || 0} ${t('eachSamples', lang)} &middot; ${fmtCost(overview.totalCostUSD)}</p>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th>${t('eachSkill', lang)}</th>
        <th>${t('eachBaseline', lang)}</th>
        <th>${t('eachWithSkill', lang)}</th>
        <th>${t('eachImprovement', lang)}</th>
      </tr></thead>
      <tbody>${overviewRows}</tbody>
    </table>
    </div>
    </section>

    ${skillSections}

    </main>
  `, lang);
}
