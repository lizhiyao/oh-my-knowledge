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
import type { ManagedArtifactRecord, ManagedLifecycleLabel } from '../types/index.js';
import type { ManagedListRow, VersionScorePoint } from '../managed/index.js';
import type { VerdictLevel } from '../eval-core/verdict.js';

// Record<VerdictLevel, true> 让 TS 编译期强制列全所有 level —— eval-core 新增 level 时这里报错、逼同步,
// 避免新 verdict 被静默当未知字符串降级渲染（无运行时 level 清单可 import,故用穷举 Record 做编译期闸门）。
const VERDICT_LEVELS: Record<VerdictLevel, true> = {
  PROGRESS: true, CAUTIOUS: true, REGRESS: true, NOISE: true, UNDERPOWERED: true, SOLO: true,
};
const isVerdictLevel = (v: string): v is VerdictLevel => Object.prototype.hasOwnProperty.call(VERDICT_LEVELS, v);

const shortHash = (h: string): string => h.slice(0, 12);
const L = (lang: Lang) => (zh: string, en: string): string => (lang === 'zh' ? zh : en);

// 盲区信号类型 → 人话标签。与 CLI observe 的 GAP_AREA_LABELS 同义但本地另存一份 —— renderer 绝不 import
// cli/commands(支柱分层),且两边走各自的 i18n 机制。键集随 ManagedObservation.gapByType 固定四类同步。
const GAP_AREA_LABELS: Record<string, { zh: string; en: string }> = {
  failed_search: { zh: '检索失败', en: 'failed search' },
  explicit_marker: { zh: '显式缺口', en: 'explicit gap' },
  hedging: { zh: '含糊回避', en: 'hedging' },
  repeated_failure: { zh: '反复失败', en: 'repeated failure' },
};
/** 盲区计数最高的前几类组成人话区域串(只展示信号所在,不生成用例)。全 0 → 空串(调用方据此略过)。
 *  只迭代**四个已知盲区类型**(GAP_AREA_LABELS 的键),记录里若被手改塞进额外键则一律忽略 —— 消费侧收口,
 *  比让 validator 因一个额外键丢整条记录更稳;额外键即便混入也进不了展示(再叠 e() 转义,无注入面)。 */
function topGapAreas(gapByType: Record<string, number>, lang: Lang): string {
  return Object.keys(GAP_AREA_LABELS)
    .map((k) => [k, gapByType[k] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k]) => GAP_AREA_LABELS[k][lang])
    .join(lang === 'zh' ? '、' : ', ');
}
/** 页内跳转统一带上 lang，否则点一下就掉回默认中文。zh 是默认 → 空串(不脏 URL)。 */
const langQuery = (lang: Lang): string => (lang === 'en' ? '?lang=en' : '');

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
  type: 'install' | 'eval' | 'promote' | 'reject' | 'rollback' | 'observe';
  contentHash?: string;
  verdict?: string;
  reportId?: string;
  /** Studio 的 Core 详情路由以 runId 为主键；旧审计证据才退回 reportId。 */
  reportLocatorId?: string;
  actor?: string;
  reason?: string;
  override?: { verdict: string; overriddenBlocks?: string[] };
  sampleCount?: number;
  cliVersion?: string;
  gitCommit?: string;
  // observe 观测(#235):版本无关的生产信号,无 contentHash → 不参与版本分段。
  healthBand?: 'green' | 'yellow' | 'red';
  confidence?: 'high' | 'low' | 'underpowered';
  gapByType?: { failed_search: number; explicit_marker: number; hedging: number; repeated_failure: number };
}

