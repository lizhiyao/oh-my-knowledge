/**
 * HTML report renderer — orchestrates sub-modules.
 */

import { e, fmtCost, fmtDuration, fmtKnownCost, COLORS, DEFAULT_LANG, t, layout } from './layout.js';
import {
  renderAgentOverview,
  renderAnalysis,
  renderKnowledgeInteractionSection,
  renderMethodologyAudit,
  renderScoringModal,
  renderSummaryCards,
  renderVarianceComparisons,
  renderVerdictPill,
  levelLabel,
  levelTooltip,
} from './summary.js';
import { renderSampleTable } from './table.js';
import { renderTestView, TEST_VIEW_CSS, TEST_VIEW_JS } from './test-view.js';
import { renderTrendsBody } from './trends.js';
import { computeVerdict, type VerdictLevel } from '../eval-core/verdict.js';
import type { BatchEvaluationReport, EvaluationReport, ExecutorRuntimeFingerprint, Report, ReportDocument, Lang, VariantSummary } from '../types/index.js';

// v0.21 B.4 — 列表页 status pill 用的 dot. PROGRESS/REGRESS 实心(强信号),
// CAUTIOUS 三角(警示),NOISE 空心圆(有信号但无效果),UNDERPOWERED 部分填充
// (不够数据),SOLO 描边圆(单变体). 跟 verdict pill 同一组符号,跨入口一致.
function levelDot(level: VerdictLevel): string {
  switch (level) {
    case 'PROGRESS':
    case 'REGRESS':      return '●';
    case 'CAUTIOUS':     return '▲';
    case 'NOISE':        return '◌';
    case 'UNDERPOWERED': return '◔';
    case 'SOLO':         return '○';
  }
}

type RuntimeMeta = Pick<EvaluationReport['meta'], 'executorRuntime' | 'executorRuntimes' | 'judgeModels' | 'noJudge'>;

function isEvaluationReport(document: ReportDocument): document is EvaluationReport {
  return document.kind === 'evaluation';
}

function scoreOf(summary: VariantSummary | undefined): number | null {
  return summary?.avgCompositeScore ?? summary?.avgLlmScore ?? null;
}

function improvementOf(baselineScore: number | null, skillScore: number | null): string {
  if (typeof baselineScore !== 'number' || typeof skillScore !== 'number' || baselineScore <= 0) return '-';
  const delta = ((skillScore - baselineScore) / baselineScore * 100).toFixed(0);
  return skillScore >= baselineScore ? `+${delta}%` : `${delta}%`;
}

function costCompletenessTooltip(lang: Lang): string {
  return lang === 'zh'
    ? '部分 executor 或评委不回传 USD 成本。这里显示的是已上报成本下界,真实花费可能更高。'
    : 'Some executors or judges do not report USD cost. This is a lower bound from reported costs; actual spend may be higher.';
}

function renderDebiasModeTag(modes: EvaluationReport['meta']['debiasMode'], lang: Lang): string {
  if (!modes || modes.length === 0) return '';
  const labels = modes.map((mode) => {
    if (mode === 'length') return lang === 'zh' ? '长度偏差' : 'length bias';
    if (mode === 'position') return lang === 'zh' ? '位置偏差' : 'position bias';
    return mode;
  });
  const title = lang === 'zh'
    ? '评委评分偏差控制:长度偏差=提醒评委不要因为答案更长就给更高分;位置偏差=随机化多评委顺序'
    : 'Judge scoring bias controls: length bias = do not reward longer answers; position bias = randomize ensemble order';
  return `<span class="meta-tag" title="${e(title)}">${lang === 'zh' ? '评分偏差控制' : 'Judge bias control'}: ${labels.map(e).join(' · ')}</span>`;
}

