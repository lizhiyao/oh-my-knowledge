/**
 * Skill-centric 列表页 — studio 顶级实体从"报告"翻成"skill",每条 skill 一行,
 * 4 列对应 doctor / eval-评分 / eval-功能 / observe 四类报告各取最新一份的 status。
 *
 * v1 范围:列表页 + 行级跳转(eval 跳 /reports/<id>;observe 跳 /analyses/<id>;
 * doctor 暂占位"未运行")。详情页(单 skill 4 卡片)放后续 commit。
 *
 * 跟现有 score view / test view tab 不冲突 — 顶部加 view 切换器(skills / runs),
 * 默认 skills,旧用户可切回 runs。
 */
import { layout, e, DEFAULT_LANG } from './layout.js';
import type { Lang } from '../types/index.js';
import type { SkillIndex, SkillIndexEntry, SkillEvalSnapshot, SkillObserveSnapshot } from '../server/skill-index.js';

const BAND_DOT: Record<'green' | 'yellow' | 'red' | 'gray', string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
  gray: '⚪',
};

function relTime(ts: string | null | undefined, lang: Lang): string {
  if (!ts) return lang === 'zh' ? '未跑' : 'never';
  try {
    const past = new Date(ts).getTime();
    const now = Date.now();
    const diff = Math.max(0, now - past);
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return lang === 'zh' ? `${mins} 分钟前` : `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return lang === 'zh' ? `${hours}h 前` : `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return lang === 'zh' ? `${days}d 前` : `${days}d ago`;
  } catch {
    return '';
  }
}

function verdictPillCls(level: string): string {
  // 跟 verdict.ts 的 VerdictLevel 对齐:ship / ship_with_caveat / progress / regress / no_ship / neutral / undecided
  if (level === 'ship') return 'pass';
  if (level === 'ship_with_caveat' || level === 'progress') return 'pass-soft';
  if (level === 'regress' || level === 'no_ship') return 'fail';
  if (level === 'neutral') return 'warn';
  return 'gray';
}

function renderEvalCell(snap: SkillEvalSnapshot | null, langQ: string, lang: Lang): string {
  if (!snap) {
    return `<div class="sl-cell sl-cell-empty">${lang === 'zh' ? '⚪ 未跑' : '⚪ never'}</div>`;
  }
  const score = snap.compositeScore != null ? snap.compositeScore.toFixed(2) : '—';
  const verdictCls = verdictPillCls(snap.verdictLevel);
  const verdictText = snap.verdictLevel.replace(/_/g, ' ').toUpperCase();
  return `<a class="sl-cell" href="/reports/${e(snap.reportId)}${langQ}" title="${e(snap.verdictHeadline)}">
    <span class="sl-pill sl-pill--${verdictCls}">${e(verdictText)}</span>
    <span class="sl-cell-num">${score}</span>
    <span class="sl-cell-time">${e(relTime(snap.timestamp, lang))}</span>
  </a>`;
}

function renderEvalFuncCell(snap: SkillEvalSnapshot | null, langQ: string, lang: Lang): string {
  if (!snap) {
    return `<div class="sl-cell sl-cell-empty">${lang === 'zh' ? '⚪ 未跑' : '⚪ never'}</div>`;
  }
  const denom = snap.passCount + snap.failCount; // 诱错不计入 pass-rate 分母
  const passText = `${snap.passCount}/${denom || 0}`;
  const tripwireText = snap.tripwireCount > 0
    ? ` <span class="sl-cell-tag">+${snap.tripwireCount} ${lang === 'zh' ? '诱错' : 'tripwire'}</span>`
    : '';
  // 单测视角链接到 /reports/<id>?view=test 的 anchor;v1 直接跳报告页,默认评分视角,
  // 用户点 ✅ 单测 tab 即可。后续可加 #test 锚点路由。
  return `<a class="sl-cell" href="/reports/${e(snap.reportId)}${langQ}#test-view">
    <span class="sl-cell-pf">
      <span class="sl-cell-pass">${snap.passCount}</span>
      <span class="sl-cell-sep">/</span>
      <span class="sl-cell-fail">${snap.failCount}</span>
      ${tripwireText}
    </span>
    <span class="sl-cell-num">${passText}</span>
    <span class="sl-cell-time">${e(relTime(snap.timestamp, lang))}</span>
  </a>`;
}

