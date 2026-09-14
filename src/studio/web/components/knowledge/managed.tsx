'use client';
import { Empty, Table, Tag, Timeline, Tooltip, Typography } from 'antd';
import type { ManagedLifecycleLabel } from '../../../../knowledge-artifacts/governance/contracts';
import type {
  ManagedGapSignalType,
  ManagedListPresentation,
  ManagedObserveBadge,
  ManagedTimelineEvent,
  ManagedTone,
} from '../../../application/knowledge/managed-format';
import type { ManagedPage } from '../../../http/pages/managed-page';
import type { Language } from '../layout/shell';
import { KnowledgeSectionNav } from './section-nav';

const { Text } = Typography;

/** 页内跳转统一带 lang，否则点一下就掉回默认中文；zh 是默认 → 空串，不脏 URL。 */
const suffix = (lang: Language): string => (lang === 'en' ? '?lang=en' : '');
const shortHash = (hash: string): string => hash.slice(0, 12);
/** 与其他 Studio 页面同口径：显示 UTC 并显式标注，不用服务器本地时区（那会让同一记录在不同机器上读出不同时刻）。 */
const displayTime = (value: string): string => value.replace('T', ' ').replace(/(?:\.\d+)?Z$/, ' UTC');

const TONE_HEX: Record<ManagedTone, string> = {
  green: '#1f9d63',
  yellow: '#d97706',
  red: '#dc2626',
  accent: '#5145cd',
  muted: '#cbd2dd',
};

const TONE_TAG_COLOR: Record<ManagedTone, string> = {
  green: 'success',
  yellow: 'warning',
  red: 'error',
  accent: 'processing',
  muted: 'default',
};

const EVENT_LABELS: Record<ManagedTimelineEvent['eventKind'], readonly [string, string]> = {
  install: ['安装纳管', 'Installed'],
  eval: ['评测', 'Eval'],
  promote: ['采用', 'Promote'],
  reject: ['否决', 'Reject'],
  rollback: ['回滚', 'Rollback'],
  observe: ['观测', 'Observe'],
};

/** observe 强弱四档：红 + 够力才是确诊生产盲区；yellow 不能读作健康；underpowered 优先于色带。 */
const OBSERVE_BADGES: Record<ManagedObserveBadge, { label: readonly [string, string]; tone: ManagedTone }> = {
  production_gap: { label: ['生产盲区', 'production gap'], tone: 'red' },
  underpowered: { label: ['数据不足', 'underpowered'], tone: 'muted' },
  elevated: { label: ['需关注', 'elevated'], tone: 'yellow' },
  healthy: { label: ['健康', 'healthy'], tone: 'green' },
};

const GAP_SIGNAL_LABELS: Record<ManagedGapSignalType, readonly [string, string]> = {
  failed_search: ['检索失败', 'failed search'],
  explicit_marker: ['显式缺口', 'explicit gap'],
  hedging: ['含糊回避', 'hedging'],
  repeated_failure: ['反复失败', 'repeated failure'],
};

/**
 * 生命周期状态的面向用户文案 + 一句话释义。原始 token 仍在 `/api/managed` 的 `row.state`（机读口径不变），
 * 此处只本地化人看的文字。Record<ManagedLifecycleLabel, …> 让治理侧新增状态时这里编译期报错、逼同步，
 * 避免新状态被静默当原始 token 渲染。
 */
const STATE_LABELS: Record<ManagedLifecycleLabel, { zh: readonly [string, string]; en: readonly [string, string] }> = {
  discovered: { zh: ['已发现', '已发现，尚未纳管取证'], en: ['Discovered', 'Discovered, not yet under management'] },
  installed: { zh: ['已纳管', '已纳入管理，当前内容尚无有效证据'], en: ['Installed', 'Under management; no valid evidence for current content yet'] },
  measurable: { zh: ['证据就绪', '当前内容已有有效证据，可进入采用门禁'], en: ['Measurable', 'Current content has valid evidence; ready for the promote gate'] },
  stale: { zh: ['已漂移', '源内容已变更、脱离证据，需重跑 omk eval 取证'], en: ['Drifted', 'Source changed off its evidence — re-run omk eval'] },
  promoted: { zh: ['已采用', '已按证据人工复核并接受当前内容'], en: ['Promoted', 'Manually reviewed and accepted on evidence'] },
};

function stateMeta(state: string, zh: boolean): { label: string; tip: string } {
  // Record 已保证联合内全覆盖；?? 兜被污染的非法 token（记录已过校验，理论不达），原样降级不崩。
  const entry = (STATE_LABELS as Record<string, typeof STATE_LABELS.promoted>)[state]
    ?? { zh: [state, state] as const, en: [state, state] as const };
  const [label, tip] = zh ? entry.zh : entry.en;
  return { label, tip };
}

function Dot({ tone }: { tone: ManagedTone }) {
  return <span className="managed-dot" style={{ background: TONE_HEX[tone] }} aria-hidden="true" />;
}