function pluralizeEn(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

interface RuntimeScope {
  role: 'executor' | 'judge';
  scope: string;
  runtime: ExecutorRuntimeFingerprint;
}

function gatherRuntimeScopes(meta: RuntimeMeta): RuntimeScope[] {
  const scopes: RuntimeScope[] = [];
  if (meta.executorRuntimes && Object.keys(meta.executorRuntimes).length > 0) {
    Object.entries(meta.executorRuntimes)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([key, runtime]) => {
        if (runtime) scopes.push({ role: 'executor', scope: key, runtime });
      });
  } else if (meta.executorRuntime) {
    scopes.push({ role: 'executor', scope: '', runtime: meta.executorRuntime });
  }
  if (!meta.noJudge) {
    (meta.judgeModels ?? [])
      .slice()
      .sort((a, b) => `${a.executor}:${a.model}`.localeCompare(`${b.executor}:${b.model}`))
      .forEach((entry) => {
        if (entry.runtime) scopes.push({ role: 'judge', scope: `${entry.executor}:${entry.model}`, runtime: entry.runtime });
      });
  }
  return scopes;
}

function runtimeVersionText(runtime: ExecutorRuntimeFingerprint, lang: Lang): string {
  const versions: string[] = [];
  if (runtime.binary?.version) versions.push(`${lang === 'zh' ? '二进制' : 'binary'} ${runtime.binary.version}`);
  if (runtime.sdk?.version) versions.push(`sdk ${runtime.sdk.version}`);
  return versions.length > 0 ? ` · ${versions.map(e).join(' · ')}` : '';
}

function runtimeTooltip(runtime: ExecutorRuntimeFingerprint): string {
  return [
    `executor=${runtime.executor}`,
    `model=${runtime.model}`,
    `kind=${runtime.kind}`,
    `system=${runtime.capabilities.systemPrompt}`,
    `cost=${runtime.capabilities.costUSD}`,
    `trace=${runtime.capabilities.trace}`,
    `skillIsolation=${runtime.capabilities.skillIsolation}`,
  ].join('; ');
}

// 同 fingerprint + 同 binary/sdk 版本 = 同一执行环境，合并为一条 tag。
// 旧版给每个 executor / judge 单独一条 pill，3 个角色用同一 binary 时
// fingerprint 重复 3 遍，扫读成本高。新版按 (fingerprint, versionText)
// 分组，scope 合并到 tag 内 "适用于 ..." 后缀。
function renderRuntimeFingerprintTags(meta: RuntimeMeta, lang: Lang): string {
  const scopes = gatherRuntimeScopes(meta);
  if (scopes.length === 0) return '';

  const groups = new Map<string, { runtime: ExecutorRuntimeFingerprint; versionText: string; executors: string[]; judges: string[] }>();
  for (const s of scopes) {
    const versionText = runtimeVersionText(s.runtime, lang);
    const key = `${s.runtime.fingerprint}|${versionText}`;
    let g = groups.get(key);
    if (!g) {
      g = { runtime: s.runtime, versionText, executors: [], judges: [] };
      groups.set(key, g);
    }
    if (s.role === 'executor') g.executors.push(s.scope || (lang === 'zh' ? '默认' : 'default'));
    else g.judges.push(s.scope);
  }

  const groupLabel = lang === 'zh' ? '执行环境指纹' : 'Runtime fingerprint';
  return Array.from(groups.values()).map((g) => {
    const scopeBits: string[] = [];
    if (g.executors.length > 0) scopeBits.push(`${lang === 'zh' ? '执行器' : 'executor'} ${g.executors.join(', ')}`);
    if (g.judges.length > 0) scopeBits.push(`${lang === 'zh' ? '评委' : 'judge'} ${g.judges.join(', ')}`);
    const scopeText = scopeBits.length > 0 ? ` · ${lang === 'zh' ? '适用' : 'used by'} ${e(scopeBits.join('; '))}` : '';
    return `<span class="meta-tag" title="${e(runtimeTooltip(g.runtime))}">${e(groupLabel)}: <code>${e(g.runtime.fingerprint)}</code>${g.versionText}${scopeText}</span>`;
  }).join('');
}