function renderObserveCell(snap: SkillObserveSnapshot | null, langQ: string, lang: Lang): string {
  if (!snap) {
    return `<div class="sl-cell sl-cell-empty">${lang === 'zh' ? '⚪ 未跑' : '⚪ never'}</div>`;
  }
  const dot = BAND_DOT[snap.healthBand];
  const gapPct = Math.round(snap.gapRate * 100);
  return `<a class="sl-cell" href="/analyses/${e(snap.analysisId)}${langQ}">
    <span class="sl-pill sl-pill--${snap.healthBand}">${dot} ${snap.healthBand}</span>
    <span class="sl-cell-num">${gapPct}% gap</span>
    <span class="sl-cell-time">${e(relTime(snap.generatedAt, lang))}</span>
  </a>`;
}

function renderDoctorCell(_doctor: null, lang: Lang): string {
  return `<div class="sl-cell sl-cell-empty" title="${e(lang === 'zh' ? '独立 omk doctor 报告暂不持久化;omk eval 内部嵌入式跑了 doctor preflight。后续 commit 加默认输出路径。' : 'Standalone omk doctor reports are not yet persisted; omk eval runs doctor preflight inline. Future commit will add a default output path.')}">${lang === 'zh' ? '⚪ 未独立运行' : '⚪ not run'}</div>`;
}

function renderRow(entry: SkillIndexEntry, langQ: string, lang: Lang): string {
  const dot = BAND_DOT[entry.band];
  // 主链接:跳到第一个可用的报告(eval > observe);都没就 # 锚点(灰色)。
  const primaryHref = entry.eval
    ? `/reports/${entry.eval.reportId}${langQ}`
    : entry.observe
      ? `/analyses/${entry.observe.analysisId}${langQ}`
      : '#';
  return `<div class="sl-row sl-row--${entry.band}">
    <div class="sl-name">
      <span class="sl-dot">${dot}</span>
      <a class="sl-name-link" href="${e(primaryHref)}">${e(entry.skillName)}</a>
    </div>
    <div class="sl-col">${renderDoctorCell(entry.doctor, lang)}</div>
    <div class="sl-col">${renderEvalCell(entry.eval, langQ, lang)}</div>
    <div class="sl-col">${renderEvalFuncCell(entry.eval, langQ, lang)}</div>
    <div class="sl-col">${renderObserveCell(entry.observe, langQ, lang)}</div>
  </div>`;
}

function renderSummaryBar(idx: SkillIndex, lang: Lang): string {
  const s = idx.summary;
  if (s.totalSkills === 0) return '';
  const parts = [
    `${s.totalSkills} ${lang === 'zh' ? 'skill' : 'skills'}`,
    `${BAND_DOT.red} ${s.red}`,
    `${BAND_DOT.yellow} ${s.yellow}`,
    `${BAND_DOT.green} ${s.green}`,
    `${BAND_DOT.gray} ${s.gray} ${lang === 'zh' ? '未跑' : 'no data'}`,
  ];
  return `<div class="sl-summary">${parts.join('  ·  ')}</div>`;
}