function buildTimeline(record: ManagedArtifactRecord): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const runIdByReportId = new Map(record.evidence.flatMap((ev) => (
    ev.evidenceSource === 'evaluation-core' && ev.runId
      ? [[ev.reportId, ev.runId] as const]
      : []
  )));
  // install 不带 contentHash：record.contentHash 是「当前基线」（evolve 会 re-baseline），不是安装时那份；
  // 拿它标安装事件会误导，故安装只作时间起点，版本分段只用 evidence / decision 自带的 contentHash。
  events.push({ at: record.installedAt, type: 'install' });
  for (const ev of record.evidence) {
    events.push({
      at: ev.recordedAt, type: 'eval', contentHash: ev.contentHash, verdict: ev.verdict,
      reportId: ev.reportId,
      reportLocatorId: ev.evidenceSource === 'evaluation-core' ? ev.runId : ev.reportId,
      sampleCount: ev.sampleCoverage?.count, cliVersion: ev.comparability?.cliVersion,
      ...(ev.gitCommit ? { gitCommit: ev.gitCommit } : {}),
    });
  }
  for (const d of record.decisions) {
    events.push({
      at: d.decidedAt, type: d.decisionKind, contentHash: d.contentHash,
      reportId: d.reportId,
      reportLocatorId: d.reportId === undefined
        ? undefined
        : runIdByReportId.get(d.reportId) ?? d.reportId,
      actor: d.actor, reason: d.reason, override: d.override,
    });
  }
  // observe 生产健康观测(#235):每条一个事件。**不带 contentHash** —— observe 是版本无关的生产信号
  // (量线上部署版),像 install 事件那样只作时间点,绝不重置版本分段(见 renderManagedHistory 分段循环)。
  for (const obs of record.observations ?? []) {
    events.push({
      at: obs.observedAt, type: 'observe',
      healthBand: obs.healthBand, confidence: obs.confidence, gapByType: obs.gapByType,
    });
  }
  return events.sort((a, b) => cmpDesc(a.at, b.at));
}

function reportLink(reportId: string | undefined, lang: Lang): string {
  if (!reportId) return '';
  return `<a class="mh-link" href="/reports/${encodeURIComponent(reportId)}${langQuery(lang)}">${L(lang)('查看报告', 'report')} →</a>`;
}

/** 本地 git 源的仓内路径(`git:<ref>:<spec>` → spec),给 `git checkout <sha> -- <path>` 提示带上 `-- <path>`。
 *  远端 / file 源 → undefined(本地 git 才有 cwd checkout 语义)。
 *  file-skill 的实际仓内文件是 `<spec>.md`(install 裸名 spec 经 classifyGitSkillRef 解到 `<spec>.md`),
 *  故 file-skill 且 spec 未带 `.md` 时补上 —— 否则 `git checkout … -- review` 匹配不到 `review.md`。
 *  已知局限:locator 的 spec 是**安装时 cwd 相对**的(不含 gitRelDir 前缀),在仓库子目录里 install 的 skill,
 *  还原路径会缺该子目录前缀。彻底修需在记录上另存仓库根相对路径(与 drift 重解析的 cwd 相对语义解耦),留 follow-up。 */
function gitRestorePath(source: ManagedArtifactRecord['source']): string | undefined {
  if (source.sourceKind !== 'git' || source.url) return undefined;
  const m = /^git:[^:]*:(.+)$/.exec(source.locator);
  if (!m) return undefined;
  const spec = m[1];
  return (!source.isDirectorySkill && !/\.md$/i.test(spec)) ? `${spec}.md` : spec;
}