export function renderRunList(runs: ReportDocument[], lang: Lang = DEFAULT_LANG): string {
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
    if (run.kind === 'batch-evaluation') {
      const m = run.meta;
      const scoreCol = run.items.length > 0
        ? run.items.map((item) => {
          const baselineScore = scoreOf(item.summary.baseline);
          const skillScore = scoreOf(item.summary[item.name]);
          const score = skillScore ?? baselineScore;
          if (score == null) return `<span style="color:var(--text-muted)">${e(item.name)}: -</span>`;
          const color = score >= 4 ? 'var(--green)' : score >= 3 ? 'var(--yellow)' : 'var(--red)';
          const barW = Math.round((score / 5) * 100);
          return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0">` +
            `<span title="${e(item.name)}" style="font-size:11px;color:var(--text-muted);width:56px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0">${e(item.name)}</span>` +
            `<div style="width:64px;height:6px;background:var(--bg-surface);border-radius:3px;flex-shrink:0">` +
            `<div style="width:${barW}%;height:100%;background:${color};border-radius:3px"></div></div>` +
            `<span style="font-size:12px;font-weight:600;color:${color};min-width:24px">${score.toFixed(2)}</span></div>`;
        }).join('')
        : '<div style="color:var(--text-faint);font-size:0.6875rem;text-align:center">no score</div>';
      const allCostReported = run.items.every((item) =>
        Object.values(item.summary || {}).every((v) => v.execCostReported !== false && v.judgeCostReported !== false));
      const totalCostReported = m.totalCostReported !== false && allCostReported;
      const totalDurationMs = run.items.reduce((sum, item) => (
        sum + Object.values(item.summary || {}).reduce((inner, v) => inner + (v.avgDurationMs || 0) * (v.successCount || 0), 0)
      ), 0);
      const statusPill = `<span class="run-status" title="${lang === 'zh' ? '批量评测' : 'batch evaluation'}"><span class="run-status-dot" aria-hidden="true">◇</span>${lang === 'zh' ? '批量' : 'Batch'}</span>`;
      return `<tr>
      <td>${statusPill}<a href="/reports/${e(run.id)}${langQ}"><span style="color:var(--text-primary)">${e(run.id)}</span><br><span style="font-size:0.6875rem;color:var(--text-muted)">${m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : e(run.id)}</span></a></td>
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td title="${totalCostReported ? '' : e(costCompletenessTooltip(lang))}">${fmtKnownCost(m.totalCostUSD || 0, totalCostReported)}</td>
      <td>${fmtDuration(totalDurationMs)}</td>
      <td style="white-space:nowrap"><button onclick="deleteRun('${e(run.id)}',this)" class="btn-danger" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
    </tr>`;
    }

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

    // v0.21 B.4 — 列表页 verdict pill: 一眼分辨 progress / regress / noise.
    // computeVerdict 是同步纯函数(report -> level),per row 跑成本 O(samples).
    // 脏报告可能让 layer-gates 访问 undefined.avgFactScore 抛 NPE。
    // try/catch 兜底,失败的 row 不显示 pill,避免一个坏 report 撤掉整页。
    let statusPill = '';
    try {
      const verdict = computeVerdict(run);
      const lvl = verdict.level;
      statusPill = `<span class="run-status verdict-${lvl}" title="${e(levelTooltip(lvl, lang))}" aria-label="${e(levelLabel(lvl, lang))} — ${e(levelTooltip(lvl, lang))}"><span class="run-status-dot" aria-hidden="true">${levelDot(lvl)}</span>${e(levelLabel(lvl, lang))}</span>`;
    } catch { /* skip pill on this row */ }

    return `<tr>
      <td>${statusPill}<a href="/reports/${e(run.id)}${langQ}"><span style="color:var(--text-primary)">${e(run.id)}${badges}</span><br><span style="font-size:0.6875rem;color:var(--text-muted)">${(() => {
        // Extract date/time from report ID: ...-YYYYMMDD-HHmm
        const idMatch = run.id.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
        if (idMatch) return `${idMatch[2]}/${idMatch[3]} ${idMatch[4]}:${idMatch[5]}`;
        return m.timestamp ? new Date(m.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : e(run.id);
      })()}</span></a></td>
      <td>${e(m.model || '-')}</td>
      <td>${m.sampleCount || 0}</td>
      <td>${scoreCol}</td>
      <td>${(() => {
        const cost = Object.values(run.summary || {}).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0);
        const reported = Object.values(run.summary || {}).every((v) => v.execCostReported !== false);
        return fmtCost(cost, reported);
      })()}</td>
      <td>${fmtDuration(Object.values(run.summary || {}).reduce((s, v) => s + (v.avgDurationMs || 0) * (v.successCount || 0), 0))}</td>
      <td style="white-space:nowrap"><button onclick="deleteRun('${e(run.id)}',this)" class="btn-danger" data-i18n="deleteBtnText">${t('deleteBtnText', lang)}</button></td>
    </tr>`;
  }).join('');

  const runCount = lang === 'zh' ? `${runs.length} 次评测` : `${runs.length} runs`;
  // 列表累计:只 sum 那些"全 variant 都报告了 cost"的 run,跳过任一 variant not reported 的。
  // 排除 not reported(而不是把整体压成「—」)是因为列表常含数十个 run 仅 1-2 个是 codex,
  // 把全部 sum 抹成「—」会丢掉绝大多数有效成本信息。
  const evaluationRuns = runs.filter(isEvaluationReport);
  const reportableRuns = evaluationRuns.filter((r) =>
    Object.values(r.summary || {}).every((v) => v.execCostReported !== false));
  const unmeasuredRunsCount = evaluationRuns.length - reportableRuns.length;
  const totalCost = reportableRuns.reduce((s, r) => s + Object.values(r.summary || {}).reduce((sv, v) => sv + (v.totalExecCostUSD || 0), 0), 0);
  // partial:有 reported 就显示数字 + tooltip;全部 not reported 才显示「—」;
  // 全 reported(unmeasuredRunsCount=0)走老格式不包 span,保持 HTML snapshot 向后兼容。
  // X/N 限定信息只放 tooltip,不挂在显眼位置 — 累计行视觉应该是单纯的数字。
  const allUnmeasured = reportableRuns.length === 0 && runs.length > 0;
  const baseLabel = lang === 'zh' ? '累计' : 'Total';
  const costNumber = fmtCost(totalCost, !allUnmeasured);
  let costLabel: string;
  if (unmeasuredRunsCount === 0) {
    // 全 reported → 跟旧版字节级一致,不破 snapshot
    costLabel = `${baseLabel} ${costNumber}`;
  } else {
    const tip = lang === 'zh'
      ? `${reportableRuns.length}/${evaluationRuns.length} 次单次报告了 USD 成本;${unmeasuredRunsCount} 次 executor 不报(如 codex CLI),batch index 不计入累计以避免重复`
      : `${reportableRuns.length}/${evaluationRuns.length} evaluation reports reported USD cost; ${unmeasuredRunsCount} excluded (executor doesn't report, e.g. codex CLI); batch indexes are excluded to avoid double counting`;
    costLabel = `<span title="${e(tip)}">${baseLabel} ${costNumber}</span>`;
  }

  // Collect variants with ≥2 reports for trend links
  const variantCounts: Record<string, number> = {};
  for (const run of evaluationRuns) {
    for (const v of (run.meta?.variants || [])) {
      if (v === 'baseline') continue;
      variantCounts[v] = (variantCounts[v] || 0) + 1;
    }
  }
  const trendLinks = Object.entries(variantCounts)
    .filter(([, count]) => count >= 2)
    .map(([v]) => `<a href="/trends/${encodeURIComponent(v)}${langQ}" style="display:inline-block;margin:4px 6px 4px 0;padding:3px 10px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius);color:var(--accent);text-decoration:none">${e(v)} (${variantCounts[v]})</a>`)
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
    ${renderScoringModal('guide-scoring-list', lang)}
    <div class="table-wrap">
    <table id="report-table">
      <thead><tr>
        <th data-i18n="runId">${t('runId', lang)}</th>
        <th data-i18n="model">${t('model', lang)}</th>
        <th data-i18n="samples">${t('samples', lang)}</th>
        <th data-i18n="score">${t('score', lang)} <button type="button" class="hint-btn" onclick="openModal('guide-scoring-list')" aria-label="${e(lang === 'zh' ? '综合分怎么算的？' : 'How is composite computed?')}" aria-haspopup="dialog">?</button></th>
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
      fetch('/api/reports/' + encodeURIComponent(id), { method: 'DELETE' })
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

