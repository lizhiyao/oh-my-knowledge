/**
 * HTML report renderer — orchestrates sub-modules.
 */

import { e, fmtCost, fmtDuration } from './renderer/helpers.js';
import { DEFAULT_LANG, t } from './renderer/i18n.js';
import { layout } from './renderer/layout.js';
import { renderSummaryCards } from './renderer/summary.js';
import { renderAnalysis } from './renderer/analysis.js';
import { renderAgentOverview } from './renderer/agent-overview.js';
import { renderSampleTable } from './renderer/table.js';
import { renderTrendsBody } from './renderer/trends.js';
import type { Report, Lang } from './types.js';

type EachOverview = NonNullable<Report['overview']>;
type EachOverviewArtifact = EachOverview['artifacts'][number];
type EachArtifactReport = NonNullable<Report['artifacts']>[number];

export function renderRunList(runs: Report[], lang: Lang = DEFAULT_LANG): string {
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
    const m = run.meta;
    const hasScores = Object.values(run.summary || {}).some((s) =>
      typeof s.avgCompositeScore === 'number' || typeof s.avgLlmScore === 'number'
    );
    const scoreCol = hasScores
      ? Object.entries(run.summary || {}).map(([v, s]) => {
        const score = s.avgCompositeScore ?? s.avgLlmScore ?? null;
        if (score == null) return `<span style="color:var(--text-muted)">${e(v)}: -</span>`;
        const color = score >= 4 ? 'var(--green)' : score >= 3 ? 'var(--yellow)' : 'var(--red)';
        const barW = Math.round((score / 5) * 100);
        return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">` +
          `<span title="${e(v)}" style="font-size:11px;color:var(--text-muted);width:56px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">${e(v)}</span>` +
          `<div style="width:64px;height:6px;background:var(--bg-surface);border-radius:3px;flex-shrink:0">` +
          `<div style="width:${barW}%;height:100%;background:${color};border-radius:3px"></div></div>` +
          `<span style="font-size:12px;font-weight:600;color:${color};min-width:24px">${score}</span></div>`;
      }).join('')
      : '<div style="color:var(--text-faint);font-size:0.6875rem;text-align:center">no score</div>';
    const isAgent = Object.values(run.summary || {}).some((s) => s.avgToolCalls != null && s.avgToolCalls > 0);
    const agentBadge = isAgent ? `<span style="display:inline-block;font-size:10px;padding:1px 6px;margin-left:6px;border-radius:3px;background:var(--accent);color:#fff;vertical-align:middle">${t('agentLabel', lang)}</span>` : '';
    return `<tr>
      <td><a href="/run/${e(run.id)}"><span style="color:var(--text-primary)">${e((m.variants || []).join(' vs '))}${agentBadge}</span><br><span style="font-size:0.6875rem;color:var(--text-muted)">${m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : e(run.id)}</span></a></td>
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td>${fmtCost(Object.values(run.summary || {}).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0))}</td>
      <td>${fmtDuration(Object.values(run.summary || {}).reduce((s, v) => s + (v.avgDurationMs || 0) * (v.successCount || 0), 0))}</td>
      <td><button onclick="deleteRun('${e(run.id)}',this)" class="btn-danger" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
    </tr>`;
  }).join('');

  const runCount = lang === 'zh' ? `${runs.length} 次评测` : `${runs.length} runs`;
  const totalCost = runs.reduce((s, r) => s + Object.values(r.summary || {}).reduce((sv, v) => sv + (v.totalExecCostUSD || 0), 0), 0);
  const costLabel = lang === 'zh' ? `累计 ${fmtCost(totalCost)}` : `Total ${fmtCost(totalCost)}`;

  // Collect variants with ≥2 reports for trend links
  const variantCounts: Record<string, number> = {};
  for (const run of runs) {
    for (const v of (run.meta?.variants || [])) {
      if (v === 'baseline') continue;
      variantCounts[v] = (variantCounts[v] || 0) + 1;
    }
  }
  const trendLinks = Object.entries(variantCounts)
    .filter(([, count]) => count >= 2)
    .map(([v]) => `<a href="/trends/${encodeURIComponent(v)}" style="display:inline-block;margin:4px 6px 4px 0;padding:3px 10px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius);color:var(--accent);text-decoration:none">${e(v)} (${variantCounts[v]})</a>`)
    .join('');
  const trendsSection = trendLinks ? `<div style="margin:12px 0"><span style="font-size:12px;color:var(--text-muted);margin-right:8px">${lang === 'zh' ? '📈 趋势：' : '📈 Trends:'}</span>${trendLinks}</div>` : '';

  return layout(`${t('title', lang)} — ${runCount}`, `
    <main>
    <h1>${t('title', lang)}</h1>
    <p class="subtitle" data-i18n="subtitle">${t('subtitle', lang)} &middot; ${runCount} &middot; ${costLabel}</p>
    ${trendsSection}
    <div style="margin:12px 0;display:flex;gap:8px;align-items:center">
      <input id="filter-input" type="text" placeholder="${lang === 'zh' ? '搜索报告名称、变体...' : 'Filter by name, variant...'}" style="flex:1;max-width:320px;padding:6px 10px;font-size:13px;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);outline:none" oninput="filterTable(this.value)">
      <span id="filter-count" style="font-size:11px;color:var(--text-muted)"></span>
    </div>
    <div class="table-wrap">
    <table id="report-table">
      <thead><tr>
        <th data-i18n="runId">${t('runId', lang)}</th>
        <th data-i18n="model">${t('model', lang)}</th>
        <th data-i18n="samples">${t('samples', lang)}</th>
        <th data-i18n="score">${t('score', lang)}</th>
        <th data-i18n="cost">${t('cost', lang)}</th>
        <th>${lang === 'zh' ? '耗时' : 'Duration'}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
    <script>
    function filterTable(q) {
      var rows = document.querySelectorAll('#report-table tbody tr');
      var lower = q.toLowerCase();
      var shown = 0;
      rows.forEach(function(row) {
        var text = row.textContent.toLowerCase();
        var match = !q || text.indexOf(lower) !== -1;
        row.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      var countEl = document.getElementById('filter-count');
      countEl.textContent = q ? (shown + '/${runs.length}') : '';
    }
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

export function renderRunDetail(report: Report | null, lang: Lang = DEFAULT_LANG): string {
  if (!report) {
    return layout('OMK Bench', `
      <main>
      <nav class="nav"><a href="/">${t('backToList', lang)}</a></nav>
      <h1>Run not found</h1>
      </main>
    `, lang);
  }

  const m = report.meta;
  const variants = m.variants || [];
  const summary = report.summary || {};
  const results = report.results || [];

  const cards = renderSummaryCards(variants, summary, lang);
  const sampleTable = renderSampleTable(variants, results, lang);
  const totalExecCost = Object.values(summary).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0);
  const totalDurationMs = Object.values(summary).reduce((s, v) => s + (v.avgDurationMs || 0) * (v.successCount || 0), 0);
  const variantConfigRows = (m.variantConfigs || []).map((config) => {
    const runtimeContext = config.cwd || (lang === 'zh' ? '默认' : 'default');
    return `<tr>
      <td>${e(config.variant)}</td>
      <td>${e(config.experimentRole)}</td>
      <td>${e(config.artifactKind)}</td>
      <td>${e(config.artifactSource)}</td>
      <td>${e(config.executionStrategy)}</td>
      <td>${e(runtimeContext)}</td>
    </tr>`;
  }).join('');
  const variantConfigSection = variantConfigRows ? `
    <section style="margin:20px 0">
      <h2>${t('variantConfig', lang)}</h2>
      <p style="font-size:13px;color:var(--text-muted)">${t('variantConfigDesc', lang)}</p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>${t('variants', lang)}</th>
            <th>${t('variantRole', lang)}</th>
            <th>${t('variantArtifactKind', lang)}</th>
            <th>${t('variantArtifactSource', lang)}</th>
            <th>${t('variantExecutionStrategy', lang)}</th>
            <th>${t('variantRuntimeContext', lang)}</th>
          </tr></thead>
          <tbody>${variantConfigRows}</tbody>
        </table>
      </div>
    </section>
  ` : '';

  return layout(`OMK Bench - ${report.id}`, `
    <main>
    <nav class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${e(report.id)}</h1>
    <div class="meta-tags">
      <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
      <span class="meta-tag">${t('judge', lang)}: ${e(m.judgeModel || 'none')}</span>
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'claude')}</span>
      <span class="meta-tag">${t('cost', lang)}: ${fmtCost(totalExecCost)}</span>
      <span class="meta-tag">${lang === 'zh' ? '耗时' : 'duration'}: ${fmtDuration(totalDurationMs)}</span>
      ${m.gitInfo ? `<span class="meta-tag">commit: ${e(m.gitInfo.commitShort)}${m.gitInfo.dirty ? '*' : ''} (${e(m.gitInfo.branch)})</span>` : ''}
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

    ${variantConfigSection}

    ${renderAgentOverview(variants, summary, lang)}

    ${renderAnalysis(report.analysis, lang)}

    <section>${sampleTable}</section>

    </main>
  `, lang);
}

export function renderEachRunDetail(report: Report | null, lang: Lang = DEFAULT_LANG): string {
  if (!report) {
    return layout('OMK Bench', `
      <main>
      <nav class="nav"><a href="/">${t('backToList', lang)}</a></nav>
      <h1>Run not found</h1>
      </main>
    `, lang);
  }

  const m = report.meta;
  const overview: EachOverview | null = report.overview || null;
  const eachArtifacts: EachArtifactReport[] = report.artifacts || [];

  // Overview table
  const overviewRows = (overview?.artifacts || []).map((sk: EachOverviewArtifact) => {
    const bs = typeof sk.baselineScore === 'number' ? sk.baselineScore.toFixed(2) : '-';
    const ss = typeof sk.artifactScore === 'number' ? sk.artifactScore.toFixed(2) : '-';
    const imp = sk.improvement || '-';
    const impColor = imp.startsWith('+') ? 'var(--green)' : imp.startsWith('-') ? 'var(--red)' : 'var(--text-muted)';
    return `<tr>
      <td><a href="#skill-${e(sk.name)}">${e(sk.name)}</a></td>
      <td>${bs}</td>
      <td>${ss}</td>
      <td style="color:${impColor};font-weight:600">${imp}</td>
    </tr>`;
  }).join('');

  // Per-artifact detail sections
  const skillSections = eachArtifacts.map((sk) => {
    const variants = ['baseline', 'skill'];
    const summary = sk.summary || {};
    const cards = renderSummaryCards(variants, summary, lang);
    const sampleTable = renderSampleTable(variants, sk.results, lang);

    return `
      <section id="skill-${e(sk.name)}" style="margin-top:36px;padding-top:20px;border-top:1px solid var(--border)">
        <h2>${e(sk.name)}</h2>
        <p style="font-size:12px;color:var(--text-muted)">${t('samples', lang)}: ${sk.sampleCount} &middot; Hash: ${e(sk.artifactHash || '-')}</p>
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

    <p style="font-size:13px;color:var(--text-muted)">${overview?.totalArtifacts || 0} ${t('eachSkills', lang)} &middot; ${overview?.totalSamples || 0} ${t('eachSamples', lang)} &middot; ${fmtCost(overview?.totalCostUSD || 0)}</p>
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

export function renderTrendsPage(variantName: string, runs: Report[], lang: Lang = DEFAULT_LANG): string {
  const body = renderTrendsBody(variantName, runs, lang);
  return layout(`${variantName} — Trends`, `<main>${body}</main>`, lang);
}