/** POSIX 单引号包裹,内部 `'` 按 `'\''` 标准转义。还原提示是给用户复制粘贴的 shell 命令,git 路径可含
 *  空格 / 分号 / 反引号 / `$()` 等元字符 —— e()(HTML escaping)挡不住 shell,不 quote 会被改写命令语义。 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function eventRow(ev: TimelineEvent, lang: Lang, restorePath?: string): string {
  const t = L(lang);
  const typeLabel: Record<TimelineEvent['type'], string> = {
    install: t('安装纳管', 'Installed'),
    eval: t('评测', 'Eval'),
    promote: t('采用', 'Promote'),
    reject: t('否决', 'Reject'),
    rollback: t('回滚', 'Rollback'),
    observe: t('观测', 'Observe'),
  };
  const head: string[] = [`<span class="mh-type">${e(typeLabel[ev.type])}</span>`];
  if (ev.type === 'eval') head.push(verdictBadge(ev.verdict, lang));
  // observe 观测徽标,四分支(green / yellow 必须分开 —— yellow 不是健康):红 + 够力 → 「生产盲区」(确诊);
  // underpowered → 「数据不足」(unknown,任意 band 都先归此,与 deriveProductionGap 同口径);yellow + 够力 →
  // 「需关注」(盲区已进注意区间、未达 red 告警,不能说成健康);green + 够力 → 「健康」。
  if (ev.type === 'observe') {
    if (ev.healthBand === 'red' && ev.confidence !== 'underpowered') {
      head.push(`<span class="mh-gap">🔬 ${t('生产盲区', 'production gap')}</span>`);
    } else if (ev.confidence === 'underpowered') {
      head.push(`<span class="mh-badge-raw">${t('数据不足', 'underpowered')}</span>`);
    } else if (ev.healthBand === 'yellow') {
      head.push(`<span class="mh-watch">${t('需关注', 'elevated')}</span>`);
    } else {
      head.push(`<span class="mh-badge-raw">${t('健康', 'healthy')}</span>`);
    }
  }
  if (ev.override) {
    const blocks = ev.override.overriddenBlocks?.length ? `：${e(ev.override.overriddenBlocks.join(' / '))}` : '';
    head.push(`<span class="mh-override">${t('越门 override', 'override')}${blocks}</span>`);
  }

  const detail: string[] = [];
  if (ev.actor) detail.push(`<span class="mh-detail-item">${t('决定人', 'by')} ${e(ev.actor)}</span>`);
  if (ev.type === 'eval' && typeof ev.sampleCount === 'number') {
    detail.push(`<span class="mh-detail-item">${ev.sampleCount} ${t('用例', 'samples')}</span>`);
  }
  // observe 事件:列盲区集中的信号区域 + 建议补样本(只提示、不生成用例,不改样本集)。全 0 不显区域行。
  if (ev.type === 'observe' && ev.gapByType) {
    const areas = topGapAreas(ev.gapByType, lang);
    if (areas) detail.push(`<span class="mh-detail-item">${t('盲区集中在：', 'gaps in: ')}${e(areas)}</span>`);
    if (ev.healthBand === 'red' && ev.confidence !== 'underpowered') {
      detail.push(`<span class="mh-detail-item mh-gap-hint">${t('建议补对应用例后重跑 omk eval', 'add matching samples, then re-run omk eval')}</span>`);
    }
  }
  if (ev.cliVersion) detail.push(`<span class="mh-detail-item">omk ${e(ev.cliVersion)}</span>`);
  if (ev.reportLocatorId) detail.push(reportLink(ev.reportLocatorId, lang));
  if (ev.reason) detail.push(`<span class="mh-reason">「${e(ev.reason)}」</span>`);
  // #234/#236 还原指针:这一版有 git 坐标 + 能解析出仓内路径 → 给现成的 `git checkout <sha> -- <path>` 把
  // 该路径还原进工作树(字节级还原交给 git)。必须带 `-- <path>`:不带 pathspec 的 `git checkout <sha>` 是切
  // detached HEAD、整棵工作树被换,语义完全不同且危险 —— 故解析不出路径时干脆不显,不退化成那条命令。显
  // full SHA(精确坐标、无歧义);路径 shell-quote 防注入(见 shellQuote)。
  // 注:对目录-skill,checkout 还原该版的跟踪文件,但不会删除其后新增的文件 —— git pathspec 的固有语义。
  if (ev.gitCommit && restorePath) {
    const cmd = `git checkout ${ev.gitCommit} -- ${shellQuote(restorePath)}`;
    detail.push(`<span class="mh-detail-item mh-restore">${t('还原', 'restore')} <code>${e(cmd)}</code></span>`);
  }

  // 圆点配色:多数事件按 type 取色;observe 事件按**健康 band** 取色(盲区红 / 数据不足灰 / 注意黄 / 健康绿)
  // —— observe 是 type 内有强弱的事件,健康或注意观测画错色会撒谎,故按实际健康度上色,与上面徽标四分支同口径。
  const dotClass = ev.type === 'observe'
    ? (ev.healthBand === 'red' && ev.confidence !== 'underpowered' ? 'mh-dot--red'
      : ev.confidence === 'underpowered' ? 'mh-dot--muted'
      : ev.healthBand === 'yellow' ? 'mh-dot--yellow' : 'mh-dot--green')
    : `mh-dot--${ev.type}`;
  return `<li class="mh-event mh-event--${ev.type}">
    <span class="mh-time">${e(fmtLocalTime(ev.at))}</span>
    <span class="mh-marker"><span class="mh-dot ${dotClass}"></span></span>
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

/** 版本回归曲线(纯 SVG,确定性、可 snapshot):每版 composite 均值 + 95%CI 竖须,按时间从旧到新。
 *  不可比的版本(换过评委 / 改过样本集,或缺指纹无法核对)点画空心、连线画虚 —— 不糊一条误导的「在变好」线(spec §3)。
 *  数据由 buildVersionScores 算好;少于 2 个点不画(单点无趋势可言)。composite 量纲不定,y 轴按数据自适应。 */
