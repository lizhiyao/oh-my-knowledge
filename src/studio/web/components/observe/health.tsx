'use client';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Breadcrumb, Button, Collapse, Empty, Progress, Radio, Table, Tag, Typography } from 'antd';
import type { HealthPage } from '../../../http/health-page';
import type {
  HealthBand,
  HealthConfidence,
  HealthDiffFacts,
  HealthIndexRow,
  HealthReportFacts,
  HealthSkillFacts,
  HealthTone,
  HealthTrendFacts,
} from '../../../application/health-format';
import type { Language } from '../layout/shell';
import { ObserveSectionNav } from './section-nav';

const suffix = (lang: Language) => (lang === 'en' ? '?lang=en' : '');
const reportHref = (id: string, lang: Language) => `/observe/health/${encodeURIComponent(id)}${suffix(lang)}`;
const trendHref = (skill: string, lang: Language) => `/observe/skill-trend/${encodeURIComponent(skill)}${suffix(lang)}`;
const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');
const day = (iso: string) => iso.slice(0, 10);
/** 比率取整到百分位是展示选择；判定阈值已在服务端投影成 tone。 */
const pct = (ratio: number | null | undefined) => (ratio == null ? '—' : `${Math.round(ratio * 100)}%`);

const TONE_TAG: Record<HealthTone, 'success' | 'warning' | 'error' | 'default'> = {
  success: 'success', warning: 'warning', error: 'error', neutral: 'default',
};
/** 色带填充色：neutral 表示样本不足，不给硬色。 */
const TONE_BAR: Record<HealthTone, string> = {
  success: '#1f9d63', warning: '#d97706', error: '#dc2626', neutral: '#b0b8c5',
};
const SERIES_COLOR = { gap: '#f87171', weighted: '#fbbf24', failure: '#a78bfa', coverage: '#4ade80' } as const;