function renderNextSteps(idx: SkillIndex, lang: Lang): string {
  const items: string[] = [];
  if (idx.summary.red > 0) {
    items.push(lang === 'zh'
      ? `🔴 ${idx.summary.red} 个 skill 健康度红 — 优先看功能视角找失败模式`
      : `🔴 ${idx.summary.red} skills in red — start with the functional view to spot failure modes`);
  }
  const noObserve = idx.summary.totalSkills - idx.summary.withObserve;
  if (noObserve > 0 && idx.summary.totalSkills >= 3) {
    items.push(lang === 'zh'
      ? `👀 ${noObserve} 个 skill 没跑过 observe — 跑 omk observe 看真实生产行为`
      : `👀 ${noObserve} skills missing observe — run omk observe to see production behavior`);
  }
  if (idx.summary.gray > 0) {
    items.push(lang === 'zh'
      ? `⚪ ${idx.summary.gray} 个 skill 完全没报告 — 先跑 omk doctor / omk eval`
      : `⚪ ${idx.summary.gray} skills with no reports — start with omk doctor / omk eval`);
  }
  if (items.length === 0) return '';
  return `<div class="sl-next-steps">
    <div class="sl-next-steps-title">${lang === 'zh' ? '下一步建议' : 'Next steps'}</div>
    <ul>${items.map((x) => `<li>${e(x)}</li>`).join('')}</ul>
  </div>`;
}

function renderViewTabs(active: 'skills' | 'runs', langQ: string, lang: Lang): string {
  return `<div class="sl-view-tabs">
    <a class="sl-view-tab ${active === 'skills' ? 'sl-view-tab--active' : ''}" href="/${langQ}">${lang === 'zh' ? '📚 Skills' : '📚 Skills'}</a>
    <a class="sl-view-tab ${active === 'runs' ? 'sl-view-tab--active' : ''}" href="/runs${langQ}">${lang === 'zh' ? '📋 Runs' : '📋 Runs'}</a>
  </div>`;
}

const SKILL_LIST_CSS = `
.sl-view-tabs { display:flex;gap:0;margin:8px 0 24px;border-bottom:1px solid var(--border) }
.sl-view-tab { padding:10px 18px;color:var(--text-secondary);text-decoration:none;border-bottom:2px solid transparent;font-weight:500;font-size:14px;margin-bottom:-1px }
.sl-view-tab:hover { color:var(--text-primary) }
.sl-view-tab--active { color:var(--text-primary);border-bottom-color:var(--accent);font-weight:600 }
.sl-summary { font-size:13px;color:var(--text-secondary);margin:0 0 12px;font-variant-numeric:tabular-nums }
.sl-table-h { display:grid;grid-template-columns:minmax(180px,2fr) repeat(4,1fr);gap:12px;padding:8px 14px;font-size:12px;color:var(--text-muted);font-weight:600;letter-spacing:0.04em;text-transform:uppercase;border-bottom:1px solid var(--border) }
.sl-row { display:grid;grid-template-columns:minmax(180px,2fr) repeat(4,1fr);gap:12px;padding:14px;border-radius:6px;align-items:center;transition:background .12s }
.sl-row:hover { background:var(--bg-soft) }
.sl-row--red { border-left:3px solid #9c4a3f;padding-left:11px }
.sl-row--yellow { border-left:3px solid #b08030;padding-left:11px }
.sl-row--green { border-left:3px solid #5e8252;padding-left:11px }
.sl-row--gray { border-left:3px solid var(--border);padding-left:11px }
.sl-name { display:flex;align-items:center;gap:10px;min-width:0 }
.sl-dot { font-size:14px;flex-shrink:0 }
.sl-name-link { color:var(--text-primary);text-decoration:none;font-weight:600;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0 }
.sl-name-link:hover { color:var(--accent);text-decoration:underline }
.sl-col { min-width:0 }
.sl-cell { display:flex;flex-direction:column;gap:2px;padding:6px 10px;border-radius:4px;text-decoration:none;color:var(--text-primary);font-size:12.5px;line-height:1.4;transition:background .1s }
.sl-cell:hover { background:var(--bg-soft) }
.sl-cell-empty { color:var(--text-muted);font-size:12px;padding:6px 10px;cursor:default }
.sl-pill { display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;letter-spacing:0.02em;width:fit-content }
.sl-pill--pass { background:rgba(94,130,82,.14);color:#5e8252 }
.sl-pill--pass-soft { background:rgba(94,130,82,.10);color:#7a9270 }
.sl-pill--warn { background:rgba(176,128,48,.12);color:#b08030 }
.sl-pill--fail { background:rgba(156,74,63,.14);color:#9c4a3f }
.sl-pill--gray { background:var(--bg-soft);color:var(--text-muted) }
.sl-pill--green { background:rgba(94,130,82,.14);color:#5e8252 }
.sl-pill--yellow { background:rgba(176,128,48,.12);color:#b08030 }
.sl-pill--red { background:rgba(156,74,63,.14);color:#9c4a3f }
.sl-cell-num { font-variant-numeric:tabular-nums;font-size:13px;color:var(--text-secondary) }
.sl-cell-time { font-size:11px;color:var(--text-muted) }
.sl-cell-pf { font-variant-numeric:tabular-nums;font-size:13px }
.sl-cell-pass { color:#5e8252;font-weight:600 }
.sl-cell-fail { color:#9c4a3f;font-weight:600 }
.sl-cell-sep { color:var(--text-muted);margin:0 2px }
.sl-cell-tag { font-size:10.5px;color:#7a6b89;background:rgba(122,107,137,.10);padding:1px 6px;border-radius:8px;margin-left:4px }
.sl-next-steps { margin-top:24px;padding:14px 18px;background:var(--bg-soft);border-radius:6px }
.sl-next-steps-title { font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:8px;letter-spacing:0.02em }
.sl-next-steps ul { margin:0;padding-left:18px;color:var(--text-secondary);font-size:13.5px;line-height:1.8 }
.sl-empty-state { text-align:center;padding:60px 20px;color:var(--text-muted) }
.sl-empty-state code { background:var(--bg-soft);padding:2px 6px;border-radius:3px;font-family:"SF Mono",Menlo,monospace;font-size:13px }
`;