function renderVersionCurve(points: VersionScorePoint[], lang: Lang): string {
  if (points.length < 2) return '';
  const t = L(lang);
  const width = 620, height = 250, padL = 46, padR = 16, padT = 16, padB = 46;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = points.length;
  let yLo = Math.min(...points.map((p) => p.ciLow));
  let yHi = Math.max(...points.map((p) => p.ciHigh));
  if (yHi - yLo < 1e-9) { yLo -= 0.5; yHi += 0.5; } // 全相等退化:给个最小跨度,免除零。
  const pad = (yHi - yLo) * 0.08;
  yLo -= pad; yHi += pad;
  const xAt = (i: number): number => padL + (plotW * i) / (n - 1);
  const yAt = (v: number): number => padT + plotH - (plotH * (v - yLo)) / (yHi - yLo);

  const parts: string[] = [];
  // 连线逐段;任一端不可比 → 虚线,提示别把跨不可比的差值读作进步 / 回退。
  for (let i = 1; i < n; i++) {
    const a = points[i - 1], b = points[i];
    const dash = (!a.comparable || !b.comparable) ? ' stroke-dasharray="4 3"' : '';
    parts.push(`<line x1="${xAt(i - 1).toFixed(1)}" y1="${yAt(a.composite).toFixed(1)}" x2="${xAt(i).toFixed(1)}" y2="${yAt(b.composite).toFixed(1)}" stroke="var(--accent)" stroke-width="2"${dash} />`);
  }
  // 每点:CI 竖须 + 上下端帽 + 点(可比实心 / 不可比空心)+ 短 hash 轴标。
  points.forEach((p, i) => {
    const x = xAt(i), yL = yAt(p.ciLow), yH = yAt(p.ciHigh), yM = yAt(p.composite);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${x.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-opacity="0.5" />`);
    parts.push(`<line x1="${(x - 3).toFixed(1)}" y1="${yH.toFixed(1)}" x2="${(x + 3).toFixed(1)}" y2="${yH.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-opacity="0.5" />`);
    parts.push(`<line x1="${(x - 3).toFixed(1)}" y1="${yL.toFixed(1)}" x2="${(x + 3).toFixed(1)}" y2="${yL.toFixed(1)}" stroke="var(--accent)" stroke-width="1" stroke-opacity="0.5" />`);
    parts.push(p.comparable
      ? `<circle cx="${x.toFixed(1)}" cy="${yM.toFixed(1)}" r="4" fill="var(--accent)" />`
      : `<circle cx="${x.toFixed(1)}" cy="${yM.toFixed(1)}" r="4" fill="var(--bg-surface)" stroke="var(--accent)" stroke-width="1.5" />`);
    parts.push(`<text x="${x.toFixed(1)}" y="${height - padB + 14}" font-size="9" text-anchor="middle" fill="var(--text-muted)">${e(p.contentHash.slice(0, 7))}</text>`);
  });
  const yTicks = [0, 0.5, 1].map((f) => {
    const v = yLo + (yHi - yLo) * f;
    const y = yAt(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="var(--border)" stroke-width="0.5" /><text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="var(--text-muted)">${v.toFixed(2)}</text>`;
  }).join('');

  const anyIncomparable = points.some((p) => !p.comparable);
  const note = anyIncomparable
    ? t('空心点 = 测量条件不同或无法核对（换过评委 / 改过样本集 / 缺指纹），与当前版不可比；虚线段别直接读作进步或回退。', 'Hollow dots = measured under a different or unverifiable instrument (judge / sample set changed, or fingerprint missing) than the current version, not comparable; do not read dashed segments as progress or regression.')
    : t('每个版本的 composite 均值与 95% 置信区间，按时间从旧到新。', 'Composite mean and 95% CI per version, oldest to newest.');

  return `<section class="mh-curve">
    <h2 class="mh-curve-title">${t('版本回归曲线', 'Version regression')}</h2>
    <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="mh-curve-svg">${yTicks}${parts.join('')}</svg>
    <p class="mh-curve-note">${note}</p>
  </section>`;
}

export function renderManagedHistory(record: ManagedArtifactRecord, lang: Lang, versionScores: VersionScorePoint[] = []): string {
  const t = L(lang);
  const events = buildTimeline(record);

  // 倒序遍历：内容版本（contentHash）变化处插版本段头；install 等无 hash 事件不重置分段。
  const restorePath = gitRestorePath(record.source);
  const rows: string[] = [];
  let prevHash: string | undefined;
  for (const ev of events) {
    if (ev.contentHash && ev.contentHash !== prevHash) {
      rows.push(versionHeader(ev.contentHash, ev.contentHash === record.contentHash, lang));
      prevHash = ev.contentHash;
    }
    rows.push(eventRow(ev, lang, restorePath));
  }

  const meta = [
    record.kind,
    record.source.sourceKind,
    shortHash(record.contentHash),
    `${t('纳管于', 'since')} ${fmtLocalTime(record.installedAt)}`,
  ].map((m) => `<span>${e(m)}</span>`).join('');

  const body = `<main class="mh-main">
    <nav class="mh-back"><a href="/managed${langQuery(lang)}">← ${t('受管列表', 'Managed')}</a></nav>
    <header class="mh-hero">
      <div class="mh-kind">${t('受管决策史', 'Managed history')}</div>
      <h1 class="mh-name">${e(record.name)}</h1>
      <div class="mh-meta">${meta}</div>
    </header>
    ${renderVersionCurve(versionScores, lang)}
    <ol class="mh-timeline">${rows.join('')}</ol>
  </main>
  <style>${MANAGED_CSS}</style>`;

  return layout(`${t('受管决策史', 'Managed history')} · ${record.name}`, body, lang);
}

function stateBand(state: string): string {
  return state === 'promoted' ? 'green' : state === 'stale' ? 'red' : state === 'measurable' ? 'accent' : 'muted';
}

/** 生命周期状态的面向用户文案 + 一句话释义(挂 title)。原始 token 仍在 /api/managed 的 row.state（机读口径不变）,
 *  此处只本地化人看的 HTML —— measurable / installed 这类内部枚举对首次接触管理支柱的人并不自解释。
 *  用 Record<ManagedLifecycleLabel> 让 TS 编译期强制列全所有状态 —— types/managed 新增 label（如已声明
 *  却尚未在列表出现的 discovered）时这里报错、逼同步,避免新状态被静默当原始 token 渲染。 */
const STATE_LABELS: Record<ManagedLifecycleLabel, { zh: [string, string]; en: [string, string] }> = {
  discovered: { zh: ['已发现', '已发现，尚未纳管取证'], en: ['Discovered', 'Discovered, not yet under management'] },
  installed: { zh: ['已纳管', '已纳入管理，当前内容尚无有效证据'], en: ['Installed', 'Under management; no valid evidence for current content yet'] },
  measurable: { zh: ['证据就绪', '当前内容已有有效证据，可进入采用门禁'], en: ['Measurable', 'Current content has valid evidence; ready for the promote gate'] },
  stale: { zh: ['已漂移', '源内容已变更、脱离证据，需重跑 omk eval 取证'], en: ['Drifted', 'Source changed off its evidence — re-run omk eval'] },
  promoted: { zh: ['已采用', '已按证据人工复核并接受当前内容'], en: ['Promoted', 'Manually reviewed and accepted on evidence'] },
};

function stateMeta(state: string, lang: Lang): { label: string; tip: string } {
  // Record 保证联合内全覆盖;?? 兜被污染的非法 token(已被 isManagedArtifactRecord 校验过,理论不达),原样降级不崩。
  const m = (STATE_LABELS as Record<string, { zh: [string, string]; en: [string, string] }>)[state]
    ?? { zh: [state, state] as [string, string], en: [state, state] as [string, string] };
  const [label, tip] = lang === 'zh' ? m.zh : m.en;
  return { label, tip };
}

/** 列表只读审计标:当前采用版本是越门(`--force`)来的就标出来,tooltip 列被绕过的门。复用详情时间线的
 *  `.mh-override` 样式。override 的写仍只在 CLI —— Studio 只读(spec §9 / #238)。 */
function overrideBadge(row: ManagedListRow, lang: Lang): string {
  if (!row.override) return '';
  const t = L(lang);
  const blocks = row.override.overriddenBlocks?.length ? row.override.overriddenBlocks.join(' / ') : '';
  const tip = blocks ? t(`越门采用，绕过：${blocks}`, `force-promoted, waved: ${blocks}`) : t('越门采用', 'force-promoted');
  return ` <span class="mh-override" title="${e(tip)}">${t('越门', 'override')}</span>`;
}

/** 生产盲区只读标(#235):该 skill 最新观测是确诊生产盲区(红 + 够力)就标出来,tooltip 列盲区区域。
 *  与 state 正交(observe 量线上部署版、版本无关),只 surface、不参与生命周期 —— 见 deriveProductionGap。 */
function productionGapBadge(row: ManagedListRow, lang: Lang): string {
  if (!row.productionGap) return '';
  const t = L(lang);
  const areas = topGapAreas(row.productionGap.gapByType, lang);
  const tip = areas ? t(`线上生产盲区，集中在：${areas}`, `production gap in real traffic, in: ${areas}`) : t('线上检测到生产盲区', 'production gap detected in real traffic');
  // 只放图标(state 列窄、固定 130px,带文字徽标会溢出压到 name 列);全称走 tooltip + legend + 时间线。
  return ` <span class="mh-gap" title="${e(tip)}">🔬</span>`;
}

function listRow(row: ManagedListRow, lang: Lang): string {
  const t = L(lang);
  const st = stateMeta(row.state, lang);
  const mark = !row.reachable ? ' <span class="mh-mark mh-mark--q" title="' + e(t('源不可达 / 拒读，漂移未核', 'source unreachable / refused, drift unchecked')) + '">?</span>'
    : row.state === 'stale' ? ' <span class="mh-mark mh-mark--warn" title="' + e(t('已漂移，需重测', 'drifted, re-measure')) + '">⚠️</span>' : '';
  return `<a class="mh-row" href="/managed/${encodeURIComponent(row.id)}${langQuery(lang)}">
    <span class="mh-row-state" title="${e(st.tip)}"><span class="mh-dot mh-dot--${stateBand(row.state)}"></span>${e(st.label)}${mark}${productionGapBadge(row, lang)}</span>
    <span class="mh-row-name">${e(row.name)}</span>
    <span class="mh-row-kind">${e(row.kind)}</span>
    <span class="mh-row-verdict">${row.latestVerdict ? verdictBadge(row.latestVerdict, lang) : '—'}${overrideBadge(row, lang)}</span>
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

  // 页内图例,镜像 omk list 的注脚（状态语义 + ⚠️ / ? 标记 + 证据列含义）—— 首次接触管理支柱的人不必先懂内部枚举。
  const legend = rows.length === 0 ? '' : `
    <div class="mh-legend">
    <span class="mh-legend-item"><span class="mh-dot mh-dot--green"></span>${t('已采用：已按证据人工接受', 'Promoted = accepted on evidence')}</span>
    <span class="mh-legend-item"><span class="mh-dot mh-dot--accent"></span>${t('证据就绪：当前内容有有效证据、可采用', 'Measurable = current content has evidence, gate-ready')}</span>
    <span class="mh-legend-item"><span class="mh-dot mh-dot--muted"></span>${t('已纳管：尚无当前证据', 'Installed = no current evidence yet')}</span>
    <span class="mh-legend-item"><span class="mh-dot mh-dot--red"></span>${t('已漂移 ⚠️：源变了、需重跑 omk eval', 'Drifted ⚠️ = source changed, re-run omk eval')}</span>
    <span class="mh-legend-item">${t('? 源未核（不可达 / 拒读，漂移待定）', '? = source unverified (unreachable / refused)')}</span>
    <span class="mh-legend-item">${t('证据列：当前有效 / 全部历史（旧证据留作回滚）', 'Evidence = current / total (old evidence kept for rollback)')}</span>
    <span class="mh-legend-item"><span class="mh-override">${t('越门', 'override')}</span>${t(' 当前采用是 --force 越门来的（决定人由命令行记录）', ' = current version force-promoted via --force (actor recorded by CLI)')}</span>
    <span class="mh-legend-item"><span class="mh-gap">🔬</span>${t(' 生产盲区：observe 在线上检测到的盲区（版本无关信号、与生命周期正交，不翻 stale）', ' = production gap from observe (version-agnostic, orthogonal to lifecycle, never flips stale)')}</span>
  </div>`;

  const body = `<main class="mh-main">
    <header class="mh-hero">
      <div class="mh-kind">${t('受管 skill', 'Managed skills')}</div>
      <h1 class="mh-name">${t('决策史', 'Decision history')}</h1>
      <div class="mh-meta"><span>${t('每个 skill 的 install → 评测 → 采用 / 回滚 全过程', 'install → eval → promote / rollback per skill')}</span></div>
    </header>
    <div class="mh-table">${list}</div>${legend}
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

/* ── 版本回归曲线 ── */
.mh-curve{background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);padding:16px 20px;margin-bottom:18px}
.mh-curve-title{margin:0 0 4px;font-size:15px;font-weight:700;color:var(--text-primary);letter-spacing:-.2px}
.mh-curve-svg{width:100%;max-width:620px;height:auto;display:block;margin:6px 0}
.mh-curve-note{font-size:12px;color:var(--text-muted);margin:6px 0 0}

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
.mh-dot--green{background:var(--green)}.mh-dot--accent{background:var(--accent)}.mh-dot--muted{background:var(--text-muted)}.mh-dot--red{background:var(--red)}.mh-dot--yellow{background:var(--yellow)}
.mh-body{flex:1;min-width:0}
.mh-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:14px}
.mh-type{font-weight:600;color:var(--text-primary)}
.mh-override{font-size:11px;font-weight:600;color:var(--yellow);background:var(--yellow-bg);padding:1px 8px;border-radius:9px}
.mh-gap{font-size:11px;font-weight:600;color:var(--red);background:var(--red-bg);padding:1px 8px;border-radius:9px;white-space:nowrap}
.mh-watch{font-size:11px;font-weight:600;color:var(--yellow);background:var(--yellow-bg);padding:1px 8px;border-radius:9px;white-space:nowrap}
.mh-gap-hint{color:var(--red)}
.mh-badge-raw{font-size:11.5px;color:var(--text-secondary);background:var(--bg-soft);padding:1px 8px;border-radius:9px}
.mh-detail{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px;font-size:12px;color:var(--text-muted)}
.mh-restore code{font-family:"SF Mono",Menlo,monospace;font-size:11.5px;color:var(--text-secondary);background:var(--bg-soft);padding:1px 6px;border-radius:5px;user-select:all}
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
.mh-legend{display:flex;flex-wrap:wrap;gap:7px 16px;margin-top:14px;padding:12px 16px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);font-size:12px;color:var(--text-muted)}
.mh-legend-item{display:inline-flex;align-items:center;gap:6px}
`;