const zhCopy = {
  observeCrumb: '观测',
  listTitle: 'Skill 健康度日报',
  compareHint: '选两个报告的 from/to 单选框，点「对比」生成 diff。',
  compareBtn: '对比 →',
  compareFrom: '对比起点',
  compareTo: '对比终点',
  fromLabel: 'from',
  toLabel: 'to',
  noReportsBefore: '暂无 Skill 健康度日报。运行 ',
  noReportsAfter: ' 生成。',
  reportCommand: 'omk observe <trace-dir>',
  colReport: '报告',
  colGenerated: '生成时间',
  colHealth: '健康度',
  colSessions: '会话',
  colSegments: '段',
  colSkills: '技能',
  bandGreen: '健康',
  bandYellow: '待观察',
  bandRed: '需关注',
  lowN: '样本不足',
  confidenceLow: '可信度偏低',
  reportKind: '生产观察报告',
  timeRangeLabel: '时间窗：',
  generatedAtLabel: '生成于：',
  scoreLabel: '健康分',
  sessions: '会话',
  segments: '段',
  toolCalls: '工具调用',
  weightedGap: '加权盲区',
  sourceTitle: '数据来源',
  sourceTrace: 'trace',
  sourceKb: 'kb',
  sourceWarning: '本报告仅反映指定时间窗内观察到的 skill 使用情况，不代表 skill 的绝对质量，也不能替代 offline eval 的对照验证。',
  lowNSampleCaveat: (n: number) => `⚠ 样本量 ${n} 段，可信度不足，色带仅供参考`,
  lowConfidenceCaveat: (n: number) => `⚠ 样本量 ${n} 段，可信度偏低，色带仅供参考`,
  ingestionTitle: '观测输入需要复核',
  ingestionBody: (malformed: number, ignored: number, unknown: number) => `${malformed} 条格式损坏记录，${ignored} 个非对象值，${unknown} 个未识别事件。`,
  timestampTitle: '时间范围不完整',
  timestampBody: (timestamped: number, total: number, excluded: number) => `${total} 个入选片段中，${timestamped} 个具有可观测时间；时间筛选另排除了 ${excluded} 个无时间戳片段。`,
  perSkillTitle: '各 skill 健康度',
  perSkillSortHint: '按使用量降序',
  knowledgeUsed: '知识使用',
  knowledgeGaps: '知识盲区',
  hit: '命中',
  miss: '未命中',
  searches: '次搜索',
  noCoverage: '（未提供 KB，跳过 coverage）',
  segmentsWithSignals: '段触发信号',
  weightedGapLabel: '加权盲区',
  softSignals: '为软信号（建议复核）',
  mostlyHard: '以硬证据为主',
  veryUnstable: (rate: number) => `失败率 ${rate}%，gap 可能是环境问题`,
  unstable: (rate: number) => `失败率 ${rate}%，gap 可能含噪声`,
  cancelledOnly: '没有可比较结果，工具调用已取消',
  outcomesUnavailable: '工具结果状态不可测',
  outcomesComparable: (comparable: number, total: number, cancelled: number) => `${comparable}/${total} 次结果可比较${cancelled > 0 ? `，${cancelled} 次取消` : ''}`,
  fewOutcomes: (comparable: number) => `仅 ${comparable} 次结果，结论置信度低`,
  skillConfidence: (n: number) => `${n} 段，可信度不足，仅供参考`,
  skillConfidenceLow: (n: number) => `${n} 段，可信度偏低`,
  viewTrend: '查看趋势 →',
  signalFailedSearch: '搜索未命中',
  signalExplicitMarker: '模型标记缺口',
  signalHedging: '表达不确定',
  signalRepeatedFailure: '反复未命中',
  timesCancelled: (n: number) => `${n} 次取消`,
  timesUnknown: (n: number) => `${n} 次状态未知`,
  failedOf: (failures: number, comparable: number, rate: number) => `${failures}/${comparable} 失败（${rate}%）`,
  cancelledSuffix: (n: number) => ` · ${n} 取消`,
  noToolCalls: '0 次工具调用',
  tokens: 'tokens',
  cached: '缓存',
  coverageWord: '覆盖',
  tokensUnobserved: 'tokens —（未观测）',
  avg: '均',
  seg: '段',
  turns: '轮次',
  deadKbTitle: '死代码 KB（零访问）',
  deadKbDesc: (total: number, dead: number) => `本期共 ${total} 个 KB 文件，其中 ${dead} 个在所有 skill 里都没被访问过。建议审视这些文件是否仍有存在价值，或者测评集 / 生产使用场景是否还没覆盖到它们。`,
  trendCrumb: 'Skill 趋势',
  trendHeading: 'Skill 趋势',
  noTrendData: '暂无趋势数据。该 skill 尚未出现在任何分析报告里。',
  dataPoints: '个时间点',
  earliest: '最早',
  latest: '最新',
  chartLabel: 'Skill 健康度趋势折线',
  legendGap: 'gap rate',
  legendWeighted: 'weighted gap',
  legendFailure: 'failure rate',
  legendCoverage: 'coverage',
  colTimestamp: '时间',
  colSegs: '段数',
  colGap: 'Gap',
  colWeighted: '加权',
  colFailure: '失败率',
  colCoverage: '覆盖',
  colTokens: 'Tokens',
  colDuration: '耗时',
  comparableOutcomes: '结果可比较',
  cancelled: '取消',
  tokensHint: '仅 input+output；cache 单独计',
  diffCrumb: 'Skill 健康度对比',
  diffHeading: 'Skill 健康度对比',
  diffSortHint: '按 gap 变化量排序；绿色=改善，红色=恶化',
  diffFrom: '起点',
  diffTo: '终点',
  diffTagRemoved: '已消失',
  diffTagNew: '新增',
  diffColSkill: 'Skill',
  diffColSegments: '段数',
  diffColWeightedGap: '加权 Gap',
  diffColFailureRate: '失败率',
  diffColCoverage: '覆盖',
};