/** Core 决定策略拥有 verdict 词表；Studio 原样呈现已认证的值，不本地化、不重新解释。 */
function VerdictTag({ verdict }: { verdict: string }) {
  return <Tag className="managed-verdict">{verdict}</Tag>;
}

function OverrideTag({ zh, blocks }: { zh: boolean; blocks?: string[] }) {
  const tip = blocks?.length
    ? (zh ? `越门采用，绕过：${blocks.join(' / ')}` : `force-promoted, waved: ${blocks.join(' / ')}`)
    : (zh ? '越门采用' : 'force-promoted');
  return <Tooltip title={tip}><Tag color="warning">{zh ? '越门' : 'override'}</Tag></Tooltip>;
}

function eventTone(event: ManagedTimelineEvent): ManagedTone {
  if (event.eventKind === 'observe') return OBSERVE_BADGES[event.observeBadge ?? 'healthy'].tone;
  if (event.eventKind === 'install') return 'muted';
  if (event.eventKind === 'eval') return 'accent';
  if (event.eventKind === 'promote') return 'green';
  if (event.eventKind === 'reject') return 'red';
  return 'yellow';
}

function gapAreaText(areas: { signalType: ManagedGapSignalType }[], zh: boolean): string {
  return areas.map((area) => GAP_SIGNAL_LABELS[area.signalType][zh ? 0 : 1]).join(zh ? '、' : ', ');
}

function EventLine({ event, zh, lang }: { event: ManagedTimelineEvent; zh: boolean; lang: Language }) {
  const badge = event.eventKind === 'observe' ? OBSERVE_BADGES[event.observeBadge ?? 'healthy'] : undefined;
  const gapAreas = event.gapAreas ?? [];
  return <div className="managed-event">
    <div className="managed-event-head">
      <Text strong>{EVENT_LABELS[event.eventKind][zh ? 0 : 1]}</Text>
      {event.eventKind === 'eval' && event.verdict && <VerdictTag verdict={event.verdict} />}
      {badge && <Tag color={TONE_TAG_COLOR[badge.tone]}>{badge.label[zh ? 0 : 1]}</Tag>}
      {event.eventKind !== 'install' && event.overriddenBlocks && <OverrideTag zh={zh} blocks={event.overriddenBlocks} />}
      <Text type="secondary" className="managed-event-time">{displayTime(event.at)}</Text>
    </div>
    <div className="managed-event-meta">
      {event.actor && <span>{zh ? `决定人 ${event.actor}` : `by ${event.actor}`}</span>}
      {event.eventKind === 'eval' && typeof event.sampleCount === 'number' && <span>{event.sampleCount} {zh ? '用例' : 'samples'}</span>}
      {gapAreas.length > 0 && <span>{zh ? '盲区集中在：' : 'gaps in: '}{gapAreas.map((area, index) => (
        <span key={area.signalType}>{index > 0 ? (zh ? '、' : ', ') : ''}{GAP_SIGNAL_LABELS[area.signalType][zh ? 0 : 1]}{zh ? `（${area.count}）` : ` (${area.count})`}</span>
      ))}</span>}
      {event.observeBadge === 'production_gap' && (
        <span className="managed-event-hint">{zh ? '建议补对应用例后重跑 omk eval' : 'add matching samples, then re-run omk eval'}</span>
      )}
      {event.runId && <a href={`/measure/${encodeURIComponent(event.runId)}${suffix(lang)}`}>{zh ? '查看报告 →' : 'report →'}</a>}
      {event.reason && <em>{zh ? `「${event.reason}」` : `"${event.reason}"`}</em>}
    </div>
  </div>;
}

