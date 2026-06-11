/**
 * 受管 skill 的「决策史」渲染（Studio /managed 列表 + /managed/<name> 详情时间线）。
 *
 * 纯函数、无 IO：吃已构造好的数据（list 吃 ManagedListRow[]、history 吃 ManagedArtifactRecord），
 * 便于 snapshot 测试。把 install / 每次 eval 证据 / 每次 promote·reject·rollback 决定合并成一条按时间
 * 倒序的事件流，按内容版本（contentHash）分段，让「这个 skill 的一生」一眼可读——#203 管理支柱的可视化出口。
 *
 * 本切片只用受管记录自带数据（不读 report 文件）：evidence 上有 denormalize 的 verdict / 样本数 / 可比性，
 * 够画事件时间线。带数字 Δ/95%CI 的版本回归曲线（要读 report 文件）是 Slice 2。
 */
import { layout, e, fmtLocalTime } from './layout.js';
import { levelLabel } from './summary.js';
import type { Lang } from '../types/index.js';
import type { ManagedArtifactRecord } from '../types/index.js';
import type { ManagedListRow } from '../managed/index.js';
import type { VerdictLevel } from '../eval-core/verdict.js';

const VERDICT_LEVELS: readonly string[] = ['PROGRESS', 'CAUTIOUS', 'REGRESS', 'NOISE', 'UNDERPOWERED', 'SOLO'];
const isVerdictLevel = (v: string): v is VerdictLevel => VERDICT_LEVELS.includes(v);

const shortHash = (h: string): string => h.slice(0, 12);
const L = (lang: Lang) => (zh: string, en: string): string => (lang === 'zh' ? zh : en);

/** ISO 时刻解析（两端可解析按真实时刻、否则退字典序），与 latestCurrentEvidence 同口径。 */
function cmpDesc(a: string, b: string): number {
  const pa = Date.parse(a);
  const pb = Date.parse(b);
  if (!Number.isNaN(pa) && !Number.isNaN(pb)) return pb - pa;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** verdict 徽标：已知 VerdictLevel 走本地化标签 + 配色（复用 layout.ts 的 .verdict-<LEVEL> 全局样式）；
 *  未知字符串降级为纯文本徽标，绝不假装是某个 level。 */
function verdictBadge(verdict: string | undefined, lang: Lang): string {
  if (!verdict) return '';
  if (isVerdictLevel(verdict)) {
    return `<span class="verdict-${verdict}"><span class="page-verdict-badge"><span class="page-verdict-badge-dot">●</span>${e(levelLabel(verdict, lang))}</span></span>`;
  }
  return `<span class="mh-badge-raw">${e(verdict)}</span>`;
}

interface TimelineEvent {
  at: string;
  type: 'install' | 'eval' | 'promote' | 'reject' | 'rollback';
  contentHash?: string;
  verdict?: string;
  reportId?: string;
  actor?: string;
  reason?: string;
  override?: { verdict: string; overriddenBlocks?: string[] };
  sampleCount?: number;
  cliVersion?: string;
}

function buildTimeline(record: ManagedArtifactRecord): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  // install 不带 contentHash：record.contentHash 是「当前基线」（evolve 会 re-baseline），不是安装时那份；
  // 拿它标安装事件会误导，故安装只作时间起点，版本分段只用 evidence / decision 自带的 contentHash。
  events.push({ at: record.installedAt, type: 'install' });
  for (const ev of record.evidence) {
    events.push({
      at: ev.recordedAt, type: 'eval', contentHash: ev.contentHash, verdict: ev.verdict,
      reportId: ev.reportId, sampleCount: ev.sampleCoverage?.count, cliVersion: ev.comparability?.cliVersion,
    });
  }
  for (const d of record.decisions) {
    events.push({
      at: d.decidedAt, type: d.decisionKind, contentHash: d.contentHash,
      reportId: d.reportId, actor: d.actor, reason: d.reason, override: d.override,
    });
  }
  return events.sort((a, b) => cmpDesc(a.at, b.at));
}

function reportLink(reportId: string | undefined, lang: Lang): string {
  if (!reportId) return '';
  return `<a class="mh-link" href="/reports/${encodeURIComponent(reportId)}">${L(lang)('查看报告', 'report')} →</a>`;
}