const enCopy: typeof zhCopy = {
  observeCrumb: 'Observe',
  listTitle: 'Skill Health Reports',
  compareHint: 'Pick from/to on two reports, then click Compare to generate a diff.',
  compareBtn: 'Compare →',
  compareFrom: 'Compare start',
  compareTo: 'Compare end',
  fromLabel: 'from',
  toLabel: 'to',
  noReportsBefore: 'No skill health reports yet. Run ',
  noReportsAfter: ' to generate one.',
  reportCommand: 'omk observe <trace-dir>',
  colReport: 'Report',
  colGenerated: 'Generated',
  colHealth: 'Health',
  colSessions: 'Sessions',
  colSegments: 'Segments',
  colSkills: 'Skills',
  bandGreen: 'Healthy',
  bandYellow: 'Watch',
  bandRed: 'Attention',
  lowN: 'Low N',
  confidenceLow: 'Low confidence',
  reportKind: 'Observe report',
  timeRangeLabel: 'Window: ',
  generatedAtLabel: 'Generated: ',
  scoreLabel: 'Health score',
  sessions: 'Sessions',
  segments: 'Segments',
  toolCalls: 'Tool calls',
  weightedGap: 'Weighted gap',
  sourceTitle: 'Source',
  sourceTrace: 'trace',
  sourceKb: 'kb',
  sourceWarning: 'Report reflects only observed skill usage in the given window. It does not imply absolute skill quality and does not replace offline eval.',
  lowNSampleCaveat: (n: number) => `⚠ N=${n} segments — underpowered; the band is indicative only`,
  lowConfidenceCaveat: (n: number) => `⚠ N=${n} segments — low confidence; the band is indicative`,
  ingestionTitle: 'Observation input needs review',
  ingestionBody: (malformed: number, ignored: number, unknown: number) => `${malformed} malformed records, ${ignored} non-object values, ${unknown} unrecognized events.`,
  timestampTitle: 'Incomplete time coverage',
  timestampBody: (timestamped: number, total: number, excluded: number) => `${timestamped} of ${total} selected segments have observed timestamps; time filtering excluded ${excluded} additional untimestamped segments.`,
  perSkillTitle: 'Per-skill health',
  perSkillSortHint: 'sorted by usage',
  knowledgeUsed: 'Knowledge used',
  knowledgeGaps: 'Knowledge gaps',
  hit: 'hit',
  miss: 'miss',
  searches: 'searches',
  noCoverage: '(KB not provided, coverage skipped)',
  segmentsWithSignals: 'segments with signals',
  weightedGapLabel: 'weighted gap',
  softSignals: 'soft signals (review)',
  mostlyHard: 'mostly hard evidence',
  veryUnstable: (rate: number) => `failure rate ${rate}%, gap likely an env issue`,
  unstable: (rate: number) => `failure rate ${rate}%, gap may be noisy`,
  cancelledOnly: 'no comparable outcomes; calls cancelled',
  outcomesUnavailable: 'tool outcomes unavailable',
  outcomesComparable: (comparable: number, total: number, cancelled: number) => `${comparable}/${total} outcomes comparable${cancelled > 0 ? `, ${cancelled} cancelled` : ''}`,
  fewOutcomes: (comparable: number) => `only ${comparable} outcomes, low confidence`,
  skillConfidence: (n: number) => `N=${n}, underpowered — indicative only`,
  skillConfidenceLow: (n: number) => `N=${n}, low confidence`,
  viewTrend: 'trend →',
  signalFailedSearch: 'Search miss',
  signalExplicitMarker: 'Model-flagged gap',
  signalHedging: 'Hedging',
  signalRepeatedFailure: 'Repeated miss',
  timesCancelled: (n: number) => `${n} cancelled`,
  timesUnknown: (n: number) => `${n} unknown outcomes`,
  failedOf: (failures: number, comparable: number, rate: number) => `${failures}/${comparable} failed (${rate}%)`,
  cancelledSuffix: (n: number) => ` · ${n} cancelled`,
  noToolCalls: '0 tool calls',
  tokens: 'tokens',
  cached: 'cached',
  coverageWord: 'coverage',
  tokensUnobserved: 'tokens — (unobserved)',
  avg: 'avg',
  seg: 'seg',
  turns: 'turns',
  deadKbTitle: 'Dead KB (never accessed)',
  deadKbDesc: (total: number, dead: number) => `Of ${total} KB files in this window, ${dead} were never accessed by any skill. Review them for relevance, or check whether eval and production scenarios cover them at all.`,
  trendCrumb: 'Skill trend',
  trendHeading: 'Skill trend',
  noTrendData: 'No trend data. This skill has not appeared in any analysis report yet.',
  dataPoints: 'data points',
  earliest: 'earliest',
  latest: 'latest',
  chartLabel: 'Skill health trend chart',
  legendGap: 'gap rate',
  legendWeighted: 'weighted gap',
  legendFailure: 'failure rate',
  legendCoverage: 'coverage',
  colTimestamp: 'Timestamp',
  colSegs: 'Segments',
  colGap: 'Gap',
  colWeighted: 'Weighted',
  colFailure: 'Failure',
  colCoverage: 'Coverage',
  colTokens: 'Tokens',
  colDuration: 'Duration',
  comparableOutcomes: 'comparable',
  cancelled: 'cancelled',
  tokensHint: 'input+output only; cache counted separately',
  diffCrumb: 'Skill health diff',
  diffHeading: 'Skill health diff',
  diffSortHint: 'Sorted by |Δgap|; green=improved, red=regressed',
  diffFrom: 'from',
  diffTo: 'to',
  diffTagRemoved: 'removed',
  diffTagNew: 'new',
  diffColSkill: 'Skill',
  diffColSegments: 'Segments',
  diffColWeightedGap: 'Weighted gap',
  diffColFailureRate: 'Failure rate',
  diffColCoverage: 'Coverage',
};

