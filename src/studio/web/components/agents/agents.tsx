'use client';
import Link from 'next/link';
import { Alert, Table, Tag, Typography } from 'antd';
import type {
  AgentCollectionReport,
  AgentInventoryReport,
  AgentLogRootStatus,
  CollectedSession,
  DetectedAgent,
} from '../../../../observability/agents/index';
import type { AgentsPage } from '../../../http/pages/agents-page';
import { KNOWLEDGE_CANDIDATES_PATH } from '../../../http/page-paths';
import { displayBytes, displayTime } from '../../../application/display/format';
import type { Language } from '../layout/shell';

const COPY = {
  zh: {
    title: '本机 Agent',
    intro: '识别本机装了哪些 Agent、采集了它们哪些会话日志。页面只读取 omk agents 落盘的报告，不会重新扫描这台机器。',
    detectedHeading: '识别结果',
    collectedHeading: '日志采集',
    nextHeading: '下一步',
    commandHint: '命令在终端执行；本页只呈现结果，不代替你改动文件或调用模型。',
    agent: 'Agent',
    vendor: '厂商',
    installed: '已安装',
    notInstalled: '未发现',
    sourceKind: '日志格式',
    noSourceKind: '未落已支持格式',
    sessionFiles: '会话文件',
    evidence: '判定依据',
    rootState: '状态',
    rootPath: '路径',
    rootCount: '文件数',
    rootBytes: '体积',
    rootNewest: '最近更新',
    rootAbsent: '不存在',
    unreadable: '不可读',
    truncated: '已截断',
    detectedSummary: (known: number, installed: number, files: number) => `登记表 ${known} 个 · 已安装 ${installed} 个 · 会话日志 ${files} 份`,
    collectedSummary: (collected: number, events: number) => `采集 ${collected} 份会话 · 事件 ${events} 条`,
    sessionTitle: '会话',
    events: '事件',
    unknownEvents: '未识别事件',
    bucketUnsupported: '未支持格式',
    bucketDuplicateView: '重复视图已忽略',
    bucketUnmappedEvidence: '待映射证据',
    bucketUnsupportedShort: '未支持',
    bucketDuplicateViewShort: '重复视图',
    bucketUnmappedEvidenceShort: '待映射',
    bucketLegend: '未支持格式：适配器读不出语义的记录，属于真正的能力缺口。重复视图已忽略：同一条事实已被别的视图映射过，或它是累计快照，再映射会变成双计，因此刻意不产出事件。待映射证据：记录族已经识别，但映射成什么事件还没决定，原始证据仍保留在日志里。',
    size: '体积',
    modifiedAt: '日志更新',
    artifact: '归一化产物',
    inventoryMissing: '还没有识别过本机 Agent。在终端运行 omk agents list，结果会写入这台机器的 Agent 目录。',
    inventoryUnreadable: '识别报告读不动，页面不猜它原本写了什么。重新运行 omk agents list 会覆盖它。',
    collectionMissing: '还没有采集过日志。先运行 omk agents list，再运行 omk agents collect。',
    collectionUnreadable: '采集报告读不动，页面不拿上一次的产物充数。重新运行 omk agents collect。',
    collectionOutdated: (version: string) => `采集报告是 ${version} 口径，未识别事件的分桶计数无法沿用。运行 omk agents collect 会按当前口径重新采集并覆盖它。`,
    truncatedWarning: '有日志根被容量上限截断，上面的计数是已扫描部分，不是全量。',
    limitationsHeading: '本次采集的限制',
    unknownRatioWarning: (percent: string) => `归一化后的事件里有 ${percent} 属于未支持的格式，只保留了原始记录。未识别不等于无影响，需要看原始日志再判断。`,
    nextList: [
      { command: 'omk agents list', text: '重新识别本机 Agent 与它们的日志根。' },
      { command: 'omk agents collect', text: '增量采集会话日志并映射成统一 Trace IR 产物。' },
      { command: 'omk agents extract --session <runId>', text: '对选定会话提炼实体与候选知识。' },
    ],
    candidatesLink: '查看提炼出的候选知识',
  },
  en: {
    title: 'Installed agents',
    intro: 'Which agents this machine has, and which of their session logs OMK collected. The page reads the reports written by omk agents; it never rescans the machine.',
    detectedHeading: 'Detection',
    collectedHeading: 'Log collection',
    nextHeading: 'Next steps',
    commandHint: 'Commands run in a terminal. This page shows results instead of touching files or calling a model for you.',
    agent: 'Agent',
    vendor: 'Vendor',
    installed: 'Installed',
    notInstalled: 'Not found',
    sourceKind: 'Log format',
    noSourceKind: 'No supported format',
    sessionFiles: 'Session files',
    evidence: 'Detected via',
    rootState: 'State',
    rootPath: 'Path',
    rootCount: 'Files',
    rootBytes: 'Size',
    rootNewest: 'Last update',
    rootAbsent: 'Absent',
    unreadable: 'Unreadable',
    truncated: 'Truncated',
    detectedSummary: (known: number, installed: number, files: number) => `${known} registered · ${installed} installed · ${files} session logs`,
    collectedSummary: (collected: number, events: number) => `${collected} sessions · ${events} events`,
    sessionTitle: 'Session',
    events: 'Events',
    unknownEvents: 'Unrecognized',
    bucketUnsupported: 'Unsupported format',
    bucketDuplicateView: 'Duplicate view ignored',
    bucketUnmappedEvidence: 'Evidence pending mapping',
    bucketUnsupportedShort: 'unsupported',
    bucketDuplicateViewShort: 'duplicate view',
    bucketUnmappedEvidenceShort: 'unmapped',
    bucketLegend: 'Unsupported format: the adapter cannot read the record, which is a real capability gap. Duplicate view ignored: another view already carried this fact, or the record is a cumulative snapshot, so mapping it again would double count — no event is produced on purpose. Evidence pending mapping: the record family is recognized, but what event it should become is undecided; the raw evidence stays in the log.',
    size: 'Size',
    modifiedAt: 'Log updated',
    artifact: 'Normalized artifact',
    inventoryMissing: 'No agent inventory yet. Run omk agents list in a terminal; it writes into this machine’s agent directory.',
    inventoryUnreadable: 'The inventory report cannot be read, and the page does not guess what it said. Re-run omk agents list to overwrite it.',
    collectionMissing: 'No logs collected yet. Run omk agents list first, then omk agents collect.',
    collectionUnreadable: 'The collection report cannot be read, and the page does not reuse older artifacts as a substitute. Re-run omk agents collect.',
    collectionOutdated: (version: string) => `The collection report is written in the ${version} scheme, whose unrecognized-event buckets cannot be carried over. Run omk agents collect to recollect under the current scheme, which rewrites it.`,
    truncatedWarning: 'Some log roots hit a capacity ceiling, so these counts cover what was scanned, not everything.',
    limitationsHeading: 'Limitations of this collection',
    unknownRatioWarning: (percent: string) => `${percent} of the normalized records are in an unsupported format and survive only as raw records. Unrecognized is not the same as harmless — read the source log before judging.`,
    nextList: [
      { command: 'omk agents list', text: 'Detect installed agents and their log roots again.' },
      { command: 'omk agents collect', text: 'Collect session logs incrementally into normalized Trace IR artifacts.' },
      { command: 'omk agents extract --session <runId>', text: 'Extract entities and candidate knowledge from one collected session.' },
    ],
    candidatesLink: 'Review extracted candidates',
  },
} as const;