function eventRow(ev: TimelineEvent, lang: Lang): string {
  const t = L(lang);
  const typeLabel: Record<TimelineEvent['type'], string> = {
    install: t('安装纳管', 'Installed'),
    eval: t('评测', 'Eval'),
    promote: t('采用', 'Promote'),
    reject: t('否决', 'Reject'),
    rollback: t('回滚', 'Rollback'),
  };
  const head: string[] = [`<span class="mh-type">${e(typeLabel[ev.type])}</span>`];
  if (ev.type === 'eval') head.push(verdictBadge(ev.verdict, lang));
  if (ev.override) {
    const blocks = ev.override.overriddenBlocks?.length ? `：${e(ev.override.overriddenBlocks.join(' / '))}` : '';
    head.push(`<span class="mh-override">${t('越门 override', 'override')}${blocks}</span>`);
  }

  const detail: string[] = [];
  if (ev.actor) detail.push(`<span class="mh-detail-item">${t('决定人', 'by')} ${e(ev.actor)}</span>`);
  if (ev.type === 'eval' && typeof ev.sampleCount === 'number') {
    detail.push(`<span class="mh-detail-item">${ev.sampleCount} ${t('用例', 'samples')}</span>`);
  }
  if (ev.cliVersion) detail.push(`<span class="mh-detail-item">omk ${e(ev.cliVersion)}</span>`);
  if (ev.reportId) detail.push(reportLink(ev.reportId, lang));
  if (ev.reason) detail.push(`<span class="mh-reason">「${e(ev.reason)}」</span>`);

  return `<li class="mh-event mh-event--${ev.type}">
    <span class="mh-time">${e(fmtLocalTime(ev.at))}</span>
    <span class="mh-marker"><span class="mh-dot mh-dot--${ev.type}"></span></span>
    <div class="mh-body">
      <div class="mh-head">${head.join(' ')}</div>
      ${detail.length ? `<div class="mh-detail">${detail.join('')}</div>` : ''}
    </div>
  </li>`;
}

function versionHeader(hash: string, isCurrent: boolean, lang: Lang): string {
  const cur = isCurrent ? `<span class="mh-vcur">${L(lang)('当前', 'current')}</span>` : '';
  return `<li class="mh-vhead"><span class="mh-vhead-label">${L(lang)('版本', 'version')}</span><code class="mh-hash">${e(shortHash(hash))}</code>${cur}</li>`;
}

export function renderManagedHistory(record: ManagedArtifactRecord, lang: Lang): string {
  const t = L(lang);
  const events = buildTimeline(record);

  // 倒序遍历：内容版本（contentHash）变化处插版本段头；install 等无 hash 事件不重置分段。
  const rows: string[] = [];
  let prevHash: string | undefined;
  for (const ev of events) {
    if (ev.contentHash && ev.contentHash !== prevHash) {
      rows.push(versionHeader(ev.contentHash, ev.contentHash === record.contentHash, lang));
      prevHash = ev.contentHash;
    }
    rows.push(eventRow(ev, lang));
  }

  const meta = [
    record.kind,
    record.source.sourceKind,
    shortHash(record.contentHash),
    `${t('纳管于', 'since')} ${fmtLocalTime(record.installedAt)}`,
  ].map((m) => `<span>${e(m)}</span>`).join('');

  const body = `<main class="mh-main">
    <nav class="mh-back"><a href="/managed">← ${t('受管列表', 'Managed')}</a></nav>
    <header class="mh-hero">
      <div class="mh-kind">${t('受管决策史', 'Managed history')}</div>
      <h1 class="mh-name">${e(record.name)}</h1>
      <div class="mh-meta">${meta}</div>
    </header>
    <ol class="mh-timeline">${rows.join('')}</ol>
  </main>
  <style>${MANAGED_CSS}</style>`;

  return layout(`${t('受管决策史', 'Managed history')} · ${record.name}`, body, lang);
}

function stateBand(state: string): string {
  return state === 'promoted' ? 'green' : state === 'stale' ? 'red' : state === 'measurable' ? 'accent' : 'muted';
}

function listRow(row: ManagedListRow, lang: Lang): string {
  const t = L(lang);
  const mark = !row.reachable ? ' <span class="mh-mark mh-mark--q" title="' + t('源未核', 'unverified') + '">?</span>'
    : row.state === 'stale' ? ' <span class="mh-mark mh-mark--warn">⚠️</span>' : '';
  return `<a class="mh-row" href="/managed/${encodeURIComponent(row.name)}">
    <span class="mh-row-state"><span class="mh-dot mh-dot--${stateBand(row.state)}"></span>${e(row.state)}${mark}</span>
    <span class="mh-row-name">${e(row.name)}</span>
    <span class="mh-row-kind">${e(row.kind)}</span>
    <span class="mh-row-verdict">${row.latestVerdict ? verdictBadge(row.latestVerdict, lang) : '—'}</span>
    <span class="mh-row-ev">${row.currentEvidenceCount}/${row.totalEvidenceCount}</span>
    <span class="mh-row-src" title="${e(row.sourceLabel)}">${e(row.sourceLabel)}</span>
  </a>`;
}