const COPY: Record<Language, typeof zhCopy> = { zh: zhCopy, en: enCopy };

const SIGNAL_LABEL_KEY = {
  failed_search: 'signalFailedSearch',
  explicit_marker: 'signalExplicitMarker',
  hedging: 'signalHedging',
  repeated_failure: 'signalRepeatedFailure',
} as const;

function BandTag({ tone, label }: { tone: HealthTone; label: string }) {
  return <Tag color={TONE_TAG[tone]}>{label}</Tag>;
}

function bandLabel(band: HealthBand, confidence: HealthConfidence, copy: typeof zhCopy): string {
  if (confidence === 'underpowered') return copy.lowN;
  return band === 'green' ? copy.bandGreen : band === 'yellow' ? copy.bandYellow : copy.bandRed;
}

export function HealthView({ page, lang }: { page: HealthPage; lang: Language }) {
  if (page.pageKind === 'index') return <HealthIndex rows={page.rows} lang={lang}/>;
  if (page.pageKind === 'report') return <HealthReport report={page.report} lang={lang}/>;
  if (page.pageKind === 'trend') return <TrendPage trend={page.trend} lang={lang}/>;
  return <DiffPage diff={page.diff} lang={lang}/>;
}

function HealthIndex({ rows, lang }: { rows: HealthIndexRow[]; lang: Language }) {
  const copy = COPY[lang];
  const [from, setFrom] = useState<string>();
  const [to, setTo] = useState<string>();
  const ready = from !== undefined && to !== undefined && from !== to;
  const diffHref = ready
    ? `/observe/health-diff?${new URLSearchParams({ from: from as string, to: to as string, ...(lang === 'en' ? { lang: 'en' } : {}) })}`
    : undefined;
  return <>
    <ObserveSectionNav active="health" lang={lang}/>
    <div className="observe-toolbar">
      <Typography.Text type="secondary">{copy.compareHint}</Typography.Text>
      <div className="observe-toolbar-actions">
        <Button type="primary" disabled={!ready} href={diffHref}>{copy.compareBtn}</Button>
      </div>
    </div>
    <Table<HealthIndexRow>
      className="measure-table health-table"
      size="small"
      rowKey="id"
      tableLayout="fixed"
      scroll={{ x: 900 }}
      dataSource={rows}
      pagination={{ pageSize: 20, showSizeChanger: false, hideOnSinglePage: true }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span>{copy.noReportsBefore}<code>{copy.reportCommand}</code>{copy.noReportsAfter}</span>}/> }}
      columns={[
        {
          title: copy.fromLabel,
          width: 64,
          render: (_, row) => <Radio aria-label={`${copy.compareFrom} ${row.id}`} checked={from === row.id} onChange={() => setFrom(row.id)}/>,
        },
        {
          title: copy.toLabel,
          width: 64,
          render: (_, row) => <Radio aria-label={`${copy.compareTo} ${row.id}`} checked={to === row.id} onChange={() => setTo(row.id)}/>,
        },
        {
          title: copy.colReport,
          ellipsis: true,
          render: (_, row) => <Link href={reportHref(row.id, lang)} title={row.id}>{row.id}</Link>,
        },
        { title: copy.colGenerated, width: 170, render: (_, row) => <span className="health-stamp">{stamp(row.generatedAt)}</span> },
        { title: copy.colHealth, width: 130, render: (_, row) => <BandTag tone={row.tone} label={bandLabel(row.healthBand, row.confidence, copy)}/> },
        { title: copy.colSessions, width: 90, align: 'right', dataIndex: 'sessionCount' },
        { title: copy.colSegments, width: 90, align: 'right', dataIndex: 'segmentCount' },
        { title: copy.colSkills, width: 90, align: 'right', dataIndex: 'skillCount' },
      ]}
    />
  </>;
}