function RootList({ roots, lang }: { roots: readonly AgentLogRootStatus[]; lang: Language }) {
  const c = COPY[lang];
  return (
    <Table<AgentLogRootStatus>
      size="small"
      rowKey={(root) => root.path}
      pagination={false}
      dataSource={[...roots]}
      columns={[
        {
          title: c.rootPath,
          dataIndex: 'path',
          key: 'path',
          ellipsis: true,
          render: (path: string) => <Typography.Text code title={path}>{path}</Typography.Text>,
        },
        { title: c.sourceKind, dataIndex: 'traceSourceKind', key: 'traceSourceKind', width: 120 },
        { title: c.rootCount, dataIndex: 'sessionFileCount', key: 'sessionFileCount', width: 90 },
        { title: c.rootBytes, dataIndex: 'totalBytes', key: 'totalBytes', width: 100, render: (bytes: number) => displayBytes(bytes) },
        {
          title: c.rootNewest,
          key: 'newest',
          width: 160,
          render: (_, root) => (root.newestModifiedAt ? displayTime(root.newestModifiedAt, 'minute') : '—'),
        },
        {
          title: c.rootState,
          key: 'state',
          width: 160,
          render: (_, root) => (
            <>
              {!root.exists ? <Tag>{c.rootAbsent}</Tag> : null}
              {root.exists && !root.readable ? <Tag color="orange">{c.unreadable}</Tag> : null}
              {root.truncated ? <Tag color="orange">{c.truncated}</Tag> : null}
              {root.exists && root.readable && !root.truncated ? <Tag color="green">OK</Tag> : null}
            </>
          ),
        },
      ]}
    />
  );
}

