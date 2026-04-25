/**
 * HTML report renderer — orchestrates sub-modules.
 */

import { e, fmtCost, fmtDuration, COLORS, DEFAULT_LANG, t, layout } from './layout.js';
import {
  renderAgentOverview,
  renderAnalysis,
  renderHumanAgreement,
  renderKnowledgeInteractionSection,
  renderPairwiseDiff,
  renderSaturationCurve,
  renderSummaryCards,
  renderVarianceComparisons,
} from './summary.js';
import { renderSampleTable } from './table.js';
import { renderTrendsBody } from './trends.js';
import type { Report, Lang } from '../types.js';

type EachOverview = NonNullable<Report['overview']>;
type EachOverviewArtifact = EachOverview['artifacts'][number];
type EachArtifactReport = NonNullable<Report['artifacts']>[number];

export function renderRunList(runs: Report[], lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const skillHealthLink = `<a href="/analyses${langQ}" style="color:var(--text-muted);font-size:12px;text-decoration:none;border:1px solid var(--border);padding:4px 10px;border-radius:var(--radius);display:inline-block">📊 <span data-i18n="skillHealthTitle">${t('skillHealthTitle', lang)}</span> →</a>`;
  if (!runs || runs.length === 0) {
    return layout(t('title', lang), `
      <main>
      <h1>${t('title', lang)}</h1>
      <p class="subtitle">${t('subtitle', lang)}</p>
      <div style="margin-top:16px">${skillHealthLink}</div>
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
    const badges = ''; // TODO: artifact kind 体系完善后，按 kind 显示评测类型标签

    return `<tr>
      <td><a href="/run/${e(run.id)}"><span style="color:var(--text-primary)">${e(run.id)}${badges}</span><br><span style="font-size:0.6875rem;color:var(--text-muted)">${(() => {
        // Extract date/time from report ID: ...-YYYYMMDD-HHmm
        const idMatch = run.id.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
        if (idMatch) return `${idMatch[2]}/${idMatch[3]} ${idMatch[4]}:${idMatch[5]}`;
        return m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : e(run.id);
      })()}</span></a></td>
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td>${fmtCost(Object.values(run.summary || {}).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0))}</td>
      <td>${fmtDuration(Object.values(run.summary || {}).reduce((s, v) => s + (v.avgDurationMs || 0) * (v.successCount || 0), 0))}</td>
      <td style="white-space:nowrap"><button onclick="deleteRun('${e(run.id)}',this)" class="btn-danger" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
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

  return layout(t('title', lang), `
    <main>
    <h1>${t('title', lang)}</h1>
    <p class="subtitle" data-i18n="subtitle">${t('subtitle', lang)} &middot; ${runCount} &middot; ${costLabel}</p>
    ${trendsSection}
    <div style="margin:12px 0">${skillHealthLink}</div>
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
    return layout(t('title', lang), `
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

  const cards = renderSummaryCards(variants, summary, lang, report.variance);
  const pairwiseDiff = renderPairwiseDiff(report.meta.pairComparisons, lang);
  const humanAgreement = renderHumanAgreement(report.meta.humanAgreement, lang);
  const saturationCurve = renderSaturationCurve(report.variance?.saturation, variants, lang);
  const sampleTable = renderSampleTable(variants, results, lang);
  const totalExecCost = Object.values(summary).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0);
  const totalDurationMs = Object.values(summary).reduce((s, v) => s + (v.avgDurationMs || 0) * (v.successCount || 0), 0);
  const sourceLabels: Record<string, Record<string, string>> = {
    zh: { 'variant-name': '本地文件', 'file-path': '本地文件', git: 'Git 版本', inline: '内联', baseline: '无', custom: '自定义' },
    en: { 'variant-name': 'Local file', 'file-path': 'Local file', git: 'Git ref', inline: 'Inline', baseline: 'None', custom: 'Custom' },
  };
  const typeLabels: Record<string, Record<string, string>> = {
    zh: { baseline: '基线', 'runtime-context-only': '仅运行环境', 'artifact-injection': '知识注入' },
    en: { baseline: 'Baseline', 'runtime-context-only': 'Runtime context only', 'artifact-injection': 'Artifact injection' },
  };
  const strategyLabels: Record<string, Record<string, string>> = {
    zh: { baseline: '无注入', 'system-prompt': '系统提示词', 'user-prompt': '用户提示词', 'agent-session': 'Agent 会话', 'workflow-session': '工作流会话' },
    en: { baseline: 'None', 'system-prompt': 'System prompt', 'user-prompt': 'User prompt', 'agent-session': 'Agent session', 'workflow-session': 'Workflow session' },
  };

  const variantConfigRows = (m.variantConfigs || []).map((config, i) => {
    const expTypeRaw = config.experimentType || '-';
    const expType = (typeLabels[lang] || typeLabels.en)[String(expTypeRaw)] || expTypeRaw;
    const source = config.artifactKind === 'baseline'
      ? (lang === 'zh' ? '无' : 'None')
      : (sourceLabels[lang] || sourceLabels.en)[config.artifactSource] || config.artifactSource;
    const strategy = (strategyLabels[lang] || strategyLabels.en)[config.executionStrategy] || config.executionStrategy;
    const cwdRaw = config.cwd || '';
    const runtimeContext = cwdRaw
      ? cwdRaw.replace(/.*\/Projects\//, '').replace(/.*\/Documents\//, '').replace(/\/Users\/[^/]+\//, '~/')
      : (lang === 'zh' ? '默认' : 'default');
    const color = COLORS[i % COLORS.length];
    return `<tr>
      <td style="border-left:3px solid ${color};padding-left:12px"><strong>${e(config.variant)}</strong></td>
      <td>${e(expType)}</td>
      <td>${e(config.artifactKind)}</td>
      <td>${e(source)}</td>
      <td>${e(strategy)}</td>
      <td title="${e(cwdRaw)}">${e(runtimeContext)}</td>
    </tr>`;
  }).join('');
  const configModalId = 'guide-variant-config';
  const repeatSuffix = report.variance
    ? (lang === 'zh' ? ` × ${report.variance.runs} 轮` : ` × ${report.variance.runs} runs`)
    : '';
  const experimentSummary = lang === 'zh'
    ? `${m.sampleCount} 个测评用例 × ${variants.length} 组实验${repeatSuffix}`
    : `${m.sampleCount} samples × ${variants.length} variants${repeatSuffix}`;

  const variantConfigSection = variantConfigRows ? `
    <section style="margin:20px 0">
      <h2 style="display:flex;align-items:center;gap:4px">${t('variantConfig', lang)} <button type="button" class="hint-btn" onclick="openModal('${configModalId}')" aria-label="${e(t('variantConfigDesc', lang))}" aria-haspopup="dialog">?</button></h2>
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${experimentSummary}</p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>🏷️ ${t('variants', lang)}</th>
            <th>🧪 ${t('variantType', lang)}</th>
            <th>📦 ${t('variantArtifactKind', lang)}</th>
            <th>📂 ${t('variantArtifactSource', lang)}</th>
            <th>⚙️ ${t('variantExecutionStrategy', lang)}</th>
            <th>🖥️ ${t('variantRuntimeContext', lang)}</th>
          </tr></thead>
          <tbody>${variantConfigRows}</tbody>
        </table>
      </div>
    </section>
    <div id="${configModalId}" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="${configModalId}-title" onclick="if(event.target===this)closeModal('${configModalId}')">
      <div class="modal-content">
        <div class="modal-header">
          <strong id="${configModalId}-title" style="font-size:1rem">${lang === 'zh' ? '如何阅读实验配置？' : 'How to read experiment setup?'}</strong>
          <button type="button" class="modal-close" onclick="closeModal('${configModalId}')" aria-label="${lang === 'zh' ? '关闭' : 'Close'}">✕</button>
        </div>
        <p style="font-size:13px;color:var(--text-secondary);margin:4px 0 16px">${e(t('variantConfigDesc', lang))}</p>
        <table class="modal-table"><tbody>
          ${lang === 'zh' ? `
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variants', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">实验分组的名称标签</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantType', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">该分组属于哪种实验类型（baseline / 仅运行环境 / 知识注入）</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>知识类型</strong></td><td style="padding:6px 0;color:var(--text-secondary)">被评测对象的类型（skill / agent / workflow / baseline）</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantArtifactSource', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">知识从哪里加载（本地文件 / Git 版本 / 内联）</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantExecutionStrategy', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">知识如何注入执行（system-prompt / user-prompt / agent-session）</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantRuntimeContext', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">Agent 运行的工作目录（影响可访问的文件和工具）</td></tr>
          ` : `
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variants', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">Name label for this experiment group</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantType', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">Role in the experiment (baseline / runtime-context-only / artifact-injection)</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>Artifact Kind</strong></td><td style="padding:6px 0;color:var(--text-secondary)">Type of artifact being evaluated (skill / agent / workflow / baseline)</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantArtifactSource', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">Where the artifact comes from (local file / git ref / inline)</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>${t('variantExecutionStrategy', lang)}</strong></td><td style="padding:6px 0;color:var(--text-secondary)">How the artifact is injected (system-prompt / user-prompt / agent-session)</td></tr>
          <tr><td style="padding:6px 0;color:var(--text-primary)"><strong>Runtime Context</strong></td><td style="padding:6px 0;color:var(--text-secondary)">Working directory the agent runs in (affects accessible files and tools)</td></tr>
          `}
        </tbody></table>
      </div>
    </div>
  ` : '';

  return layout(`${report.id}`, `
    <main>
    <nav class="nav"><a href="/" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${e(report.id)}</h1>
    <div class="meta-tags">
      <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
      ${m.judgeModels && m.judgeModels.length >= 2
        ? `<span class="meta-tag" title="${t('ensembleDesc', lang)}">${t('judgeModelsLabel', lang)}: ${m.judgeModels.map((j) => e(j)).join(' · ')}</span>`
        : `<span class="meta-tag">${t('judge', lang)}: ${e(m.judgeModel || 'none')}</span>`
      }
      ${m.judgeRepeat && m.judgeRepeat > 1 ? `<span class="meta-tag" title="${t('judgeStddevDesc', lang)}">${t('judgeRepeatLabel', lang)}: ${m.judgeRepeat}</span>` : ''}
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'claude')}</span>
      <span class="meta-tag">${t('cost', lang)}: ${fmtCost(totalExecCost)}</span>
      <span class="meta-tag">${lang === 'zh' ? '耗时' : 'duration'}: ${fmtDuration(totalDurationMs)}</span>
      ${m.gitInfo ? `<span class="meta-tag">commit: ${e(m.gitInfo.commitShort)}${m.gitInfo.dirty ? '*' : ''} (${e(m.gitInfo.branch)})</span>` : ''}
      ${m.judgePromptHash ? `<span class="meta-tag" title="${t('judgePromptHashDesc', lang)}">${t('judgePromptHashLabel', lang)}: <code>${e(m.judgePromptHash)}</code></span>` : ''}
      ${m.sampleHashes ? `<span class="meta-tag" style="color:var(--text-muted)" title="${t('sampleHashCountDesc', lang)}">${t('sampleHashCount', lang)}: ${Object.keys(m.sampleHashes).length}/${m.sampleCount}</span>` : ''}
      ${m.evaluationFramework ? `<span class="meta-tag" title="${t('evalFrameworkDesc', lang)}">${t('evalFrameworkLabel', lang)}: ${m.evaluationFramework === 'bootstrap' ? t('evalFrameworkBootstrap', lang) : m.evaluationFramework === 'both' ? t('evalFrameworkBoth', lang) : t('evalFrameworkTTest', lang)}</span>` : ''}
      ${m.debiasMode && m.debiasMode.length > 0 ? `<span class="meta-tag" style="color:var(--green)" title="${lang === 'zh' ? 'judge bias 校正模式 (Phase 3)：length=substance-not-length 提示;position=ensemble 顺序随机化' : 'Judge bias debias modes (Phase 3): length = substance-not-length prompt; position = randomized ensemble order'}">${lang === 'zh' ? '校正' : 'debias'}: ${m.debiasMode.join(' · ')}</span>` : ''}
      ${m.blind ? `<span class="meta-tag" style="color:var(--green)" data-i18n="blindLabel">${t('blindLabel', lang)}</span>` : ''}
    </div>
    ${m.blind ? `
    <div style="margin:12px 0">
      <button onclick="document.getElementById('blind-reveal').style.display=document.getElementById('blind-reveal').style.display==='none'?'block':'none'" data-i18n="revealBlind">${t('revealBlind', lang)}</button>
      <div id="blind-reveal" style="display:none;margin-top:8px;padding:12px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)" role="region" aria-label="Blind variant mapping">
        ${Object.entries(m.blindMap || {}).map(([label, real]) => `<div style="font-size:13px;color:var(--text-secondary)"><strong>Variant ${e(label)}</strong> → ${e(real)}</div>`).join('')}
      </div>
    </div>` : ''}

    ${variantConfigSection}

    <section>${cards}${pairwiseDiff}${humanAgreement}${saturationCurve}</section>

    ${renderVarianceComparisons(report.variance, lang, Boolean(report.meta.layeredStats))}

    ${renderAnalysis(report.analysis, lang)}

    ${renderAgentOverview(variants, summary, lang)}

    ${renderKnowledgeInteractionSection(report.analysis?.coverage, report.analysis?.gapReports, lang)}

    <section>${sampleTable}</section>

    </main>
  `, lang);
}

export function renderEachRunDetail(report: Report | null, lang: Lang = DEFAULT_LANG): string {
  if (!report) {
    return layout(t('title', lang), `
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
    // 传 sk.variance 给 summaryCards, 稳定性 CV 列才有数据 (非 each 模式是传 report.variance)
    const cards = renderSummaryCards(variants, summary, lang, sk.variance);
    const sampleTable = renderSampleTable(variants, sk.results, lang);
    // --each --repeat N 时每个 skill 有自己的 variance; 复用 bench 的 renderVarianceComparisons
    const varianceBlock = sk.variance
      ? renderVarianceComparisons(sk.variance, lang, Boolean(report.meta.layeredStats))
      : '';

    const hashShort = sk.artifactHash ? e(sk.artifactHash).slice(0, 12) : '-';
    const hashBlock = sk.artifactHash
      ? `<span title="${t('artifactHashTooltip', lang)}"><span data-i18n="artifactHashLabel">${t('artifactHashLabel', lang)}</span>: <code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${hashShort}</code></span>`
      : '';
    return `
      <section id="skill-${e(sk.name)}" style="margin-top:36px;padding-top:20px;border-top:1px solid var(--border)">
        <h2>${e(sk.name)}</h2>
        <p style="font-size:12px;color:var(--text-muted)">${t('samples', lang)}: ${sk.sampleCount}${hashBlock ? ' &middot; ' + hashBlock : ''}</p>
        ${cards}
        ${varianceBlock}
        ${sampleTable}
      </section>
    `;
  }).join('');

  // 轮次信息放总览。统一用 · 分隔(each 下 skills×samples 不是严格乘法,避免 × 的误导)
  const repeatN = report.meta.request?.repeat;
  const repeatSegment = repeatN && repeatN > 1
    ? (lang === 'zh' ? ` · ${repeatN} 轮重复` : ` · ${repeatN} runs`)
    : '';
  const overviewSubtitle = lang === 'zh'
    ? `${overview?.totalArtifacts || 0} 个 Skill · ${overview?.totalSamples || 0} 个用例${repeatSegment} · ${fmtCost(overview?.totalCostUSD || 0)}`
    : `${overview?.totalArtifacts || 0} skills · ${overview?.totalSamples || 0} samples${repeatSegment} · ${fmtCost(overview?.totalCostUSD || 0)}`;

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

    <p style="font-size:13px;color:var(--text-muted)">${overviewSubtitle}</p>
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
  return layout(`${variantName} — ${lang === 'zh' ? '趋势' : 'Trends'}`, `<main>${body}</main>`, lang);
}