/** 工具成败一句话与它的稳定性着色：折叠标题和面板体共用，避免同一 skill 在两处给出口径不同的读数。 */
function failureFacts(skill: HealthSkillFacts, lang: Language): { label: string; tone: HealthTone } {
  const copy = COPY[lang];
  const { tools } = skill;
  const label = tools.total > 0 && tools.comparable === 0
    ? (tools.cancelled > 0 && tools.unknown === 0
      ? copy.timesCancelled(tools.cancelled)
      : tools.cancelled > 0
        ? `${copy.timesCancelled(tools.cancelled)} · ${copy.timesUnknown(tools.unknown)}`
        : copy.timesUnknown(tools.total))
    : tools.failureRatePercent === null
      ? copy.noToolCalls
      : `${copy.failedOf(tools.failures, tools.comparable, tools.failureRatePercent)}${tools.cancelled > 0 ? copy.cancelledSuffix(tools.cancelled) : ''}`;
  const tone: HealthTone = tools.stability === 'very-unstable'
    ? 'error'
    : tools.stability === 'unstable' ? 'warning' : 'neutral';
  return { label, tone };
}

function SkillPanel({ skill, lang }: { skill: HealthSkillFacts; lang: Language }) {
  const copy = COPY[lang];
  const { gap, coverage, tools, usage } = skill;
  const stabilityNote = tools.stability === 'very-unstable' && tools.failureRatePercent !== null
    ? copy.veryUnstable(tools.failureRatePercent)
    : tools.stability === 'unstable' && tools.failureRatePercent !== null
      ? copy.unstable(tools.failureRatePercent)
      : tools.stability === 'unknown'
        ? (tools.cancelled > 0 ? copy.cancelledOnly : copy.outcomesUnavailable)
        : undefined;
  const outcomeNote = tools.stability === 'unknown'
    ? undefined
    : tools.cancelled > 0 || tools.unknown > 0
      ? copy.outcomesComparable(tools.comparable, tools.total, tools.cancelled)
      : tools.comparable > 0 && tools.comparable < 5
        ? copy.fewOutcomes(tools.comparable)
        : undefined;
  const confidenceNote = skill.confidence !== 'high'
    ? (skill.confidence === 'underpowered' ? copy.skillConfidence(skill.segmentCount) : copy.skillConfidenceLow(skill.segmentCount))
    : undefined;
  const weightedHint = [
    gap.softSharePercent >= 10
      ? `${copy.weightedGapLabel} ${gap.weightedPercent}% · ${gap.softSharePercent}% ${copy.softSignals}`
      : `${copy.weightedGapLabel} ${gap.weightedPercent}% · ${copy.mostlyHard}`,
    stabilityNote,
    outcomeNote,
    confidenceNote,
  ].filter((line): line is string => line !== undefined).join(' · ');
  const tokenText = usage.tokenCoverage > 0
    ? `${(usage.billableTokens / 1000).toFixed(1)}k ${copy.tokens}${usage.cachedTokens > 0 ? ` + ${(usage.cachedTokens / 1000).toFixed(1)}k ${copy.cached}` : ''}${usage.tokenCoverage < 1 ? ` (${Math.round(usage.tokenCoverage * 100)}% ${copy.coverageWord})` : ''}`
    : copy.tokensUnobserved;
  const usageLine = [
    tokenText,
    `${(usage.durationMs / 1000).toFixed(1)}s (${copy.avg} ${(usage.avgDurationMsPerSegment / 1000).toFixed(1)}s/${copy.seg})`,
    `${usage.numTurns} ${copy.turns}`,
  ].join(' · ');
  const failure = failureFacts(skill, lang);
  return <div className="health-skill">
    <div className="health-skill-head">
      <Typography.Text className={`health-skill-failure tone-${failure.tone}`}>{failure.label}</Typography.Text>
      <Link href={trendHref(skill.skillName, lang)}>{copy.viewTrend}</Link>
    </div>
    <Typography.Text className="health-skill-usage" type="secondary">{usageLine}</Typography.Text>
    <div className="health-skill-metrics">
      <section className="health-metric">
        <div className="health-metric-head"><span>{copy.knowledgeUsed}</span><Typography.Text className={`tone-${coverage?.tone ?? 'neutral'}`}>{coverage ? `${coverage.percent}%` : '—'}</Typography.Text></div>
        {coverage
          ? <>
            <Progress percent={coverage.percent} showInfo={false} size="small" strokeColor={TONE_BAR[coverage.tone]} aria-label={copy.knowledgeUsed}/>
            <Typography.Text type="secondary" className="health-metric-facts">{coverage.filesCovered} {copy.hit} · {coverage.filesMissed} {copy.miss} · {coverage.searches} {copy.searches}</Typography.Text>
          </>
          : <Typography.Text type="secondary">{copy.noCoverage}</Typography.Text>}
      </section>
      <section className="health-metric">
        <div className="health-metric-head"><span>{copy.knowledgeGaps}</span><Typography.Text className={`tone-${gap.tone}`}>{gap.percent}%</Typography.Text></div>
        <Progress percent={gap.percent} showInfo={false} size="small" strokeColor={TONE_BAR[gap.tone]} aria-label={copy.knowledgeGaps}/>
        <Typography.Text type="secondary" className="health-metric-facts">{gap.samplesWithGap}/{gap.sampleCount} {copy.segmentsWithSignals}</Typography.Text>
        <Typography.Text className="health-metric-hint">{weightedHint}</Typography.Text>
        <div className="health-signals">
          {gap.signals.map(([type, count]) => <Tag key={type}>{copy[SIGNAL_LABEL_KEY[type]]} × {count}</Tag>)}
        </div>
      </section>
    </div>
  </div>;
}