function DetectedTable({ report, lang }: { report: AgentInventoryReport; lang: Language }) {
  const c = COPY[lang];
  return (
    <Table<DetectedAgent>
      className="studio-table agents-inventory-table"
      tableLayout="fixed"
      scroll={{ x: 1080 }}
      rowKey={(agent) => agent.agentId}
      pagination={false}
      dataSource={[...report.agents]}
      expandable={{
        // 未安装的 Agent 没有日志根可展开，不给一个按下只会显示空表的开关。
        rowExpandable: (agent) => agent.logRoots.length > 0,
        expandedRowRender: (agent) => <RootList roots={agent.logRoots} lang={lang} />,
      }}
      columns={[
        { title: c.agent, dataIndex: 'displayName', key: 'displayName' },
        { title: c.vendor, dataIndex: 'vendor', key: 'vendor', width: 140 },
        {
          title: c.installed,
          dataIndex: 'installed',
          key: 'installed',
          width: 110,
          render: (installed: boolean) => <Tag color={installed ? 'green' : 'default'}>{installed ? c.installed : c.notInstalled}</Tag>,
        },
        {
          title: c.sourceKind,
          dataIndex: 'traceSourceKind',
          key: 'traceSourceKind',
          width: 130,
          render: (kind: string | null) => (kind ?? <Typography.Text type="secondary">{c.noSourceKind}</Typography.Text>),
        },
        { title: c.sessionFiles, dataIndex: 'sessionFileCount', key: 'sessionFileCount', width: 110 },
        {
          title: c.evidence,
          key: 'evidence',
          width: 420,
          ellipsis: true,
          render: (_, agent) => {
            if (agent.evidence.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
            const text = agent.evidence.map((entry) => `${entry.via}:${entry.path}`).join(' · ');
            return <Typography.Text code title={text}>{text}</Typography.Text>;
          },
        },
      ]}
    />
  );
}

type BucketLabelCopy = {
  readonly bucketUnsupportedShort: string;
  readonly bucketDuplicateViewShort: string;
  readonly bucketUnmappedEvidenceShort: string;
};

function unknownBucketBreakdown(session: CollectedSession, c: BucketLabelCopy): string {
  return `${c.bucketUnsupportedShort} ${session.unknownEventCount}`
    + ` · ${c.bucketDuplicateViewShort} ${session.duplicateViewCount}`
    + ` · ${c.bucketUnmappedEvidenceShort} ${session.unmappedEvidenceCount}`;
}

function SessionTable({ report, lang }: { report: AgentCollectionReport; lang: Language }) {
  const c = COPY[lang];
  return (
    <Table<CollectedSession>
      className="studio-table agents-collection-table"
      rowKey={(session) => session.traceId}
      pagination={{ pageSize: 20, hideOnSinglePage: true }}
      tableLayout="fixed"
      scroll={{ x: 1470 }}
      dataSource={[...report.sessions]}
      columns={[
        { title: c.agent, dataIndex: 'agentId', key: 'agentId', width: 140 },
        {
          title: c.sessionTitle,
          dataIndex: 'title',
          key: 'title',
          width: 340,
          ellipsis: true,
          render: (title: string | undefined, session) => (title
            ? <Typography.Text title={title}>{title}</Typography.Text>
            : <Typography.Text code title={session.runId}>{session.runId}</Typography.Text>),
        },
        { title: c.sourceKind, dataIndex: 'sourceKind', key: 'sourceKind', width: 110 },
        { title: c.events, dataIndex: 'eventCount', key: 'eventCount', width: 90 },
        {
          title: c.unknownEvents,
          key: 'unknownEvents',
          width: 240,
          render: (_, session) => {
            const total = session.unknownEventCount + session.duplicateViewCount + session.unmappedEvidenceCount;
            if (total === 0) return '0';
            return (
              <>
                <Tag color={session.unknownEventCount > 0 ? 'red' : 'orange'} title={c.bucketLegend}>
                  {`${total} / ${session.eventCount}`}
                </Tag>
                <Typography.Text type="secondary">{unknownBucketBreakdown(session, c)}</Typography.Text>
              </>
            );
          },
        },
        { title: c.size, dataIndex: 'sizeBytes', key: 'sizeBytes', width: 100, render: (bytes: number) => displayBytes(bytes) },
        { title: c.modifiedAt, dataIndex: 'modifiedAt', key: 'modifiedAt', width: 170, render: (at: string) => displayTime(at, 'minute') },
        {
          title: c.artifact,
          dataIndex: 'artifactPath',
          key: 'artifactPath',
          ellipsis: true,
          render: (path: string) => <Typography.Text code title={path}>{path}</Typography.Text>,
        },
      ]}
    />
  );
}

/**
 * 本机 Agent 页：识别结果 + 采集记录 + 限制。
 *
 * 三份报告状态各自独立呈现：清单缺失不影响采集结果的展示，反之亦然。截断与未识别事件
 * 一律显式标出来——计数被容量上限砍过时把它当全量、把未识别事件当无事件，都会让用户
 * 以为看过的是完整事实（口径见 `src/observability/agents/contracts.ts`）。
 */
export function AgentsView({ page, lang }: { page: AgentsPage; lang: Language }) {
  const c = COPY[lang];
  const { inventory, collection, layout } = page.model;
  const inventoryReport = inventory.status === 'ready' ? inventory.report : undefined;
  const collectionReport = collection.status === 'ready' ? collection.report : undefined;
  const unknownRatio = collectionReport && collectionReport.summary.eventCount > 0
    ? `${((collectionReport.summary.unknownEventCount / collectionReport.summary.eventCount) * 100).toFixed(1)}%`
    : undefined;
  const unknownTotal = collectionReport
    ? collectionReport.summary.unknownEventCount
      + collectionReport.summary.duplicateViewCount
      + collectionReport.summary.unmappedEvidenceCount
    : 0;

  return (
    <div className="agents-page">
      <div className="agents-heading">
        <h1>{c.title}</h1>
        <p>{c.intro}</p>
      </div>

      <h2>{c.detectedHeading}</h2>
      {inventory.status === 'missing' ? <Alert type="info" showIcon title={c.inventoryMissing} /> : null}
      {inventory.status === 'unreadable' ? <Alert type="error" showIcon title={c.inventoryUnreadable} description={<Typography.Text code>{layout.observeAgentsInventoryPath}</Typography.Text>} /> : null}
      {inventoryReport ? (
        <>
          <Typography.Paragraph type="secondary">
            {c.detectedSummary(inventoryReport.summary.knownAgentCount, inventoryReport.summary.installedAgentCount, inventoryReport.summary.sessionFileCount)}
            {' · '}
            {displayTime(inventoryReport.generatedAt, 'minute')}
          </Typography.Paragraph>
          {inventoryReport.summary.truncatedRootCount > 0 ? <Alert type="warning" showIcon title={c.truncatedWarning} /> : null}
          <DetectedTable report={inventoryReport} lang={lang} />
        </>
      ) : null}

      <h2>{c.collectedHeading}</h2>
      {collection.status === 'missing' ? <Alert type="info" showIcon title={c.collectionMissing} /> : null}
      {collection.status === 'unreadable' ? <Alert type="error" showIcon title={c.collectionUnreadable} description={<Typography.Text code>{layout.observeAgentsDir}</Typography.Text>} /> : null}
      {collection.status === 'outdated' ? <Alert type="warning" showIcon title={c.collectionOutdated(collection.foundVersion)} description={<Typography.Text code>{layout.observeAgentsDir}</Typography.Text>} /> : null}
      {collectionReport ? (
        <>
          <Typography.Paragraph type="secondary">
            {c.collectedSummary(collectionReport.summary.collectedCount, collectionReport.summary.eventCount)}
            {' · '}
            {displayTime(collectionReport.generatedAt, 'minute')}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary">
            {`${c.bucketUnsupported} ${collectionReport.summary.unknownEventCount}`
              + ` · ${c.bucketDuplicateView} ${collectionReport.summary.duplicateViewCount}`
              + ` · ${c.bucketUnmappedEvidence} ${collectionReport.summary.unmappedEvidenceCount}`}
          </Typography.Paragraph>
          {unknownTotal > 0 ? <Typography.Paragraph type="secondary">{c.bucketLegend}</Typography.Paragraph> : null}
          {unknownRatio && collectionReport.summary.unknownEventCount > 0 ? <Alert type="warning" showIcon title={c.unknownRatioWarning(unknownRatio)} /> : null}
          {collectionReport.limitations.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              title={c.limitationsHeading}
              description={<ul className="agents-limitations">{collectionReport.limitations.map((line) => <li key={line}>{line}</li>)}</ul>}
            />
          ) : null}
          <SessionTable report={collectionReport} lang={lang} />
        </>
      ) : null}

      <h2>{c.nextHeading}</h2>
      <Typography.Paragraph type="secondary">{c.commandHint}</Typography.Paragraph>
      <ul className="agents-next">
        {c.nextList.map((entry) => (
          <li key={entry.command}><Typography.Text code>{entry.command}</Typography.Text> {entry.text}</li>
        ))}
      </ul>
      <Link href={KNOWLEDGE_CANDIDATES_PATH}>{c.candidatesLink}</Link>
    </div>
  );
}