export function renderManagedList(rows: ManagedListRow[], lang: Lang): string {
  const t = L(lang);
  const head = `<div class="mh-row mh-row--head">
    <span>${t('状态', 'state')}</span><span>${t('名称', 'name')}</span><span>${t('类型', 'kind')}</span>
    <span>verdict</span><span>${t('证据', 'evidence')}</span><span>${t('源', 'source')}</span>
  </div>`;
  const list = rows.length === 0
    ? `<div class="mh-empty">${t('暂无受管 skill，运行 ', 'No managed skills yet — run ')}<code>omk install &lt;skill&gt;</code>${t(' 开始纳管。', ' to start.')}</div>`
    : head + rows.map((r) => listRow(r, lang)).join('');

  const body = `<main class="mh-main">
    <header class="mh-hero">
      <div class="mh-kind">${t('受管 skill', 'Managed skills')}</div>
      <h1 class="mh-name">${t('决策史', 'Decision history')}</h1>
      <div class="mh-meta"><span>${t('每个 skill 的 install → 评测 → 采用 / 回滚 全过程', 'install → eval → promote / rollback per skill')}</span></div>
    </header>
    <div class="mh-table">${list}</div>
  </main>
  <style>${MANAGED_CSS}</style>`;

  return layout(t('受管 skill', 'Managed skills'), body, lang);
}

const MANAGED_CSS = `
.mh-main{max-width:920px;margin:0 auto;padding:24px 20px 48px}
.mh-back{margin-bottom:14px;font-size:13px}
.mh-back a{color:var(--text-secondary);text-decoration:none}
.mh-back a:hover{color:var(--accent)}
.mh-hero{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);padding:20px 24px;margin-bottom:18px}
.mh-kind{font-size:13px;font-weight:600;color:var(--text-secondary)}
.mh-name{margin:4px 0 0;font-size:20px;font-weight:700;color:var(--text-primary);letter-spacing:-.2px}
.mh-meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;color:var(--text-muted);font-size:12px}
.mh-meta span{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}

/* ── 时间线 ── */
.mh-timeline{list-style:none;padding:0;margin:0;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);overflow:hidden}
.mh-vhead{display:flex;align-items:center;gap:8px;padding:10px 20px;background:var(--bg-elevated);border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary)}
.mh-vhead:first-child{border-top:none}
.mh-vhead-label{font-weight:600}
.mh-vcur{font-size:11px;font-weight:600;color:var(--green);background:var(--green-bg);padding:1px 7px;border-radius:9px}
.mh-event{display:flex;align-items:flex-start;gap:12px;padding:13px 20px;border-top:1px solid var(--border)}
.mh-time{flex-shrink:0;width:128px;color:var(--text-muted);font-size:12px;font-variant-numeric:tabular-nums;padding-top:1px}
.mh-marker{flex-shrink:0;padding-top:4px}
.mh-dot{display:inline-block;width:8px;height:8px;border-radius:50%}
.mh-dot--install{background:var(--text-muted)}
.mh-dot--eval{background:var(--accent)}
.mh-dot--promote{background:var(--green)}
.mh-dot--rollback{background:var(--yellow)}
.mh-dot--reject{background:var(--red)}
.mh-dot--green{background:var(--green)}.mh-dot--accent{background:var(--accent)}.mh-dot--muted{background:var(--text-muted)}.mh-dot--red{background:var(--red)}
.mh-body{flex:1;min-width:0}
.mh-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:14px}
.mh-type{font-weight:600;color:var(--text-primary)}
.mh-override{font-size:11px;font-weight:600;color:var(--yellow);background:var(--yellow-bg);padding:1px 8px;border-radius:9px}
.mh-badge-raw{font-size:11.5px;color:var(--text-secondary);background:var(--bg-soft);padding:1px 8px;border-radius:9px}
.mh-detail{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px;font-size:12px;color:var(--text-muted)}
.mh-reason{color:var(--text-secondary);font-style:italic}
.mh-link{color:var(--accent);text-decoration:none}
.mh-link:hover{text-decoration:underline}

/* ── 列表 ── */
.mh-table{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);overflow:hidden}
.mh-row{display:grid;grid-template-columns:130px 1.4fr .8fr 1.1fr .7fr 1.6fr;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid var(--border);text-decoration:none;color:var(--text-primary);font-size:13px}
.mh-row:hover{background:var(--bg-soft)}
.mh-row--head{border-top:none;color:var(--text-secondary);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;cursor:default}
.mh-row--head:hover{background:transparent}
.mh-row-state{display:inline-flex;align-items:center;gap:6px}
.mh-row-name{font-family:"SF Mono",Menlo,monospace;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mh-row-kind,.mh-row-src{color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mh-row-ev{font-variant-numeric:tabular-nums;color:var(--text-secondary)}
.mh-mark--warn{font-size:11px}
.mh-mark--q{color:var(--text-muted);font-weight:700}
.mh-empty{padding:40px 20px;text-align:center;color:var(--text-muted);font-size:13px}
.mh-empty code{background:var(--bg-soft);padding:1px 6px;border-radius:5px}
`;