function HealthReport({ report, lang }: { report: HealthReportFacts; lang: Language }) {
  const copy = COPY[lang];
  const caveat = report.confidence === 'high'
    ? undefined
    : report.confidence === 'underpowered'
      ? copy.lowNSampleCaveat(report.segmentCount)
      : copy.lowConfidenceCaveat(report.segmentCount);
  return <>
    <header className="observe-detail-header">
      <Breadcrumb items={[
        { title: <Link href={`/observe${suffix(lang)}`}>{copy.observeCrumb}</Link> },
        { title: <Link href={`/observe/health${suffix(lang)}`}>{copy.listTitle}</Link> },
        { title: report.analysisId },
      ]}/>
      <div className="observe-detail-title">
        <h1 title={report.analysisId}>{report.analysisId}</h1>
        <span className="observe-detail-count"><BandTag tone={report.bandTone} label={bandLabel(report.band, report.confidence, copy)}/>{report.score !== null && <Typography.Text type="secondary">{copy.scoreLabel} {report.score}</Typography.Text>}</span>
      </div>
      <div className="observe-detail-meta">
        <span>{copy.reportKind}</span>
        <span>{copy.timeRangeLabel}{report.timeRange}</span>
        <span>{copy.generatedAtLabel}{report.generatedAt}</span>
      </div>
    </header>
    <div className="health-scroll">
      <div className="health-stats">
        <div className="health-stat"><Typography.Text className="health-stat-value">{report.sessionCount}</Typography.Text><Typography.Text type="secondary" className="health-stat-label">{copy.sessions}</Typography.Text></div>
        <div className="health-stat"><Typography.Text className="health-stat-value">{report.segmentCount}</Typography.Text><Typography.Text type="secondary" className="health-stat-label">{copy.segments}</Typography.Text></div>
        <div className="health-stat"><Typography.Text className="health-stat-value">{report.toolCallCount}</Typography.Text><Typography.Text type="secondary" className="health-stat-label">{copy.toolCalls}</Typography.Text></div>
        <div className="health-stat"><Typography.Text className={`health-stat-value tone-${report.weightedGapTone}`}>{report.weightedGapPercent}%</Typography.Text><Typography.Text type="secondary" className="health-stat-label">{copy.weightedGap}</Typography.Text></div>
      </div>
      {report.ingestion && <Alert
        type="warning"
        showIcon
        title={copy.ingestionTitle}
        description={copy.ingestionBody(report.ingestion.malformedRecordCount, report.ingestion.ignoredValueCount, report.ingestion.unknownEventCount)}
      />}
      {report.timestamps.incomplete && <Alert
        type="warning"
        showIcon
        title={copy.timestampTitle}
        description={copy.timestampBody(report.timestamps.timestampedSegmentCount, report.timestamps.segmentCount, report.timestamps.excludedUntimestampedSegmentCount)}
      />}
      <Alert
        type="info"
        title={copy.sourceTitle}
        description={<>{/* 轨迹与知识库路径来自报告，按文本渲染，不作为可点击资源。 */}
          <Typography.Text className="health-source-path">{copy.sourceTrace}: {report.tracePath}</Typography.Text>
          <br/>
          <Typography.Text className="health-source-path">{copy.sourceKb}: {report.kbPath ?? '—'}</Typography.Text>
          <div className="health-source-warning">{copy.sourceWarning}</div>
          {caveat && <div className="health-source-caveat">{caveat}</div>}
        </>}
      />
      <h2 className="health-section-title">{copy.perSkillTitle} <Typography.Text type="secondary" className="health-section-hint">{copy.perSkillSortHint}</Typography.Text></h2>
      {report.skills.length === 0
        ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={lang === 'zh' ? '本期无 skill 数据' : 'No skill data in this report'}/>
        : <Collapse
          className="health-skills"
          defaultActiveKey={report.skills.map((skill) => skill.skillName)}
          items={report.skills.map((skill) => ({
            key: skill.skillName,
            forceRender: true,
            label: <span className="health-skill-label">
              <strong>{skill.skillName}</strong>
              <Typography.Text type="secondary">{skill.segmentCount} {copy.segments} · {skill.gap.percent}% {copy.knowledgeGaps}</Typography.Text>
            </span>,
            children: <SkillPanel skill={skill} lang={lang}/>,
          }))}/>}
      {report.deadKb.entries.length > 0 && <section className="health-dead-kb">
        <h2>{copy.deadKbTitle}</h2>
        <Typography.Text type="secondary">{copy.deadKbDesc(report.deadKb.total, report.deadKb.entries.length)}</Typography.Text>
        <ul className="health-dead-kb-list">
          {report.deadKb.entries.map((entry) => <li key={entry.path}>
            <Typography.Text className="health-dead-path">{entry.path}</Typography.Text>
            <Tag>{entry.type}</Tag>
            {entry.lineCount !== undefined && <Typography.Text type="secondary">{entry.lineCount}L</Typography.Text>}
          </li>)}
        </ul>
      </section>}
    </div>
  </>;
}