export function renderRunDetail(report: EvaluationReport | null, lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  if (!report) {
    return layout(t('title', lang), `
      <main>
      <nav class="nav"><a href="/${langQ}">${t('backToList', lang)}</a></nav>
      <h1>Run not found</h1>
      </main>
    `, lang);
  }

  const m = report.meta;
  const variants = m.variants || [];
  const summary = report.summary || {};
  const results = report.results || [];

  const cards = renderSummaryCards(variants, summary, lang, report.variance);
  const methodologyAudit = renderMethodologyAudit(report, variants, summary, lang);
  const verdictPill = renderVerdictPill(report, lang);
  const sampleTable = renderSampleTable(variants, results, lang);
  const totalExecCost = Object.values(summary).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0);
  // 任一 variant exec cost 未报告 → 总 cost 不可靠,renderer 显示「—」+ tooltip。
  // 全部 reported(undefined / true)才正常显示 USD 数字。
  const execCostReported = Object.values(summary).every((v) => v.execCostReported !== false);
  const totalCostReported = m.totalCostReported !== false && Object.values(summary).every((v) =>
    v.execCostReported !== false && v.judgeCostReported !== false);
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
  const artifactKindLabels: Record<string, Record<string, string>> = {
    zh: { baseline: '基线', skill: 'Skill', prompt: 'Prompt', agent: 'Agent', workflow: 'Workflow' },
    en: { baseline: 'Baseline', skill: 'Skill', prompt: 'Prompt', agent: 'Agent', workflow: 'Workflow' },
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
      <td>${e((artifactKindLabels[lang] || artifactKindLabels.en)[config.artifactKind] || config.artifactKind)}</td>
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
    ? `${m.sampleCount} 个评测用例 × ${variants.length} 组实验${repeatSuffix}`
    : `${pluralizeEn(m.sampleCount, 'sample')} × ${pluralizeEn(variants.length, 'variant')}${repeatSuffix}`;

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
    <nav class="nav"><a href="/${langQ}" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${e(report.id)}</h1>
    ${(() => {
      // Run ID 形如 `<name>-YYYYMMDD-HHMM`,把时间戳解出来作为人类可读的副标小字
      // (报告什么时候跑的)。完整 run-id 仍是 H1,与列表页保持一致。
      const idMatch = /^.+?-(\d{8})-(\d{4})$/.exec(report.id);
      if (idMatch) {
        const [, ymd, hm] = idMatch;
        const stamp = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
        return `<p class="run-id-stamp">${lang === 'zh' ? '运行时间' : 'ran at'}: ${e(stamp)}</p>`;
      }
      return '';
    })()}
    ${verdictPill}
    <div class="meta-tags">
      <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
      ${(() => {
        if (m.noJudge) return `<span class="meta-tag">${t('judge', lang)}: none</span>`;
        const list = m.judgeModels ?? [];
        if (list.length === 0) return `<span class="meta-tag">${t('judge', lang)}: —</span>`;
        if (list.length === 1) return `<span class="meta-tag">${t('judge', lang)}: ${e(`${list[0].executor}:${list[0].model}`)}</span>`;
        return `<span class="meta-tag" title="${t('ensembleDesc', lang)}">${t('judgeModelsLabel', lang)}: ${list.map((j) => e(`${j.executor}:${j.model}`)).join(' · ')}</span>`;
      })()}
      ${m.judgeRepeat && m.judgeRepeat > 1 ? `<span class="meta-tag" title="${t('judgeStddevDesc', lang)}">${t('judgeRepeatLabel', lang)}: ${m.judgeRepeat}</span>` : ''}
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'claude')}</span>
      ${m.effort ? `<span class="meta-tag" title="${e(lang === 'zh' ? 'executor LLM 的扩展思考预算(--effort)。跨 effort 报告不可严格比较' : 'reasoning effort for executor LLM (--effort); reports across different efforts are not strictly comparable')}">effort: ${e(m.effort)}</span>` : ''}
      <span class="meta-tag"${execCostReported ? '' : ` title="${e(lang === 'zh' ? 'executor 不报 USD 成本(如 codex CLI),无法估算' : 'executor does not report USD cost (e.g. codex CLI); not measurable')}"`}>${t('cost', lang)}: ${fmtCost(totalExecCost, execCostReported)}</span>
      <span class="meta-tag"${totalCostReported ? '' : ` title="${e(costCompletenessTooltip(lang))}"`}>${t('totalCost', lang)}: ${fmtKnownCost(m.totalCostUSD, totalCostReported)}</span>
      <span class="meta-tag">${lang === 'zh' ? '耗时' : 'Duration'}: ${fmtDuration(totalDurationMs)}</span>
      ${m.gitInfo ? `<span class="meta-tag">${lang === 'zh' ? '提交' : 'commit'}: ${e(m.gitInfo.commitShort)}${m.gitInfo.dirty ? '*' : ''} (${e(m.gitInfo.branch)})</span>` : ''}
      ${m.sampleHashes ? `<span class="meta-tag" title="${t('sampleHashCountDesc', lang)}">${t('sampleHashCount', lang)}: ${Object.keys(m.sampleHashes).length}/${m.sampleCount}</span>` : ''}
      ${m.evaluationFramework ? `<span class="meta-tag" title="${t('evalFrameworkDesc', lang)}">${t('evalFrameworkLabel', lang)}: ${m.evaluationFramework === 'bootstrap' ? t('evalFrameworkBootstrap', lang) : m.evaluationFramework === 'both' ? t('evalFrameworkBoth', lang) : t('evalFrameworkTTest', lang)}</span>` : ''}
      ${renderDebiasModeTag(m.debiasMode, lang)}
      ${m.blind ? `<span class="meta-tag" style="color:var(--green)" data-i18n="blindLabel">${t('blindLabel', lang)}</span>` : ''}
    </div>
    ${(() => {
      // 审计指纹 (评委 prompt hash + 执行环境 fingerprint) 默认折叠 ——
      // 平日 review 不需要看, 复现时再展开。同 fingerprint 多次出现已合并。
      const auditTags = [
        m.judgePromptHash ? `<span class="meta-tag" title="${t('judgePromptHashDesc', lang)}">${t('judgePromptHashLabel', lang)}: <code>${e(m.judgePromptHash)}</code></span>` : '',
        renderRuntimeFingerprintTags(m, lang),
      ].join('');
      if (!auditTags) return '';
      return `<details class="audit-fingerprints"><summary>${lang === 'zh' ? '审计指纹（用于复现校验）' : 'Audit fingerprints (for reproducibility)'}</summary><div class="meta-tags">${auditTags}</div></details>`;
    })()}
    ${m.blind ? `
    <div style="margin:12px 0">
      <button onclick="document.getElementById('blind-reveal').style.display=document.getElementById('blind-reveal').style.display==='none'?'block':'none'" data-i18n="revealBlind">${t('revealBlind', lang)}</button>
      <div id="blind-reveal" style="display:none;margin-top:8px;padding:12px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)" role="region" aria-label="Blind variant mapping">
        ${Object.entries(m.blindMap || {}).map(([label, real]) => `<div style="font-size:13px;color:var(--text-secondary)"><strong>Variant ${e(label)}</strong> → ${e(real)}</div>`).join('')}
      </div>
    </div>` : ''}

    <div class="omk-view-tabs" role="tablist">
      <button type="button" class="omk-view-tab omk-view-tab--active" data-view="score" onclick="omkSwitchView('score')">${lang === 'zh' ? '📊 评分' : '📊 Score'}</button>
      <button type="button" class="omk-view-tab" data-view="test" onclick="omkSwitchView('test')">${lang === 'zh' ? '✅ 单测' : '✅ Tests'}</button>
    </div>

    <div class="omk-view-panel" data-view="score">
    ${variantConfigSection}

    <section>${cards}</section>
    ${methodologyAudit}

    ${renderVarianceComparisons(report.variance, lang, Boolean(report.meta.layeredStats), summary)}

    ${renderAnalysis(report, lang)}

    ${renderAgentOverview(variants, summary, lang)}

    ${renderKnowledgeInteractionSection(report.analysis?.coverage, report.analysis?.gapReports, lang)}

    <section>${sampleTable}</section>
    </div>

    <div class="omk-view-panel" data-view="test" hidden>
    ${renderTestView(report, lang)}
    </div>

    <style>${TEST_VIEW_CSS}