export function ManagedListView({ page, lang }: { page: Extract<ManagedPage, { pageKind: 'list' }>; lang: Language }) {
  const zh = lang === 'zh';
  return <>
    <KnowledgeSectionNav active="managed" lang={lang} />
    <div className="measure-heading">
      <div>
        <h1>{zh ? '受管 skill 决策史' : 'Managed skill decision history'}</h1>
        <p>{zh ? '每个 skill 的 install → 评测 → 采用 / 回滚 全过程' : 'install → eval → promote / rollback per skill'}</p>
      </div>
    </div>
    {page.rows.length === 0 ? <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={<span>{zh ? '暂无受管 skill，运行 ' : 'No managed skills yet — run '}<code>omk install &lt;skill&gt;</code>{zh ? ' 开始纳管。' : ' to start.'}</span>}
    /> : <>
      <Table<ManagedListPresentation>
        className="measure-table managed-table"
        size="small"
        rowKey={(item) => item.row.id}
        tableLayout="fixed"
        scroll={{ x: 900 }}
        dataSource={page.rows}
        pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
        columns={[
          {
            title: zh ? '状态' : 'State',
            width: 200,
            render: (_, item) => <span className="managed-state">
              <Tooltip title={stateMeta(item.row.state, zh).tip}><span><Dot tone={item.tone} />{stateMeta(item.row.state, zh).label}</span></Tooltip>
              {!item.row.reachable && <Tooltip title={zh ? '源不可达 / 拒读，漂移未核' : 'source unreachable / refused, drift unchecked'}><span className="managed-mark">?</span></Tooltip>}
              {item.row.state === 'stale' && <Tooltip title={zh ? '已漂移，需重测' : 'drifted, re-measure'}><span aria-hidden="true">⚠️</span></Tooltip>}
              {item.row.productionGap && <Tooltip title={item.gapAreas.length
                ? (zh ? `线上生产盲区，集中在：${gapAreaText(item.gapAreas, true)}` : `production gap in real traffic, in: ${gapAreaText(item.gapAreas, false)}`)
                : (zh ? '线上检测到生产盲区' : 'production gap detected in real traffic')}><span aria-hidden="true">🔬</span></Tooltip>}
            </span>,
          },
          {
            title: zh ? '名称' : 'Name',
            dataIndex: ['row', 'name'],
            ellipsis: { showTitle: false },
            render: (name: string, item) => <a href={`/knowledge/managed/${encodeURIComponent(item.row.id)}${suffix(lang)}`} title={name}>{name}</a>,
          },
          { title: zh ? '类型' : 'Kind', dataIndex: ['row', 'kind'], width: 110 },
          {
            title: 'verdict',
            width: 160,
            render: (_, item) => <>
              {item.row.latestVerdict ? <VerdictTag verdict={item.row.latestVerdict} /> : '—'}
              {item.row.override && <OverrideTag zh={zh} blocks={item.row.override.overriddenBlocks} />}
            </>,
          },
          {
            title: zh ? '证据' : 'Evidence',
            width: 90,
            align: 'right',
            render: (_, item) => <span className="managed-count">{item.row.currentEvidenceCount}/{item.row.totalEvidenceCount}</span>,
          },
          {
            title: zh ? '源' : 'Source',
            ellipsis: { showTitle: false },
            render: (_, item) => <Tooltip title={item.row.sourceLabel} placement="topLeft"><span>{item.row.sourceLabel}</span></Tooltip>,
          },
        ]}
      />
      <div className="managed-legend">
        <span><Dot tone="green" />{zh ? '已采用：已按证据人工接受' : 'Promoted = accepted on evidence'}</span>
        <span><Dot tone="accent" />{zh ? '证据就绪：当前内容有有效证据、可采用' : 'Measurable = current content has evidence, gate-ready'}</span>
        <span><Dot tone="muted" />{zh ? '已纳管：尚无当前证据' : 'Installed = no current evidence yet'}</span>
        <span><Dot tone="red" />{zh ? '已漂移 ⚠️：源变了、需重跑 omk eval' : 'Drifted ⚠️ = source changed, re-run omk eval'}</span>
        <span>{zh ? '? 源未核（不可达 / 拒读，漂移待定）' : '? = source unverified (unreachable / refused)'}</span>
        <span>{zh ? '证据列：当前有效 / 全部历史（旧证据留作回滚）' : 'Evidence = current / total (old evidence kept for rollback)'}</span>
        <span><Tag color="warning">{zh ? '越门' : 'override'}</Tag>{zh ? ' 当前采用是 --force 越门来的（决定人由命令行记录）' : ' = current version force-promoted via --force (actor recorded by CLI)'}</span>
        <span>🔬{zh ? ' 生产盲区：observe 在线上检测到的盲区（版本无关信号、与生命周期正交，不翻 stale）' : ' = production gap from observe (version-agnostic, orthogonal to lifecycle, never flips stale)'}</span>
      </div>
    </>}
  </>;
}

export function ManagedHistoryView({ page, lang }: { page: Extract<ManagedPage, { pageKind: 'detail' }>; lang: Language }) {
  const zh = lang === 'zh';
  const items = page.segments.flatMap((segment) => {
    const header = segment.contentHash === null ? [] : [{
      color: 'gray',
      content: <div className="managed-version">
        <Text type="secondary">{zh ? '版本' : 'version'}</Text>
        <code className="measure-code">{shortHash(segment.contentHash)}</code>
        {segment.isCurrent && <Tag color="success">{zh ? '当前' : 'current'}</Tag>}
      </div>,
    }];
    return [...header, ...segment.events.map((event) => ({
      color: TONE_HEX[eventTone(event)],
      content: <EventLine event={event} zh={zh} lang={lang} />,
    }))];
  });
  return <>
    <KnowledgeSectionNav active="managed" lang={lang} />
    <div className="measure-heading">
      <div>
        <a href={`/knowledge/managed${suffix(lang)}`}>{zh ? '← 受管列表' : '← Managed skills'}</a>
        <h1 title={page.name}>{page.name}</h1>
        <p>{[page.artifactKind, page.sourceKind, shortHash(page.contentHash), `${zh ? '纳管于' : 'since'} ${displayTime(page.installedAt)}`].join(' · ')}</p>
      </div>
    </div>
    <Timeline className="managed-timeline" items={items}/>
  </>;
}

export function ManagedView({ page, lang }: { page: ManagedPage; lang: Language }) {
  return page.pageKind === 'list'
    ? <ManagedListView page={page} lang={lang} />
    : <ManagedHistoryView page={page} lang={lang} />;
}