function TrendPage({ trend, lang }: { trend: HealthTrendFacts; lang: Language }) {
  const copy = COPY[lang];
  const { points, chart } = trend;
  const legend = [
    { key: 'gap' as const, label: copy.legendGap },
    { key: 'weighted' as const, label: copy.legendWeighted },
    { key: 'failure' as const, label: copy.legendFailure },
    { key: 'coverage' as const, label: copy.legendCoverage },
  ];
  return <>
    <header className="observe-detail-header">
      <Breadcrumb items={[
        { title: <Link href={`/observe${suffix(lang)}`}>{copy.observeCrumb}</Link> },
        { title: <Link href={`/observe/health${suffix(lang)}`}>{copy.listTitle}</Link> },
        { title: copy.trendCrumb },
      ]}/>
      <div className="observe-detail-title"><h1 title={trend.skillName}>{copy.trendHeading} · {trend.skillName}</h1></div>
      {points.length > 0 && <div className="observe-detail-meta">
        <span>{points.length} {copy.dataPoints}</span>
        <span>{copy.earliest} {day(points[0].generatedAt)}</span>
        <span>{copy.latest} {day(points[points.length - 1].generatedAt)}</span>
      </div>}
    </header>
    {points.length === 0
      ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.noTrendData}/>
      : <div className="health-scroll">
        <svg
          className="health-trend-chart"
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          role="img"
          aria-label={`${copy.chartLabel} · ${trend.skillName}`}
        >
          {chart.grid.map((tick) => <g key={tick.label}>
            <line x1={40} y1={tick.y} x2={chart.width - 40} y2={tick.y} stroke="#e2e6ee"/>
            <text x={34} y={tick.y + 4} textAnchor="end" fontSize="11" fill="#657085">{tick.label}</text>
          </g>)}
          {chart.series.map((series) => <Fragment key={series.key}>
            <path d={series.line} fill="none" stroke={SERIES_COLOR[series.key]} strokeWidth={2} strokeDasharray={series.key === 'weighted' ? '4 4' : undefined}/>
            {series.dots.map((dot) => <circle key={`${series.key}-${dot.x}`} cx={dot.x} cy={dot.y} r={3} fill={SERIES_COLOR[series.key]}/>)}
          </Fragment>)}
        </svg>
        <div className="health-trend-legend">
          {legend.map((item) => <span key={item.key} style={{ color: SERIES_COLOR[item.key] }}>● {item.label}</span>)}
        </div>
        <Table
          className="measure-table health-trend-table"
          size="small"
          rowKey="analysisId"
          tableLayout="auto"
          scroll={{ x: 900 }}
          pagination={false}
          dataSource={points}
          columns={[
            { title: copy.colTimestamp, render: (_, point) => <Link className="health-stamp" href={reportHref(point.analysisId, lang)}>{stamp(point.generatedAt)}</Link> },
            { title: copy.colSegs, width: 80, align: 'right', dataIndex: 'segmentCount' },
            { title: copy.colGap, width: 80, align: 'right', render: (_, point) => pct(point.gapRate) },
            { title: copy.colWeighted, width: 80, align: 'right', render: (_, point) => pct(point.weightedGapRate) },
            {
              title: copy.colFailure,
              width: 140,
              align: 'right',
              render: (_, point) => point.failureRate === null
                ? '—'
                : <>{pct(point.failureRate)}{point.toolCallCount > 0 && <div className="health-cell-note">{point.toolComparableCount}/{point.toolCallCount} {copy.comparableOutcomes}{point.toolCancelledCount > 0 ? ` · ${point.toolCancelledCount} ${copy.cancelled}` : ''}</div>}</>,
            },
            { title: copy.colCoverage, width: 90, align: 'right', render: (_, point) => pct(point.coverageRate) },
            { title: copy.colTokens, width: 100, align: 'right', render: (_, point) => <span className="health-stamp" title={copy.tokensHint}>{(point.billableTokens / 1000).toFixed(1)}k</span> },
            { title: copy.colDuration, width: 100, align: 'right', render: (_, point) => `${(point.durationMs / 1000).toFixed(1)}s` },
          ]}
        />
      </div>}
  </>;
}