export function renderSkillList(idx: SkillIndex, lang: Lang = DEFAULT_LANG): string {
  const langQ = lang === DEFAULT_LANG ? '' : `?lang=${lang}`;
  const headers = lang === 'zh'
    ? ['Skill', 'Doctor (静态体检)', 'Eval (评分视角)', 'Eval (功能视角)', 'Observe (线上观测)']
    : ['Skill', 'Doctor (static)', 'Eval (score view)', 'Eval (functional)', 'Observe (production)'];

  const body = idx.entries.length === 0
    ? `<div class="sl-empty-state">
        <p>${lang === 'zh' ? '暂无 skill 报告。先跑一次评测:' : 'No skill reports yet. Run an evaluation first:'}</p>
        <p><code>omk eval --treatment my-skill</code></p>
      </div>`
    : `<div class="sl-table-h">
        ${headers.map((h) => `<div>${e(h)}</div>`).join('')}
      </div>
      ${idx.entries.map((entry) => renderRow(entry, langQ, lang)).join('')}`;

  const title = lang === 'zh' ? '📚 Skills 概览' : '📚 Skills overview';
  const subtitle = lang === 'zh'
    ? '按 skill 聚合的多视角健康看板:静态体检 / 必要性评分 / 功能测试 / 线上观测'
    : 'Per-skill multi-view health board: static checks / necessity score / functional tests / production observation';

  return layout(title, `
    <main>
    <h1>${title}</h1>
    <p class="subtitle">${subtitle}</p>
    ${renderViewTabs('skills', langQ, lang)}
    ${renderSummaryBar(idx, lang)}
    ${body}
    ${renderNextSteps(idx, lang)}
    </main>
    <style>${SKILL_LIST_CSS}</style>
  `, lang);
}

/** 单独导出给 / 与 /runs 切换的 view tabs 渲染函数,让 run-list 也能挂上同一个 tabs 头。 */
export function renderRunListViewTabs(langQ: string, lang: Lang): string {
  return renderViewTabs('runs', langQ, lang);
}
