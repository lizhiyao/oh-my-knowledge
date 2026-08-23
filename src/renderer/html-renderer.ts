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
import { renderTestView, TEST_VIEW_CSS, TEST_VIEW_JS } from './test-view.js';
import { renderTrendsBody } from './trends.js';
import { reportShell, healthColor, type SkillReportContext } from './report-shell.js';
import { icon } from './icons.js';
import { computeVerdict, type VerdictLevel } from '../eval-core/verdict.js';
import type { BatchEvaluationReport, EvaluationReport, ExecutorRuntimeFingerprint, Report, ReportDocument, Lang, VariantSummary } from '../types/index.js';
import { incrementRecordCount } from '../shared/record-count.js';

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

type RuntimeMeta = Pick<
  EvaluationReport['meta'],
  'executorRuntime' | 'executorRuntimes' | 'judgeModels' | 'noJudge' | 'diagnostic'
>;

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
  role: 'executor' | 'judge' | 'diagnostic';
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
  if (meta.diagnostic?.enabled && meta.diagnostic.runtime) {
    scopes.push({
      role: 'diagnostic',
      scope: `${meta.diagnostic.executor}:${meta.diagnostic.model}`,
      runtime: meta.diagnostic.runtime,
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
    `kind=${runtime.runtimeKind}`,
    `system=${runtime.capabilities.systemPrompt}`,
    `cost=${runtime.capabilities.costUSD}`,
    `trace=${runtime.capabilities.trace}`,
    `skillIsolation=${runtime.capabilities.skillIsolation}`,
    ...(runtime.auditability ? [`auditability=${runtime.auditability.status}`] : []),
    ...(runtime.binary?.contentHash
      ? [`contentHash=${runtime.binary.contentHash}`]
      : []),
  ].join('; ');
}

// 同 fingerprint + 同 binary/sdk 版本 = 同一执行环境，合并为一条 tag。
// 旧版给每个 executor / judge 单独一条 pill，3 个角色用同一 binary 时
// fingerprint 重复 3 遍，扫读成本高。新版按 (fingerprint, versionText)
// 分组，scope 合并到 tag 内 "适用于 ..." 后缀。
function renderRuntimeFingerprintTags(meta: RuntimeMeta, lang: Lang): string {
  const scopes = gatherRuntimeScopes(meta);
  if (scopes.length === 0) return '';

  const groups = new Map<string, {
    runtime: ExecutorRuntimeFingerprint;
    versionText: string;
    executors: string[];
    judges: string[];
    diagnostics: string[];
  }>();
  for (const s of scopes) {
    const versionText = runtimeVersionText(s.runtime, lang);
    const key = `${s.runtime.fingerprint}|${versionText}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        runtime: s.runtime,
        versionText,
        executors: [],
        judges: [],
        diagnostics: [],
      };
      groups.set(key, g);
    }
    if (s.role === 'executor') g.executors.push(s.scope || (lang === 'zh' ? '默认' : 'default'));
    else if (s.role === 'judge') g.judges.push(s.scope);
    else g.diagnostics.push(s.scope);
  }

  const groupLabel = lang === 'zh' ? '执行环境指纹' : 'Runtime fingerprint';
  return Array.from(groups.values()).map((g) => {
    const scopeBits: string[] = [];
    if (g.executors.length > 0) scopeBits.push(`${lang === 'zh' ? '执行器' : 'executor'} ${g.executors.join(', ')}`);
    if (g.judges.length > 0) scopeBits.push(`${lang === 'zh' ? '评委' : 'judge'} ${g.judges.join(', ')}`);
    if (g.diagnostics.length > 0) scopeBits.push(`${lang === 'zh' ? '诊断' : 'diagnostic'} ${g.diagnostics.join(', ')}`);
    const scopeText = scopeBits.length > 0 ? ` · ${lang === 'zh' ? '适用' : 'used by'} ${e(scopeBits.join('; '))}` : '';
    return `<span class="meta-tag" title="${e(runtimeTooltip(g.runtime))}">${e(groupLabel)}: <code>${e(g.runtime.fingerprint)}</code>${g.versionText}${scopeText}</span>`;
  }).join('');
}

export function renderRunList(runs: ReportDocument[], lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const skillHealthLink = `<a class="page-secondary-link" href="/observe-health${langQ}">📊 <span data-i18n="skillHealthTitle">${t('skillHealthTitle', lang)}</span> →</a>`;
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

  // v0.30 — 卡片式列表(取代 7 列 dense table),每条占 4-5 行垂直空间但信息密度更可读。
  // 顶部 verdict pill 主导视觉,id+date 是身份,scores 是成绩,底部 meta 是元数据,
  // delete 默认隐藏在 hover 出现避免误点。批量报告共用同一组件,batch pill 替代 verdict。
  const formatDateFromId = (id: string, fallbackTs?: string): string => {
    // 兼容三代 run id 后缀:旧 `…YYYYMMDD-HHmm`、过渡期 `…YYYYMMDD-HHmmss-rand4`、
    // 统一后 `…YYYYMMDDTHHmmss-rand4`(含秒+随机)。
    // 都从 id 直接派生本地展示时间(确定性,不走时区敏感的 toLocaleString);新增的秒段 + 随机后缀可选匹配。
    const idMatch = id.match(/(\d{4})(\d{2})(\d{2})(?:T|-)(\d{2})(\d{2})(?:\d{2})?(?:-[a-z0-9]+)?$/);
    if (idMatch) return `${idMatch[2]}/${idMatch[3]} ${idMatch[4]}:${idMatch[5]}`;
    return fallbackTs ? new Date(fallbackTs).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  };
  const renderScoreBar = (label: string, score: number | null): string => {
    if (score == null) return `<span class="rc-score-empty">${e(label)}: —</span>`;
    const cls = score >= 4 ? 'pass' : score >= 3 ? 'warn' : 'fail';
    const barW = Math.round((score / 5) * 100);
    return `<div class="rc-score-row"><span class="rc-score-label" title="${e(label)}">${e(label)}</span>` +
      `<div class="rc-score-bar"><div class="rc-score-bar-fill rc-score-bar-fill--${cls}" style="width:${barW}%"></div></div>` +
      `<span class="rc-score-num rc-score-num--${cls}">${score.toFixed(2)}</span></div>`;
  };

  const cards = runs.map((run) => {
    if (run.kind === 'batch-evaluation') {
      const m = run.meta;
      const scores = run.items.length > 0
        ? run.items.map((item) => {
          const baselineScore = scoreOf(item.summary.baseline);
          const skillScore = scoreOf(item.summary[item.name]);
          return renderScoreBar(item.name, skillScore ?? baselineScore);
        }).join('')
        : `<div class="rc-score-empty">${lang === 'zh' ? '无分数' : 'no score'}</div>`;
      const totalDurationMs = run.items.reduce((sum, item) => (
        sum + Object.values(item.summary || {}).reduce((inner, v) => inner + (v.avgDurationMs || 0) * (v.successCount || 0), 0)
      ), 0);
      const statusPill = `<span class="run-status" title="${lang === 'zh' ? '批量评测' : 'batch evaluation'}"><span class="run-status-dot" aria-hidden="true">◇</span>${lang === 'zh' ? '批量' : 'Batch'}</span>`;
      const date = formatDateFromId(run.id, m.timestamp);
      return `<a class="run-card" href="/reports/${e(run.id)}${langQ}">
        <div class="run-card-h">
          ${statusPill}
          <span class="run-card-id">${e(run.id)}</span>
          ${date ? `<span class="run-card-date">${e(date)}</span>` : ''}
        </div>
        <div class="run-card-meta">${e(m.model || '-')} · ${m.sampleCount || 0} ${lang === 'zh' ? '用例' : 'samples'} · ${run.items.length} skills</div>
        <div class="run-card-scores">${scores}</div>
        <div class="run-card-foot">
          <span class="run-card-stat">${fmtDuration(totalDurationMs)}</span>
          <button class="run-card-delete" onclick="event.preventDefault();event.stopPropagation();deleteRun('${e(run.id)}',this)" data-i18n="deleteBtnText" aria-label="${e(t('deleteBtnText', lang))}">×</button>
        </div>
      </a>`;
    }

    const m = run.meta;
    const summary = run.summary || {};
    const hasScores = Object.values(summary).some((s) =>
      typeof s.avgCompositeScore === 'number' || typeof s.avgLlmScore === 'number'
    );
    const scoresHtml = hasScores
      ? Object.entries(summary).map(([v, s]) => renderScoreBar(v, s.avgCompositeScore ?? s.avgLlmScore ?? null)).join('')
      : `<div class="rc-score-empty">${lang === 'zh' ? '无分数' : 'no score'}</div>`;

    let statusPill = '';
    let verdictLvl: VerdictLevel | '' = '';
    try {
      const verdict = computeVerdict(run);
      verdictLvl = verdict.level;
      statusPill = `<span class="run-status verdict-${verdictLvl}" title="${e(levelTooltip(verdictLvl, lang))}" aria-label="${e(levelLabel(verdictLvl, lang))} — ${e(levelTooltip(verdictLvl, lang))}"><span class="run-status-dot" aria-hidden="true">${levelDot(verdictLvl)}</span>${e(levelLabel(verdictLvl, lang))}</span>`;
    } catch { /* skip pill on this row */ }

    const date = formatDateFromId(run.id, m.timestamp);
    const variants = (m.variants || []).join(' · ');
    const dur = Object.values(summary).reduce((s, v) => s + (v.avgDurationMs || 0) * (v.successCount || 0), 0);

    return `<a class="run-card${verdictLvl ? ` verdict-${verdictLvl}` : ''}" href="/reports/${e(run.id)}${langQ}">
      <div class="run-card-h">
        ${statusPill}
        <span class="run-card-id">${e(run.id)}</span>
        ${date ? `<span class="run-card-date">${e(date)}</span>` : ''}
      </div>
      <div class="run-card-meta">${e(m.model || '-')} · ${m.sampleCount || 0} ${lang === 'zh' ? '用例' : 'samples'}${variants ? ` · ${e(variants)}` : ''}</div>
      <div class="run-card-scores">${scoresHtml}</div>
      <div class="run-card-foot">
        <span class="run-card-stat">${fmtDuration(dur)}</span>
        <button class="run-card-delete" onclick="event.preventDefault();event.stopPropagation();deleteRun('${e(run.id)}',this)" data-i18n="deleteBtnText" aria-label="${e(t('deleteBtnText', lang))}">×</button>
      </div>
    </a>`;
  }).join('');

  const runCount = lang === 'zh' ? `${runs.length} 次评测` : `${runs.length} runs`;
  // v0.30 — 列表页移除累计金额展示(用户反馈无须暴露);保留 evaluationRuns 用于 trend links
  const evaluationRuns = runs.filter(isEvaluationReport);

  // Collect variants with ≥2 reports for trend links
  const variantCounts: Record<string, number> = {};
  for (const run of evaluationRuns) {
    for (const v of (run.meta?.variants || [])) {
      if (v === 'baseline') continue;
      incrementRecordCount(variantCounts, v);
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
    <p class="subtitle" data-i18n="subtitle">${t('subtitle', lang)} &middot; ${runCount}</p>
    ${trendsSection}
    <div style="margin:12px 0">${skillHealthLink}</div>
    <div style="margin:12px 0;display:flex;gap:8px;align-items:center">
      <input id="filter-input" type="text" placeholder="${lang === 'zh' ? '搜索报告名称、变体...' : 'Filter by name, variant...'}" style="flex:1;max-width:320px;padding:6px 10px;font-size:13px;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);outline:none" oninput="filterTable(this.value)">
      <span id="filter-count" style="font-size:11px;color:var(--text-muted)"></span>
    </div>
    ${renderScoringModal('guide-scoring-list', lang)}
    <div id="run-list" class="run-list">${cards}</div>
    <style>
    /* 列表页 — 卡片式布局,顶部 verdict pill 主导,底部 hover 露出 delete */
    .page-secondary-link { color:var(--text-secondary);font-size:13px;text-decoration:none;border:1px solid var(--border);padding:6px 14px;border-radius:var(--radius);display:inline-block;background:var(--bg-surface);transition:border-color .15s,color .15s }
    .page-secondary-link:hover { color:var(--text-primary);border-color:var(--border-hover);text-decoration:none }
    .run-list { display:flex;flex-direction:column;gap:12px;margin:16px 0 }
    /* verdict 用左边粗带 + 浅色填充背景双重视觉提示,远看也能区分。
       PROGRESS = sage 绿(进步),REGRESS = 砖红(回归),CAUTIOUS = 琥珀(警示),其他 = 灰(无信号) */
    .run-card { display:block;padding:18px 22px;background:var(--bg-surface);border-radius:var(--radius);box-shadow:var(--shadow-sm);text-decoration:none;color:inherit;transition:box-shadow .15s,transform .05s;border-left:5px solid transparent;position:relative }
    .run-card:hover { box-shadow:var(--shadow-md);text-decoration:none }
    .run-card:hover .run-card-delete { opacity:1 }
    .run-card.verdict-PROGRESS { border-left-color:var(--green);background:linear-gradient(90deg,var(--green-bg) 0%,var(--bg-surface) 80%) }
    .run-card.verdict-REGRESS { border-left-color:var(--red);background:linear-gradient(90deg,var(--red-bg) 0%,var(--bg-surface) 80%) }
    .run-card.verdict-CAUTIOUS { border-left-color:var(--yellow);background:linear-gradient(90deg,var(--yellow-bg) 0%,var(--bg-surface) 80%) }
    .run-card.verdict-NOISE, .run-card.verdict-UNDERPOWERED { border-left-color:var(--text-faint);opacity:0.85 }
    .run-card.verdict-SOLO { border-left-color:var(--accent);background:linear-gradient(90deg,var(--info-bg) 0%,var(--bg-surface) 80%) }
    .run-card-h { display:flex;align-items:center;gap:12px;margin-bottom:6px;flex-wrap:wrap }
    .run-card-id { font-size:15px;font-weight:600;color:var(--text-primary);font-family:"SF Mono",Menlo,Consolas,monospace;letter-spacing:-0.01em }
    .run-card-date { font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums;margin-left:auto }
    .run-card-meta { font-size:13px;color:var(--text-secondary);margin:6px 0 12px;line-height:1.6 }
    .run-card-scores { display:flex;flex-direction:column;gap:4px;margin:8px 0 }
    .run-card-foot { display:flex;gap:16px;margin-top:10px;align-items:center;font-size:12px;color:var(--text-muted);font-variant-numeric:tabular-nums }
    .run-card-stat { font-family:"SF Mono",Menlo,monospace }
    .run-card-delete { margin-left:auto;background:transparent;border:none;color:var(--text-muted);font-size:18px;line-height:1;width:28px;height:28px;border-radius:14px;cursor:pointer;opacity:0;transition:opacity .15s,background .15s,color .15s;outline:none;appearance:none }
    .run-card-delete:hover { background:var(--red-bg);color:var(--red) }
    /* 分数行(每个 variant 一行) */
    .rc-score-row { display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.6 }
    .rc-score-label { font-size:12px;color:var(--text-secondary);min-width:80px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0 }
    .rc-score-bar { width:120px;height:6px;background:var(--bg-soft);border-radius:3px;flex-shrink:0;overflow:hidden }
    .rc-score-bar-fill { height:100%;border-radius:3px;transition:width .2s }
    .rc-score-bar-fill--pass { background:var(--green) }
    .rc-score-bar-fill--warn { background:var(--yellow) }
    .rc-score-bar-fill--fail { background:var(--red) }
    .rc-score-num { font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;font-family:"SF Mono",Menlo,monospace;min-width:36px }
    .rc-score-num--pass { color:var(--green) }
    .rc-score-num--warn { color:var(--yellow) }
    .rc-score-num--fail { color:var(--red) }
    .rc-score-empty { color:var(--text-faint);font-size:12px;font-style:italic }
    </style>
    <script>
    function filterTable(q) {
      var cards = document.querySelectorAll('#run-list .run-card');
      var lower = q.toLowerCase();
      var shown = 0;
      cards.forEach(function(card) {
        var text = card.textContent.toLowerCase();
        var match = !q || text.indexOf(lower) !== -1;
        card.style.display = match ? '' : 'none';
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
          if (d.ok) { btn.closest('.run-card').remove(); }
          else { alert(I18N[lang].deleteFail + ': ' + (d.error || 'unknown')); }
        })
        .catch(function(err) { alert(I18N[lang].deleteFail + ': ' + err.message); });
    }
    </script>
    </main>
  `, lang);
}

export function renderRunDetail(report: EvaluationReport | null, lang: Lang = DEFAULT_LANG, skillContext?: SkillReportContext): string {
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

  const cards = renderSummaryCards(variants, summary, lang, report.variance);
  const methodologyAudit = renderMethodologyAudit(report, variants, summary, lang);
  // 单 variant(SOLO)不显示 verdict — 对照才有的概念,单组是噪音/误导(见融合设计)。
  const verdictPill = variants.length > 1 ? renderVerdictPill(report, lang) : '';

  // Hero：综合分 ring（取 treatment = 最后一个 variant 的综合分）+ skill 名 + 时间戳。
  const treatmentName = variants[variants.length - 1];
  const heroComposite = treatmentName ? (summary[treatmentName]?.avgCompositeScore ?? null) : null;
  const heroScore100 = heroComposite != null ? Math.round((heroComposite / 5) * 100) : null;
  const heroSkillName = report.meta.evolve?.skillName ?? treatmentName ?? report.id;
  const heroTs = (() => {
    try { const d = new Date(report.meta.timestamp); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } catch { return ''; }
  })();
  const totalExecCost = Object.values(summary).reduce((s, v) => s + (v.totalExecCostUSD || 0), 0);
  // 任一 variant exec cost 未报告 → 总 cost 不可靠,renderer 显示「—」+ tooltip。
  // 全部 reported(undefined / true)才正常显示 USD 数字。
  const execCostReported = Object.values(summary).every((v) => v.execCostReported !== false);
  const totalCostReported = m.totalCostReported !== false && Object.values(summary).every((v) =>
    v.execCostReported !== false && v.judgeCostReported !== false);
  const totalCostLabel = m.evolve
    ? (lang === 'zh' ? '评测成本' : 'Measurement cost')
    : t('totalCost', lang);
  const processCostTag = m.evolve?.processCostUSD === undefined
    ? ''
    : `<span class="meta-tag"${m.evolve.processCostReported === false
      ? ` title="${e(costCompletenessTooltip(lang))}"`
      : ''}>${lang === 'zh' ? '迭代总成本' : 'Total evolve cost'}: ${fmtKnownCost(
      m.evolve.processCostUSD,
      m.evolve.processCostReported !== false,
    )}</span>`;
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

  // v0.30 — 实验配置弱化:单行 inline 摘要,跟 Agent 执行概览并排放(context-strip)。
  // 每变体一行:左 3px 颜色条 + variant 名 + type/kind/source/strategy/cwd 用 · 分隔。
  // 完整 key 名通过 hover tooltip 提供。视觉权重远低于综合分 hero。
  const variantConfigRows = (m.variantConfigs || []).map((config, i) => {
    const expTypeRaw = config.experimentType || '-';
    const expType = (typeLabels[lang] || typeLabels.en)[String(expTypeRaw)] || expTypeRaw;
    const source = config.artifactKind === 'baseline'
      ? (lang === 'zh' ? '无来源' : 'no source')
      : (sourceLabels[lang] || sourceLabels.en)[config.artifactSource] || config.artifactSource;
    const strategy = (strategyLabels[lang] || strategyLabels.en)[config.executionStrategy] || config.executionStrategy;
    const cwdRaw = config.cwd || '';
    const runtimeContext = cwdRaw
      ? cwdRaw.replace(/.*\/Projects\//, '').replace(/.*\/Documents\//, '').replace(/\/Users\/[^/]+\//, '~/')
      : (lang === 'zh' ? '默认 cwd' : 'default cwd');
    const color = COLORS[i % COLORS.length];
    const artifactKindLabel = e((artifactKindLabels[lang] || artifactKindLabels.en)[config.artifactKind] || config.artifactKind);
    const tooltip = `${t('variantType', lang)}: ${expType} · ${t('variantArtifactKind', lang)}: ${artifactKindLabel} · ${t('variantArtifactSource', lang)}: ${source} · ${t('variantExecutionStrategy', lang)}: ${strategy} · ${t('variantRuntimeContext', lang)}: ${cwdRaw || (lang === 'zh' ? '默认' : 'default')}`;
    return `<div class="ctx-row" style="border-left:3px solid ${color}" title="${e(tooltip)}">
      <span class="ctx-row-name">${e(config.variant)}</span>
      <span class="ctx-row-bits">${e(expType)} <span class="ctx-sep">·</span> ${artifactKindLabel} <span class="ctx-sep">·</span> ${e(source)} <span class="ctx-sep">·</span> ${e(strategy)} <span class="ctx-sep">·</span> ${e(runtimeContext)}</span>
    </div>`;
  }).join('');
  const configModalId = 'guide-variant-config';
  const repeatSuffix = report.variance
    ? (lang === 'zh' ? ` × ${report.variance.runs} 轮` : ` × ${report.variance.runs} runs`)
    : '';
  const experimentSummary = lang === 'zh'
    ? `${m.sampleCount} 个用例 × ${variants.length} 组实验${repeatSuffix}`
    : `${pluralizeEn(m.sampleCount, 'sample')} × ${pluralizeEn(variants.length, 'variant')}${repeatSuffix}`;

  const variantConfigSection = variantConfigRows ? `
    <div class="ctx-block">
      <div class="ctx-h">${t('variantConfig', lang)} <button type="button" class="hint-btn" onclick="openModal('${configModalId}')" aria-label="${e(t('variantConfigDesc', lang))}" aria-haspopup="dialog">?</button></div>
      <div class="ctx-sub">${experimentSummary}</div>
      <div class="ctx-rows">${variantConfigRows}</div>
    </div>
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

  // v0.30 重设计 — 评分/单测各自独立 title + meta strip(不共享头部)。
  // 顶部只保留极简身份带:返回链接 + run-id pill。完整 H1 + meta tags 移进各自 tab 面板。
  // ──────────── 评分 tab 的 meta tags(原版全部留这里) ────────────
  const scoreMetaTags = `<div class="meta-tags">
    <span class="meta-tag">${t('model', lang)}: ${e(m.model)}</span>
    ${(() => {
      if (m.noJudge) return `<span class="meta-tag">${t('judge', lang)}: none</span>`;
      const list = m.judgeModels ?? [];
      if (list.length === 0) return `<span class="meta-tag">${t('judge', lang)}: —</span>`;
      if (list.length === 1) return `<span class="meta-tag">${t('judge', lang)}: ${e(`${list[0].executor}:${list[0].model}`)}</span>`;
      return `<span class="meta-tag" title="${t('ensembleDesc', lang)}">${t('judgeModelsLabel', lang)}: ${list.map((j) => e(`${j.executor}:${j.model}`)).join(' · ')}</span>`;
    })()}
    ${m.judgeRepeat && m.judgeRepeat > 1 ? `<span class="meta-tag" title="${t('judgeStddevDesc', lang)}">${t('judgeRepeatLabel', lang)}: ${m.judgeRepeat}</span>` : ''}
    <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'unknown')}</span>
    ${m.effort ? `<span class="meta-tag" title="${e(lang === 'zh' ? 'executor LLM 的扩展思考预算(--effort)。跨 effort 报告不可严格比较' : 'reasoning effort for executor LLM (--effort); reports across different efforts are not strictly comparable')}">effort: ${e(m.effort)}</span>` : ''}
    <span class="meta-tag"${execCostReported ? '' : ` title="${e(lang === 'zh' ? 'executor 不报 USD 成本(如 codex CLI),无法估算' : 'executor does not report USD cost (e.g. codex CLI); not measurable')}"`}>${t('cost', lang)}: ${fmtCost(totalExecCost, execCostReported)}</span>
    <span class="meta-tag"${totalCostReported ? '' : ` title="${e(costCompletenessTooltip(lang))}"`}>${totalCostLabel}: ${fmtKnownCost(m.totalCostUSD, totalCostReported)}</span>${processCostTag ? `
    ${processCostTag}` : ''}
    <span class="meta-tag">${lang === 'zh' ? '耗时' : 'Duration'}: ${fmtDuration(totalDurationMs)}</span>
    ${m.gitInfo ? `<span class="meta-tag">${lang === 'zh' ? '提交' : 'commit'}: ${e(m.gitInfo.commitShort)}${m.gitInfo.dirty ? '*' : ''} (${e(m.gitInfo.branch)})</span>` : ''}
    ${m.sampleHashes ? `<span class="meta-tag" title="${t('sampleHashCountDesc', lang)}">${t('sampleHashCount', lang)}: ${Object.keys(m.sampleHashes).length}/${m.sampleCount}</span>` : ''}
    ${m.evaluationFramework ? `<span class="meta-tag" title="${t('evalFrameworkDesc', lang)}">${t('evalFrameworkLabel', lang)}: ${m.evaluationFramework === 'bootstrap' ? t('evalFrameworkBootstrap', lang) : m.evaluationFramework === 'both' ? t('evalFrameworkBoth', lang) : t('evalFrameworkTTest', lang)}</span>` : ''}
    ${renderDebiasModeTag(m.debiasMode, lang)}
  </div>`;

  const auditFingerprints = (() => {
    const auditTags = [
      m.judgePromptHash ? `<span class="meta-tag" title="${t('judgePromptHashDesc', lang)}">${t('judgePromptHashLabel', lang)}: <code>${e(m.judgePromptHash)}</code></span>` : '',
      m.diagnostic?.promptHash ? `<span class="meta-tag" title="${e(lang === 'zh' ? '失败诊断 system prompt 的 SHA256 前 12 位' : 'SHA256-12 of the failure-diagnostic system prompt')}">${lang === 'zh' ? '诊断提示词指纹' : 'Diagnostic prompt fingerprint'}: <code>${e(m.diagnostic.promptHash)}</code></span>` : '',
      renderRuntimeFingerprintTags(m, lang),
    ].join('');
    if (!auditTags) return '';
    return `<details class="audit-fingerprints"><summary>${lang === 'zh' ? '审计指纹（用于复现校验）' : 'Audit fingerprints (for reproducibility)'}</summary><div class="meta-tags">${auditTags}</div></details>`;
  })();

  // ──────────── 融合单页:Hero → 结论(verdict+六维) → 折叠次要区 → 统一逐用例 ────────────
  const agentOverview = renderAgentOverview(variants, summary, lang);
  const varianceSection = renderVarianceComparisons(report.variance, lang, Boolean(report.meta.layeredStats), summary);
  const analysisSection = renderAnalysis(report, lang);
  const knowledgeSection = renderKnowledgeInteractionSection(report.analysis?.coverage, report.analysis?.gapReports, lang);

  // 折叠区 A:实验如何跑的(配置 / 运行参数 / Agent 概览 / 审计指纹)— 复现/审计才看。
  const setupInner = [
    scoreMetaTags,
    (variantConfigSection || agentOverview) ? `<div class="ctx-strip">${variantConfigSection}${agentOverview}</div>` : '',
    auditFingerprints,
  ].filter(Boolean).join('');
  const setupFold = setupInner
    ? `<details class="ev-fold"><summary>${lang === 'zh' ? '实验配置与运行参数' : 'Experiment setup & run params'}</summary><div class="ev-fold-body">${setupInner}</div></details>`
    : '';

  // 折叠区 B:深入分析(方法学审计 / 方差 / 自动分析 / 知识交互)— 想验证测量学时展开。
  const analysisInner = [methodologyAudit, varianceSection, analysisSection, knowledgeSection].filter(Boolean).join('');
  const analysisFold = analysisInner
    ? `<details class="ev-fold"><summary>${lang === 'zh' ? '方法学审计 · 方差 · 自动分析 · 知识交互' : 'Methodology audit · variance · analysis · knowledge'}</summary><div class="ev-fold-body">${analysisInner}</div></details>`
    : '';

  // 「结论」panel:多 variant = verdict 一句话领头 + 六维表;单 variant = 直接六维分布。
  const conclusionPanel = `<section class="ev-conclusion">${verdictPill}${cards}</section>`;

  const samplesSubtitle = lang === 'zh'
    ? '每条用例既是评分卡也是功能测试：综合分 + 三层分布、断言、诊断与执行轨迹合一'
    : 'Each sample is both a score card and a functional test: composite + layered scores, assertions, diagnostics, and trace combined';

  const body = `
    ${conclusionPanel}
    ${setupFold}
    ${analysisFold}
    <section class="ev-samples">
      <h2 class="ev-samples-h">${lang === 'zh' ? '逐用例' : 'Per-sample'}</h2>
      <p class="subtitle ev-samples-sub">${samplesSubtitle}</p>
      ${renderTestView(report, lang)}
    </section>${TEST_VIEW_JS ? `<script>${TEST_VIEW_JS}</script>` : ''}`;

  const evalCss = `${TEST_VIEW_CSS}
/* 结论 panel — verdict(多 variant)+ 六维,白底卡片成「答案」模块,与 hero / fold 同一视觉语言 */
.ev-conclusion{background:#fff;border:1px solid #e4e8f1;border-radius:12px;box-shadow:0 8px 24px rgba(31,41,55,4%);padding:18px 24px 20px;margin:0 0 16px}
.ev-conclusion>:first-child{margin-top:0}
.ev-conclusion>h2:first-child{margin-top:2px}
/* 次要折叠区 — 实验配置 / 方法学 / 方差 / 分析,默认收起,审计/复现时展开 */
.ev-fold{margin:10px 0;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius)}
.ev-fold>summary{cursor:pointer;list-style:none;font-size:13px;font-weight:500;color:var(--text-secondary);padding:12px 16px}
.ev-fold>summary::-webkit-details-marker{display:none}
.ev-fold>summary::before{content:'▸ ';color:var(--text-muted)}
.ev-fold[open]>summary::before{content:'▾ '}
.ev-fold[open]>summary{border-bottom:1px solid var(--border);color:var(--text-primary)}
.ev-fold>summary:hover{color:var(--text-primary)}
.ev-fold-body{padding:8px 16px 16px}
.ev-fold-body>section:first-child,.ev-fold-body>.audit-fingerprints:first-child{margin-top:0}
.ev-fold-body .meta-tags{margin-top:8px}
/* 逐用例 section 标题 */
.ev-samples{margin-top:28px}
.ev-samples-h{font-size:1.4rem;margin:0 0 4px;color:var(--text-primary)}
.ev-samples-sub{font-size:13.5px;color:var(--text-secondary);margin:0 0 8px;line-height:1.6}
/* Context strip — 实验配置 + Agent 概览并排,辅助元数据 */
.ctx-strip { display:grid;gap:14px;grid-template-columns:1fr 1fr;margin:14px 0 24px }
@media (max-width:760px) { .ctx-strip { grid-template-columns:1fr } }
.ctx-block { background:var(--bg-surface);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:12px 16px }
.ctx-h { font-size:13px;color:var(--text-secondary);font-weight:600;margin-bottom:2px;display:flex;align-items:center;gap:4px;letter-spacing:0.02em }
.ctx-sub { font-size:12px;color:var(--text-muted);margin-bottom:10px }
.ctx-rows { display:flex;flex-direction:column;gap:6px }
.ctx-row { padding:8px 12px;background:var(--bg-soft);border-radius:4px;display:flex;align-items:center;gap:10px;font-size:13px;line-height:1.5;flex-wrap:wrap }
.ctx-row-name { font-weight:600;color:var(--text-primary);font-family:"SF Mono",Menlo,monospace;font-size:12.5px;letter-spacing:-0.01em }
.ctx-row-bits { color:var(--text-secondary);flex:1;min-width:0;font-size:12.5px }
.ctx-sep { color:var(--text-muted);margin:0 2px;opacity:0.6 }`;

  return reportShell({
    dim: 'eval',
    icon: '🧪',
    kindTitle: lang === 'zh' ? '用例评测报告' : 'Eval Report',
    // 头部用规范 skill 名(skill-index entry),与 doctor/observe 一致;无 context 时回退到 report 推导名。
    skillName: skillContext?.skillName ?? heroSkillName,
    metaItems: [`${icon('clock', { size: 13 })} ${e(heroTs)}`, `${icon('chip', { size: 13 })} ${e(m.model)}`, e(report.id)],
    // Hero 展示「综合健康」总分(跨 doctor/eval/observe,与首页同口径),切 tab 不变;
    // 本次 eval 的综合分(4.09/5)在下方结论卡。无 skillContext(batch/孤儿报告)时回退显 eval 综合分。
    score: skillContext ? skillContext.overall.score : heroScore100,
    scoreText: skillContext
      ? (skillContext.overall.score != null ? String(skillContext.overall.score) : undefined)
      : (heroComposite != null ? heroComposite.toFixed(2) : undefined),
    ringColor: skillContext
      ? healthColor(skillContext.overall.score)
      : (heroComposite != null ? (heroComposite >= 4 ? '#1f9d63' : heroComposite >= 3 ? '#d97706' : '#dc2626') : undefined),
    scoreLabel: skillContext ? (lang === 'zh' ? '综合健康' : 'Health') : (lang === 'zh' ? '综合分 / 5' : 'Composite / 5'),
    backHref: `/${langQ}`,
    backLabel: lang === 'zh' ? '返回列表' : 'Back to list',
    body,
    skillContext,
    extraCss: evalCss,
  }, lang);
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
      <span class="meta-tag">${t('executor', lang)}: ${e(m.executor || 'unknown')}</span>
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

export function renderReportDocumentDetail(report: ReportDocument | null, lang: Lang = DEFAULT_LANG, skillContext?: SkillReportContext): string {
  if (!report) return renderRunDetail(null, lang);
  return report.kind === 'batch-evaluation'
    ? renderBatchEvaluationDetail(report, lang)
    : renderRunDetail(report, lang, skillContext);
}

export function renderTrendsPage(variantName: string, runs: Report[], lang: Lang = DEFAULT_LANG): string {
  const body = renderTrendsBody(variantName, runs, lang);
  return layout(`${variantName} — ${lang === 'zh' ? '趋势' : 'Trends'}`, `<main>${body}</main>`, lang);
}
