/**
 * Skill 列表页 — 卡片式,关键信号(健康等级 / 参考分 / 待优化数 / 趋势)显性化。
 *
 *   ┌─ skill-name ─────────────────────────────────  ⚠ N 待优化 · ↗ 趋势 ─┐
 *   │ ┌─────┐  健康摘要一句话                                              │
 *   │ │ 🟡  │  🩺 7/8 通过 · 🧪 5 用例 80% 4.2/5 · 👁 30 段 95% 稳定         │
 *   │ │ 良好 │                                                              │
 *   │ │ 85  │                                                              │
 *   │ └─────┘                                                              │
 *   └────────────────────────────────────────────────────────────────────┘
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import { assessHealth } from './skill-detail-renderer.js';
import type { Lang, SkillIndex, SkillIndexEntry, Insight } from '../types/index.js';

function relTime(ts: string | null | undefined, lang: Lang): string {
  if (!ts) return lang === 'zh' ? '未跑' : 'never';
  try {
    const past = new Date(ts).getTime();
    const diff = Math.max(0, Date.now() - past);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return lang === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
    return lang === 'zh' ? `${Math.floor(hours / 24)} 天前` : `${Math.floor(hours / 24)}d ago`;
  } catch { return ''; }
}

interface CardSummary {
  warnCount: number;
  highWarn: number;
  trendDir: 'up' | 'down' | 'flat' | 'none';
  trendDelta: string;
}

function summarizeCard(entry: SkillIndexEntry, insights: Insight[]): CardSummary {
  // 待优化数 = detectInsights 数(跟详情页用同一份输入,避免列表/详情口径不一致)。
  const warnCount = insights.length;
  const highWarn = insights.filter((i) => i.severity === 'high').length;

  // 趋势:用 eval 综合分历史第一份 vs 最后一份比较;无 history 用 doctor pass-rate fallback。
  let trendDir: CardSummary['trendDir'] = 'none';
  let trendDelta = '';
  if (entry.evalHistory.length >= 2) {
    const first = entry.evalHistory[0].compositeScore;
    const last = entry.evalHistory[entry.evalHistory.length - 1].compositeScore;
    if (first != null && last != null) {
      const d = last - first;
      trendDir = d > 0.1 ? 'up' : d < -0.1 ? 'down' : 'flat';
      trendDelta = (d > 0 ? '+' : '') + d.toFixed(2);
    }
  } else if (entry.doctorHistory.length >= 2) {
    const totalOf = (h: typeof entry.doctorHistory[0]): number => h.passCount + h.warnCount + h.failCount;
    const passPctOf = (h: typeof entry.doctorHistory[0]): number => totalOf(h) > 0 ? (h.passCount / totalOf(h)) * 100 : 0;
    const first = passPctOf(entry.doctorHistory[0]);
    const last = passPctOf(entry.doctorHistory[entry.doctorHistory.length - 1]);
    const d = last - first;
    trendDir = d > 5 ? 'up' : d < -5 ? 'down' : 'flat';
    trendDelta = (d > 0 ? '+' : '') + d.toFixed(0) + '%';
  }
  return { warnCount, highWarn, trendDir, trendDelta };
}

function renderHealthSummary(entry: SkillIndexEntry, insights: Insight[], lang: Lang): string {
  const parts: string[] = [];
  if (entry.doctor) {
    if (entry.doctor.failCount > 0) parts.push(lang === 'zh' ? `doctor ${entry.doctor.failCount} 项不通过` : `doctor ${entry.doctor.failCount} fail`);
    else if (entry.doctor.warnCount > 0) parts.push(lang === 'zh' ? `doctor ${entry.doctor.warnCount} 项告警` : `doctor ${entry.doctor.warnCount} warn`);
    else parts.push(lang === 'zh' ? 'doctor 全通过' : 'doctor all pass');
  }
  if (entry.eval) {
    const t = entry.eval.passCount + entry.eval.failCount;
    if (t > 0) {
      const pct = Math.round((entry.eval.passCount / t) * 100);
      parts.push(lang === 'zh' ? `eval 通过率 ${pct}%` : `eval ${pct}% pass`);
    }
  }
  if (entry.observe) {
    const labels: Record<string, string> = lang === 'zh'
      ? { green: '稳定', yellow: '波动', red: '不稳' }
      : { green: 'stable', yellow: 'flaky', red: 'unstable' };
    parts.push(lang === 'zh' ? `observe ${labels[entry.observe.healthBand]}` : `observe ${labels[entry.observe.healthBand]}`);
  }
  if (parts.length === 0) {
    // Diagnosis-only skill(例如只跑了 observe ingest 拿到 skill_md_not_found):没有三大
    // snapshot 但有待优化项。显示「检出 N 个待优化」比「尚未运行任何检查」准确,
    // 否则会跟 warn badge 的「N 待优化」对不上、用户看到矛盾态。
    if (insights.length > 0) {
      return lang === 'zh' ? `检出 ${insights.length} 个待优化项` : `${insights.length} insight(s) detected`;
    }
    return lang === 'zh' ? '尚未运行任何检查' : 'No checks run yet';
  }
  return parts.join(lang === 'zh' ? '，' : ', ');
}

function renderMetrics(entry: SkillIndexEntry, lang: Lang): string {
  const items: string[] = [];
  if (entry.doctor) {
    const total = entry.doctor.passCount + entry.doctor.warnCount + entry.doctor.failCount;
    items.push(`<span class="sl-metric">🩺 ${entry.doctor.passCount}/${total} ${lang === 'zh' ? '通过' : 'pass'}</span>`);
  }
  if (entry.eval) {
    const total = entry.eval.passCount + entry.eval.failCount;
    const pct = total > 0 ? Math.round((entry.eval.passCount / total) * 100) : 0;
    const score = entry.eval.compositeScore != null ? entry.eval.compositeScore.toFixed(2) : '—';
    items.push(`<span class="sl-metric">🧪 ${entry.eval.totalSamples} ${lang === 'zh' ? '用例' : 'samples'} · ${pct}% · ${score}/5</span>`);
  }
  if (entry.observe) {
    const stab = ((1 - entry.observe.gapRate) * 100).toFixed(0);
    items.push(`<span class="sl-metric">👁 ${entry.observe.segmentCount} ${lang === 'zh' ? '段' : 'segs'} · ${stab}% ${lang === 'zh' ? '稳定' : 'stable'}</span>`);
  }
  return items.join('');
}

function renderTrendBadge(t: CardSummary, lang: Lang): string {
  if (t.trendDir === 'none') return '';
  const arrow = t.trendDir === 'up' ? '↗' : t.trendDir === 'down' ? '↘' : '→';
  const cls = t.trendDir === 'up' ? 'up' : t.trendDir === 'down' ? 'down' : 'flat';
  const label = lang === 'zh'
    ? (t.trendDir === 'up' ? '上升' : t.trendDir === 'down' ? '下降' : '持平')
    : (t.trendDir === 'up' ? 'up' : t.trendDir === 'down' ? 'down' : 'flat');
  return `<span class="sl-trend sl-trend--${cls}" title="${lang === 'zh' ? '基于历史评测综合分变化' : 'Based on historical eval composite delta'}">${arrow} ${label}${t.trendDelta ? ` (${e(t.trendDelta)})` : ''}</span>`;
}

function renderCard(entry: SkillIndexEntry, insights: Insight[], langQ: string, lang: Lang): string {
  const h = assessHealth(entry, insights, lang);
  const summary = summarizeCard(entry, insights);
  const lastTs = [entry.doctor?.timestamp, entry.eval?.timestamp, entry.observe?.generatedAt]
    .filter((s): s is string => Boolean(s)).sort().pop();
  const detailHref = `/skills/${encodeURIComponent(entry.skillName)}${langQ}`;

  const warnBadge = summary.warnCount > 0
    ? `<span class="sl-warn-badge sl-warn-badge--${summary.highWarn > 0 ? 'high' : 'med'}">${summary.highWarn > 0 ? '🔴' : '⚠'} ${summary.warnCount} ${lang === 'zh' ? '待优化' : 'todo'}</span>`
    : `<span class="sl-warn-badge sl-warn-badge--ok">✓ ${lang === 'zh' ? '无待优化' : 'no todo'}</span>`;

  return `<a class="sl-card sl-card--${h.color}" data-color="${h.color}" href="${e(detailHref)}">
    <div class="sl-card-h">
      <span class="sl-card-emoji">${h.emoji}</span>
      <span class="sl-card-name">${e(entry.skillName)}</span>
      <span class="sl-card-time">${relTime(lastTs, lang)}</span>
    </div>
    <div class="sl-card-grade">
      <span class="sl-card-label">${e(h.label)}</span>
      ${h.score != null
        ? `<span class="sl-card-score">${h.score}<span class="sl-card-score-unit">/100</span></span>`
        : `<span class="sl-card-score sl-card-score--empty">—</span>`}
      ${warnBadge}
      ${renderTrendBadge(summary, lang)}
    </div>
    <div class="sl-card-summary">${renderHealthSummary(entry, insights, lang)}</div>
    <div class="sl-card-metrics">${renderMetrics(entry, lang)}</div>
  </a>`;
}

function renderSummaryBar(idx: SkillIndex, allEntries: SkillIndexEntry[], insightsByEntry: Map<string, Insight[]>, lang: Lang): string {
  const s = idx.summary;
  if (s.totalSkills === 0) return '';

  // grade 重新统计(用 assessHealth 而不是 entry.band,跟卡片显示一致)
  const gradeCounts = { excellent: 0, good: 0, fair: 0, unhealthy: 0, unscored: 0 };
  for (const ent of allEntries) {
    const ins = insightsByEntry.get(ent.skillName) ?? [];
    const h = assessHealth(ent, ins, lang);
    gradeCounts[h.grade]++;
  }
  const totalSamples = allEntries.reduce((sum, ent) => sum + (ent.eval?.totalSamples ?? 0), 0);
  const totalWarn = allEntries.reduce((sum, ent) => sum + (insightsByEntry.get(ent.skillName)?.length ?? 0), 0);
  const totalHighWarn = allEntries.reduce((sum, ent) => sum + (insightsByEntry.get(ent.skillName)?.filter((i) => i.severity === 'high').length ?? 0), 0);
  const lastTs = allEntries.flatMap((ent) => [ent.doctor?.timestamp, ent.eval?.timestamp, ent.observe?.generatedAt])
    .filter((x): x is string => Boolean(x)).sort().pop();

  const overview = lang === 'zh'
    ? `${s.totalSkills} skill · ${lang === 'zh' ? '共' : 'across'} ${totalSamples} ${lang === 'zh' ? '用例' : 'samples'}${lastTs ? ` · ${lang === 'zh' ? '最近' : 'last'} ${relTime(lastTs, lang)}` : ''}${totalWarn > 0 ? ` · ⚠ ${totalWarn} ${lang === 'zh' ? '待优化' : 'todo'}${totalHighWarn > 0 ? `(${totalHighWarn} ${lang === 'zh' ? '高优' : 'high'})` : ''}` : ''}`
    : `${s.totalSkills} skills · ${totalSamples} samples${lastTs ? ` · last ${relTime(lastTs, lang)}` : ''}${totalWarn > 0 ? ` · ⚠ ${totalWarn} todo${totalHighWarn > 0 ? ` (${totalHighWarn} high)` : ''}` : ''}`;

  const greenCount = gradeCounts.good + gradeCounts.excellent;
  const healthyCount = greenCount + gradeCounts.fair;
  const healthRate = s.totalSkills > 0 ? Math.round((healthyCount / s.totalSkills) * 100) : 0;
  const healthRateText = lang === 'zh'
    ? `健康率 ${healthyCount}/${s.totalSkills} (${healthRate}%)`
    : `Health ${healthyCount}/${s.totalSkills} (${healthRate}%)`;

  const gradeRow = `
    <button class="sl-filter-pill sl-filter-pill--all sl-filter-pill--active" data-filter="all">${lang === 'zh' ? '全部' : 'All'} ${s.totalSkills}</button>
    <button class="sl-filter-pill sl-filter-pill--red" data-filter="red">🔴 ${gradeCounts.unhealthy}</button>
    <button class="sl-filter-pill sl-filter-pill--yellow" data-filter="yellow">🟡 ${gradeCounts.fair}</button>
    <button class="sl-filter-pill sl-filter-pill--green" data-filter="green">🟢 ${greenCount}</button>
    <button class="sl-filter-pill sl-filter-pill--gray" data-filter="gray">⚪ ${gradeCounts.unscored}</button>
    <span class="sl-health-rate">${healthRateText}</span>
  `;
  return `<div class="sl-summary-card">
    <div class="sl-summary-line">${overview}</div>
    <div class="sl-summary-pills">${gradeRow}</div>
  </div>`;
}

function renderNextSteps(idx: SkillIndex, allEntries: SkillIndexEntry[], insightsByEntry: Map<string, Insight[]>, lang: Lang): string {
  const items: string[] = [];
  const unhealthy = allEntries.filter((ent) => assessHealth(ent, insightsByEntry.get(ent.skillName) ?? [], lang).grade === 'unhealthy').length;
  if (unhealthy > 0) {
    items.push(lang === 'zh'
      ? `🔴 ${unhealthy} 个 skill 不健康 — 点开"不健康"卡片看待优化项,优先 high`
      : `🔴 ${unhealthy} skill(s) unhealthy — open the cards to see issues (high first)`);
  }
  const noObserve = idx.summary.totalSkills - idx.summary.withObserve;
  if (noObserve > 0 && idx.summary.totalSkills >= 3) {
    items.push(lang === 'zh'
      ? `👀 ${noObserve} 个 skill 没跑过 observe — 跑 omk observe 接生产数据`
      : `👀 ${noObserve} skills missing observe — run omk observe`);
  }
  if (idx.summary.gray > 0) {
    items.push(lang === 'zh'
      ? `⚪ ${idx.summary.gray} 个 skill 完全没报告 — 先跑 omk doctor / omk eval`
      : `⚪ ${idx.summary.gray} skills with no reports — run omk doctor / omk eval first`);
  }
  if (items.length === 0) return '';
  return `<div class="sl-next-steps">
    <div class="sl-next-steps-title">${lang === 'zh' ? '下一步建议' : 'Next steps'}</div>
    <ul>${items.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
  </div>`;
}

const SKILL_LIST_CSS = `
/* 顶部汇总卡 */
.sl-summary-card { background:var(--bg-surface);border-radius:8px;padding:14px 18px;box-shadow:var(--shadow-sm);margin:8px 0 18px;display:flex;flex-direction:column;gap:10px }
.sl-summary-line { font-size:13.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums;line-height:1.55 }
.sl-summary-pills { display:flex;gap:8px;flex-wrap:wrap;align-items:center }
.sl-filter-pill { display:inline-flex;align-items:center;gap:4px;padding:5px 12px;border-radius:14px;font-size:12px;font-weight:600;border:1.5px solid transparent;cursor:pointer;transition:all .15s;background:var(--bg-soft);color:var(--text-secondary) }
.sl-filter-pill:hover { opacity:.85 }
.sl-filter-pill--active { border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) }
.sl-filter-pill--red { background:rgba(156,74,63,.10);color:#9c4a3f }
.sl-filter-pill--yellow { background:rgba(176,128,48,.10);color:#b08030 }
.sl-filter-pill--green { background:rgba(94,130,82,.10);color:#5e8252 }
.sl-filter-pill--gray { background:var(--bg-soft);color:var(--text-muted) }
.sl-filter-pill--all { background:var(--bg-soft);color:var(--text-primary) }
.sl-health-rate { font-size:13px;font-weight:600;color:var(--text-secondary);margin-left:8px;padding:4px 10px;background:var(--bg-soft);border-radius:6px }
.sl-card--hidden { display:none !important }

/* 卡片列表 — 网格布局 */
.sl-cards { display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px }

.sl-card { display:flex;flex-direction:column;gap:10px;padding:16px 18px;background:var(--bg-surface);border-radius:10px;box-shadow:var(--shadow-sm);text-decoration:none;color:var(--text-primary);transition:transform .12s,box-shadow .12s,border-color .12s;border-left:4px solid var(--border) }
.sl-card:hover { transform:translateY(-1px);box-shadow:var(--shadow-md);text-decoration:none }
.sl-card:focus-visible { outline:2px solid var(--accent);outline-offset:2px }
.sl-card--green  { border-left-color:#5e8252 }
.sl-card--yellow { border-left-color:#b08030 }
.sl-card--red    { border-left-color:#9c4a3f }
.sl-card--gray   { border-left-color:var(--border) }

/* 顶:健康等级色卡 */
.sl-card-grade { display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:7px;background:var(--bg-soft) }
.sl-card--green  .sl-card-grade { background:rgba(94,130,82,.08) }
.sl-card--yellow .sl-card-grade { background:rgba(176,128,48,.08) }
.sl-card--red    .sl-card-grade { background:rgba(156,74,63,.08) }
.sl-card-emoji { font-size:18px;line-height:1 }
.sl-card-label { font-size:12px;font-weight:600;color:var(--text-primary);letter-spacing:0.02em;margin-top:2px }
.sl-card-score { font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1;margin-top:2px;display:flex;align-items:baseline;gap:1px }
.sl-card--green  .sl-card-score { color:#5e8252 }
.sl-card--yellow .sl-card-score { color:#b08030 }
.sl-card--red    .sl-card-score { color:#9c4a3f }
.sl-card--gray   .sl-card-score { color:var(--text-muted) }
.sl-card-score-unit { font-size:10px;color:var(--text-muted);font-weight:500 }
.sl-card-score--empty { font-size:16px;color:var(--text-muted);font-weight:500 }

/* 标题行 */
.sl-card-h { display:flex;align-items:center;gap:8px }
.sl-card-emoji { font-size:20px;line-height:1;flex-shrink:0 }
.sl-card-name { font-size:15px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1 }
.sl-card-time { font-size:11px;color:var(--text-muted);font-variant-numeric:tabular-nums;white-space:nowrap;flex-shrink:0 }
.sl-card-summary { font-size:13px;color:var(--text-secondary);line-height:1.5 }
.sl-card-metrics { display:flex;gap:8px;flex-wrap:wrap }
.sl-metric { font-size:11.5px;color:var(--text-secondary);font-variant-numeric:tabular-nums;background:var(--bg-soft);padding:3px 9px;border-radius:5px;line-height:1.5 }
.sl-warn-badge { display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:11px;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.4 }
.sl-warn-badge--high { background:rgba(156,74,63,.14);color:#9c4a3f }
.sl-warn-badge--med  { background:rgba(176,128,48,.14);color:#b08030 }
.sl-warn-badge--ok   { background:rgba(94,130,82,.14);color:#5e8252 }
.sl-trend { font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;padding:1px 7px;border-radius:8px;letter-spacing:0.01em }
.sl-trend--up   { background:rgba(94,130,82,.14);color:#5e8252 }
.sl-trend--down { background:rgba(156,74,63,.14);color:#9c4a3f }
.sl-trend--flat { background:var(--bg-soft);color:var(--text-muted) }
.sl-card-arrow { color:var(--text-muted);font-size:18px;font-weight:300;line-height:1;margin-top:2px }

/* Next steps */
.sl-next-steps { margin-top:24px;padding:14px 18px;background:var(--bg-soft);border-radius:6px }
.sl-next-steps-title { font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;letter-spacing:0.02em }
.sl-next-steps ul { margin:0;padding-left:18px;color:var(--text-secondary);font-size:13.5px;line-height:1.8 }
.sl-empty-state { text-align:center;padding:60px 20px;color:var(--text-muted) }
.sl-empty-state code { background:var(--bg-soft);padding:2px 6px;border-radius:3px;font-family:"SF Mono",Menlo,monospace;font-size:13px }
.sl-legacy-hint { margin-top:24px;text-align:center;font-size:11.5px;color:var(--text-muted) }
.sl-legacy-hint a { color:var(--accent) }

/* 响应式 */
@media(max-width:640px){
  .sl-cards { grid-template-columns:1fr }
  .sl-card-name { font-size:14px }
  .sl-metric { font-size:11px;padding:2px 7px }
}
`;

export function renderSkillList(
  idx: SkillIndex,
  lang: Lang = DEFAULT_LANG,
): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  // insightsBySkill 在 buildSkillIndex 里跟 SkillIndex 一起算好(共享缓存)。
  // list renderer 直接消费,不再每请求 N×detectInsights 重算。
  const insightsByEntry = idx.insightsBySkill;
  const body = idx.entries.length === 0
    ? `<div class="sl-empty-state">
        <p>${lang === 'zh' ? '暂无 skill 报告。先跑一次评测:' : 'No skill reports yet. Run an evaluation first:'}</p>
        <p><code>omk eval --treatment my-skill</code></p>
      </div>`
    : `<div class="sl-cards">${idx.entries.map((ent) => renderCard(ent, insightsByEntry.get(ent.skillName) ?? [], langQ, lang)).join('')}</div>`;

  const title = lang === 'zh' ? 'OMK Studio 工作台' : 'OMK Studio';
  const subtitle = lang === 'zh'
    ? '一站式查看每个 skill 的健康状况、待优化项和历史趋势'
    : 'One-stop view of every skill — health, issues, and historical trends';

  return layout(title, `
    <main>
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    ${renderSummaryBar(idx, idx.entries, insightsByEntry, lang)}
    ${body}
    ${renderNextSteps(idx, idx.entries, insightsByEntry, lang)}
    <div class="sl-legacy-hint">
      ${lang === 'zh' ? '找老的 run 列表?' : 'Looking for the old run list?'} <a href="/runs${langQ}">/runs</a>
    </div>
    </main>
    <style>${SKILL_LIST_CSS}</style>
    <script>
    (function(){
      var pills = document.querySelectorAll('.sl-filter-pill');
      pills.forEach(function(pill){
        pill.addEventListener('click', function(){
          pills.forEach(function(p){ p.classList.remove('sl-filter-pill--active'); });
          pill.classList.add('sl-filter-pill--active');
          var filter = pill.getAttribute('data-filter');
          var cards = document.querySelectorAll('.sl-card');
          cards.forEach(function(card){
            if (filter === 'all') { card.classList.remove('sl-card--hidden'); }
            else { card.classList.toggle('sl-card--hidden', card.getAttribute('data-color') !== filter); }
          });
        });
      });
    })();
    </script>
  `, lang);
}