function DiffPage({ diff, lang }: { diff: HealthDiffFacts; lang: Language }) {
  const copy = COPY[lang];
  const column = (title: string, cell: (row: HealthDiffRowLike) => ReactNode, width = 190) => ({
    title,
    width,
    align: 'right' as const,
    render: (_: unknown, row: HealthDiffRowLike) => cell(row),
  });
  return <>
    <header className="observe-detail-header">
      <Breadcrumb items={[
        { title: <Link href={`/observe${suffix(lang)}`}>{copy.observeCrumb}</Link> },
        { title: <Link href={`/observe/health${suffix(lang)}`}>{copy.listTitle}</Link> },
        { title: copy.diffCrumb },
      ]}/>
      <div className="observe-detail-title"><h1>{copy.diffHeading}</h1></div>
      <div className="observe-detail-meta">
        <span>{copy.diffFrom} <Link href={reportHref(diff.fromId, lang)}>{diff.fromId}</Link> {stamp(diff.fromAt)}</span>
        <span>{copy.diffTo} <Link href={reportHref(diff.toId, lang)}>{diff.toId}</Link> {stamp(diff.toAt)}</span>
        <span>{copy.diffSortHint}</span>
      </div>
    </header>
    <Table
      className="measure-table health-diff-table"
      size="small"
      rowKey="skillName"
      tableLayout="fixed"
      scroll={{ x: 900 }}
      pagination={false}
      dataSource={diff.rows}
      locale={{ emptyText: lang === 'zh' ? '两份报告都没有 skill 数据' : 'Neither report contains skill data' }}
      columns={[
        {
          title: copy.diffColSkill,
          ellipsis: true,
          render: (_, row) => <><Link href={trendHref(row.skillName, lang)} title={row.skillName}>{row.skillName}</Link>{row.presence === 'only-from' && <Tag color="success">{copy.diffTagRemoved}</Tag>}{row.presence === 'only-to' && <Tag color="processing">{copy.diffTagNew}</Tag>}</>,
        },
        column(copy.diffColSegments, (row) => <Pair from={row.fromSegments === undefined ? null : String(row.fromSegments)} to={row.toSegments === undefined ? null : String(row.toSegments)} delta={row.deltas.segments}/>),
        column(copy.diffColWeightedGap, (row) => <Pair from={row.fromGap === undefined ? null : pct(row.fromGap)} to={row.toGap === undefined ? null : pct(row.toGap)} delta={row.deltas.gap}/>),
        column(copy.diffColFailureRate, (row) => <Pair from={row.fromFailure === undefined ? null : pct(row.fromFailure)} to={row.toFailure === undefined ? null : pct(row.toFailure)} delta={row.deltas.failure}/>),
        column(copy.diffColCoverage, (row) => <Pair from={row.fromCoverage === undefined ? null : pct(row.fromCoverage)} to={row.toCoverage === undefined ? null : pct(row.toCoverage)} delta={row.deltas.coverage}/>),
      ]}
    />
  </>;
}

type HealthDiffRowLike = HealthDiffFacts['rows'][number];

function Pair({ from, to, delta }: { from: string | null; to: string | null; delta: { text: string; tone: HealthTone } | null }) {
  return <span className="health-pair">
    <span>{from ?? '—'}</span>
    <span aria-hidden="true">→</span>
    <span>{to ?? '—'}</span>
    {delta && <Typography.Text className={`health-delta tone-${delta.tone}`}>{delta.text}</Typography.Text>}
  </span>;
}