.omk-view-tabs { display:flex;gap:8px;margin:16px 0 12px;border-bottom:1px solid var(--border) }
.omk-view-tab { padding:8px 16px;background:transparent;border:none;cursor:pointer;color:var(--text-muted);border-bottom:2px solid transparent;font-size:14px;font-weight:500 }
.omk-view-tab--active { color:var(--text-primary);border-bottom-color:var(--accent, #3b82f6);font-weight:600 }
.omk-view-tab:hover:not(.omk-view-tab--active) { color:var(--text-secondary) }
    </style>
    <script>${TEST_VIEW_JS}</script>

    </main>
  `, lang);
}

export function renderBatchEvaluationDetail(report: BatchEvaluationReport | null, lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  if (!report) {
    return layout(t('title', lang), `
      <main>
      <nav class="nav"><a href="/${langQ}">${t('backToList', lang)}</a></nav>
      <h1>Run not found</h1>
      </main>
    `, lang);
  }

  const m = report.meta;
  const allCostReported = report.items.every((item) =>
    Object.values(item.summary || {}).every((v) =>
      v.execCostReported !== false && v.judgeCostReported !== false));
  const totalCostReported = m.totalCostReported !== false && allCostReported;
  const repeatN = report.meta.request?.repeat;
  const repeatSegment = repeatN && repeatN > 1
    ? (lang === 'zh' ? ` · ${repeatN} 轮重复` : ` · ${repeatN} runs`)
    : '';
  const overviewSubtitle = lang === 'zh'
    ? `${m.totalArtifacts || report.items.length} 个 Skill · ${m.sampleCount || 0} 个评测用例${repeatSegment} · ${fmtKnownCost(m.totalCostUSD || 0, totalCostReported)}`
    : `${pluralizeEn(m.totalArtifacts || report.items.length, 'skill')} · ${pluralizeEn(m.sampleCount || 0, 'sample')}${repeatSegment} · ${fmtKnownCost(m.totalCostUSD || 0, totalCostReported)}`;

  const rows = report.items.map((item) => {
    const baselineScore = scoreOf(item.summary.baseline);
    const skillScore = scoreOf(item.summary[item.name]);
    const improvement = improvementOf(baselineScore, skillScore);
    const impColor = improvement.startsWith('+') ? 'var(--green)' : improvement.startsWith('-') ? 'var(--red)' : 'var(--text-muted)';
    const hashShort = item.artifactHash ? e(item.artifactHash).slice(0, 12) : '-';
    return `<tr>
      <td><a href="/reports/${encodeURIComponent(item.reportId)}${langQ}">${e(item.name)}</a></td>
      <td>${typeof baselineScore === 'number' ? baselineScore.toFixed(2) : '-'}</td>
      <td>${typeof skillScore === 'number' ? skillScore.toFixed(2) : '-'}</td>
      <td style="color:${impColor};font-weight:600">${improvement}</td>
      <td>${item.sampleCount}</td>
      <td>${fmtCost(item.totalCostUSD, allCostReported)}</td>
      <td><code style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${hashShort}</code></td>
    </tr>`;
  }).join('');

  return layout(`${t('reportTitle', lang)} - ${report.id}`, `
    <main>
    <nav class="nav"><a href="/${langQ}" data-i18n="backToList">${t('backToList', lang)}</a></nav>
    <h1>${e(report.id)}</h1>
    <div class="meta-tags">
      <span class="meta-tag">${lang === 'zh' ? '类型' : 'type'}: batch evaluation</span>
      <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
      ${(() => {
        if (m.noJudge) return `<span class="meta-tag">${t('judge', lang)}: none</span>`;
        const list = m.judgeModels ?? [];
        if (list.length === 0) return `<span class="meta-tag">${t('judge', lang)}: —</span>`;
        if (list.length === 1) return `<span class="meta-tag">${t('judge', lang)}: ${e(`${list[0].executor}:${list[0].model}`)}</span>`;
        return `<span class="meta-tag" title="${t('ensembleDesc', lang)}">${t('judgeModelsLabel', lang)}: ${list.map((j) => e(`${j.executor}:${j.model}`)).join(' · ')}</span>`;
      })()}
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'claude')}</span>
      <span class="meta-tag"${totalCostReported ? '' : ` title="${e(costCompletenessTooltip(lang))}"`}>${t('totalCost', lang)}: ${fmtKnownCost(m.totalCostUSD, totalCostReported)}</span>
    </div>
    ${(() => {
      const auditTags = renderRuntimeFingerprintTags(m, lang);
      if (!auditTags) return '';
      return `<details class="audit-fingerprints"><summary>${lang === 'zh' ? '审计指纹（用于复现校验）' : 'Audit fingerprints (for reproducibility)'}</summary><div class="meta-tags">${auditTags}</div></details>`;
    })()}

    <section>
    <h2>${t('batchOverview', lang)}</h2>
    <p style="font-size:13px;color:var(--text-muted)">${overviewSubtitle}</p>
    <div class="table-wrap">
    <table>
      <thead><tr>
        <th>${t('batchSkill', lang)}</th>
        <th>${t('batchBaseline', lang)}</th>
        <th>${t('batchWithSkill', lang)}</th>
        <th>${t('batchImprovement', lang)}</th>
        <th>${t('samples', lang)}</th>
        <th>${t('cost', lang)}</th>
        <th>${t('artifactHashLabel', lang)}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
    </section>

    </main>
  `, lang);
}

export function renderReportDocumentDetail(report: ReportDocument | null, lang: Lang = DEFAULT_LANG): string {
  if (!report) return renderRunDetail(null, lang);
  return report.kind === 'batch-evaluation'
    ? renderBatchEvaluationDetail(report, lang)
    : renderRunDetail(report, lang);
}

export function renderTrendsPage(variantName: string, runs: Report[], lang: Lang = DEFAULT_LANG): string {
  const body = renderTrendsBody(variantName, runs, lang);
  return layout(`${variantName} — ${lang === 'zh' ? '趋势' : 'Trends'}`, `<main>${body}</main>`, lang);
}
