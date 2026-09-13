'use client';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Alert, Collapse, Descriptions, Empty, Input, Table, Tabs, Tag, Typography } from 'antd';
import type {
  CoreStudioAnalysisRecord,
  CoreStudioBudget,
  CoreStudioDecision,
  CoreStudioEvaluationRecord,
  CoreStudioExecutionRecord,
  CoreStudioProvenance,
  CoreStudioRunCard,
  CoreStudioRunDetail,
  CoreStudioRuntimeIdentity,
  CoreStudioUsage,
} from '../../../view-models/core-runs';
import {
  formatAssumptionCheck,
  formatBudget,
  formatCoverage,
  formatDuration,
  formatMeasurement,
  formatObservation,
  formatProvenance,
  formatRuntimeIdentity,
  formatUsage,
  statusTone,
} from '../../../application/core-run-format';
import type { Language } from '../layout/shell';

const COPY = {
  zh: {
    listTitle: '评测记录', listDescription: '查看版本差异的测量结果和证据，判断知识改动是否有效。',
    empty: '尚无评测记录。完成一次评测后，结果会显示在这里。', noMatch: '没有匹配的记录',
    search: '搜索运行或报告 ID', back: '返回评测记录', runId: '运行 ID', created: '创建时间',
    runStatus: '运行状态', evidenceStatus: '证据状态', conclusionStatus: '结论状态', status: '状态',
    replayability: '可重放性', execution: '执行', evaluation: '评价', analysis: '分析',
    classification: '最高数据分级', reportId: '报告 ID', artifactSetDigest: '产物集摘要',
    identities: '产物身份', contractDigest: '运行契约摘要', reportDigest: '报告摘要', provenance: '来源',
    plan: '测量计划', dataset: '数据集', samples: '用例数', targets: '被测版本', target: '目标',
    evaluators: '评估器', evaluator: '评估器', metrics: '指标', kind: '类型', protocol: '协议',
    implementation: '实现', executor: '执行器', measurement: '测量身份', valueType: '值类型',
    scope: '作用域', direction: '方向', unit: '单位', scale: '量尺',
    stages: '阶段与覆盖', coverage: '覆盖', records: '记录数', budget: '预算',
    bundleId: '产物包 ID', bundleDigest: '产物包摘要', parent: '父产物',
    executionRecords: '执行记录', evaluationRecords: '评价记录', sample: '用例', trial: '试次',
    trialId: '试次 ID', evaluationId: '评价 ID', runtime: '运行时', duration: '耗时', usage: '用量',
    cache: '缓存', observations: '观测', reasons: '原因码',
    analysisResults: '分析结果', resultId: '结果 ID', node: '节点', mode: '模式', result: '结果',
    exclusionCount: '排除数', outputSchema: '输出 Schema', assumptions: '假设检查', recordDigest: '记录摘要',
    decision: '决策', policy: '策略', verdict: '判定', digest: '摘要', noDecision: '本次运行尚无判定。',
    lineage: '产物谱系', document: '文档', schema: 'Schema', identityDigest: '身份摘要', documentDigest: '文档摘要',
    scopeTab: '评测范围', evidenceTab: '证据与定义',
    hint: '运行完成不代表改动有效；需要结合证据与结论判断。',
    none: '无', notAvailable: '—',
  },
  en: {
    listTitle: 'Evaluations', listDescription: 'Review measurements and evidence to assess whether knowledge changes are effective.',
    empty: 'No evaluations yet. Completed evaluation results will appear here.', noMatch: 'No matching evaluations',
    search: 'Search run or report ID', back: 'Back to evaluations', runId: 'Run ID', created: 'Created',
    runStatus: 'Run status', evidenceStatus: 'Evidence status', conclusionStatus: 'Conclusion status', status: 'Status',
    replayability: 'Replayability', execution: 'Execution', evaluation: 'Evaluation', analysis: 'Analysis',
    classification: 'Maximum classification', reportId: 'Report ID', artifactSetDigest: 'Artifact set digest',
    identities: 'Artifact identities', contractDigest: 'Run contract digest', reportDigest: 'Report digest', provenance: 'Provenance',
    plan: 'Measurement plan', dataset: 'Dataset', samples: 'Samples', targets: 'Targets', target: 'Target',
    evaluators: 'Evaluators', evaluator: 'Evaluator', metrics: 'Metrics', kind: 'Kind', protocol: 'Protocol',
    implementation: 'Implementation', executor: 'Executor', measurement: 'Measurement identity', valueType: 'Value type',
    scope: 'Scope', direction: 'Direction', unit: 'Unit', scale: 'Scale',
    stages: 'Stages and coverage', coverage: 'Coverage', records: 'Records', budget: 'Budget',
    bundleId: 'Bundle ID', bundleDigest: 'Bundle digest', parent: 'Parent',
    executionRecords: 'Execution records', evaluationRecords: 'Evaluation records', sample: 'Sample', trial: 'Trial',
    trialId: 'Trial ID', evaluationId: 'Evaluation ID', runtime: 'Runtime', duration: 'Duration', usage: 'Usage',
    cache: 'Cache', observations: 'Observations', reasons: 'Reason codes',
    analysisResults: 'Analysis results', resultId: 'Result ID', node: 'Node', mode: 'Mode', result: 'Result',
    exclusionCount: 'Exclusions', outputSchema: 'Output schema', assumptions: 'Assumptions', recordDigest: 'Record digest',
    decision: 'Decision', policy: 'Policy', verdict: 'Verdict', digest: 'Digest', noDecision: 'This run has no decision yet.',
    lineage: 'Artifact lineage', document: 'Document', schema: 'Schema', identityDigest: 'Identity digest', documentDigest: 'Document digest',
    scopeTab: 'Evaluation scope', evidenceTab: 'Evidence and definitions',
    hint: 'A completed run does not imply an effective change. Review its evidence and conclusions.',
    none: 'None', notAvailable: '—',
  },
} as const;

// 以中文词表的键集合作为契约：英文少一个键就在调用处编译失败，中英文事实面不漂移。
type Copy = Record<keyof (typeof COPY)['zh'], string>;

/**
 * 中文词表只覆盖「表达结论的取值」。数据分级、缓存命中、来源可信度等只表达事实的取值
 * 保留原文，避免在同一条证据链上造出第二套术语。
 */
const VALUE_LABELS: Record<string, string> = {
  completed: '已完成', cancelled: '已取消', 'budget-exhausted': '预算耗尽', failed: '失败', 'budget-censored': '预算截断',
  complete: '完整', partial: '部分缺失', unresolvable: '无法解析', conclusive: '可形成结论', inconclusive: '证据不足',
  'not-evaluated': '未评估', decided: '已判定', 'not-decided': '未判定', 'within-budget': '预算内', exhausted: '已耗尽',
  unverifiable: '不可验证', observed: '已观测', missing: '缺失', invalid: '无效', passed: '通过',
  'self-contained': '自包含', resolvable: '可回溯', 'summary-only': '仅摘要',
};

function Status({ value, lang }: { value: string; lang: Language }) {
  const tone = statusTone(value);
  return <Tag color={tone === 'default' ? undefined : tone}>{lang === 'zh' ? VALUE_LABELS[value] ?? value : value}</Tag>;
}

function Code({ value }: { value: string | number }) {
  return <code className="measure-code">{value}</code>;
}

/** 等宽片段列表：指纹、摘要、覆盖计数这类需要逐字核对的事实不做行内正文排版。 */
function Fragments({ parts }: { parts: readonly string[] }) {
  if (parts.length === 0) return <>—</>;
  return <>{parts.map((part, index) => <span className="measure-fragment" key={`${part}-${index}`}><Code value={part}/></span>)}</>;
}

function Provenance({ value }: { value: CoreStudioProvenance }) {
  return <Fragments parts={formatProvenance(value)}/>;
}

function Runtime({ value }: { value: CoreStudioRuntimeIdentity }) {
  return <Fragments parts={formatRuntimeIdentity(value)}/>;
}

function Usage({ value }: { value: CoreStudioUsage | undefined }) {
  return <Fragments parts={formatUsage(value)}/>;
}

function Coverage({ value }: { value: Readonly<Record<string, number>> }) {
  return <Fragments parts={formatCoverage(value).map(([key, count]) => `${key}=${count}`)}/>;
}

function Budget({ value, lang }: { value: CoreStudioBudget; lang: Language }) {
  return <>{formatBudget(value).map(([key, part]) => <span className="measure-fragment" key={key}>
    {key === 'summaryStatus' ? <Status value={String(part)} lang={lang}/> : <Code value={`${key}=${part}`}/>}
  </span>)}</>;
}

export function RunList({ runs, lang }: { runs: CoreStudioRunCard[]; lang: Language }) {
  const [query, setQuery] = useState('');
  const copy = COPY[lang];
  const filtered = useMemo(() => runs.filter((run) => `${run.runId} ${run.reportId}`.toLowerCase().includes(query.toLowerCase())), [runs, query]);
  const suffix = lang === 'zh' ? '' : '?lang=en';
  return <>
    <div className="measure-heading"><div><h1>{copy.listTitle}</h1><p>{copy.listDescription}</p></div></div>
    <div className="measure-toolbar"><Input allowClear aria-label={copy.listTitle} placeholder={copy.search} value={query} onChange={(event) => setQuery(event.target.value)}/><Typography.Text type="secondary">{filtered.length} / {runs.length}</Typography.Text></div>
    <Table<CoreStudioRunCard> className="measure-table" size="small" rowKey="runId" dataSource={filtered} pagination={{ pageSize: 15, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: 1460 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={runs.length === 0 ? copy.empty : copy.noMatch}/> }} columns={[
      { title: copy.runId, dataIndex: 'runId', width: 220, render: (id: string) => <Link href={`/measure/${encodeURIComponent(id)}${suffix}`} className="measure-id" title={id}>{id}</Link> },
      { title: copy.runStatus, width: 110, render: (_, run) => <Status value={run.status.runStatus} lang={lang}/> },
      { title: copy.evidenceStatus, width: 130, render: (_, run) => <Status value={run.status.evidenceStatus} lang={lang}/> },
      { title: copy.conclusionStatus, width: 140, render: (_, run) => <Status value={run.status.conclusionStatus} lang={lang}/> },
      { title: copy.replayability, width: 200, render: (_, run) => <span><Status value={run.replayability.execution} lang={lang}/> <Status value={run.replayability.evaluation} lang={lang}/></span> },
      { title: copy.classification, width: 130, render: (_, run) => <Status value={run.maximumCapturedClassification} lang={lang}/> },
      { title: copy.reportId, dataIndex: 'reportId', width: 180, ellipsis: true, render: (value: string) => <span title={value}>{value}</span> },
      { title: copy.artifactSetDigest, dataIndex: 'artifactSetDigest', width: 230, ellipsis: true, render: (value: string) => <code className="measure-code" title={value}>{value}</code> },
      { title: copy.created, dataIndex: 'createdAt', width: 200, sorter: (a, b) => a.createdAt.localeCompare(b.createdAt), defaultSortOrder: 'descend', render: (value: string) => <time dateTime={value}>{value}</time> },
    ]}/>
  </>;
}

function Axes({ run, copy, lang }: { run: CoreStudioRunCard; copy: Copy; lang: Language }) {
  return <div className="measure-state-axes" role="group" aria-label={copy.status}>
    <div>{copy.runStatus}<Status value={run.status.runStatus} lang={lang}/></div>
    <div>{copy.evidenceStatus}<Status value={run.status.evidenceStatus} lang={lang}/></div>
    <div>{copy.conclusionStatus}<Status value={run.status.conclusionStatus} lang={lang}/></div>
  </div>;
}

function Identities({ detail, copy, lang }: { detail: CoreStudioRunDetail; copy: Copy; lang: Language }) {
  const { run } = detail;
  return <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
    { key: 'runId', label: copy.runId, children: <span className="measure-id">{run.runId}</span> },
    { key: 'reportId', label: copy.reportId, children: <Code value={run.reportId}/> },
    { key: 'contract', label: copy.contractDigest, children: <Code value={run.runContractDigest}/> },
    { key: 'report', label: copy.reportDigest, children: <Code value={run.reportDigest}/> },
    { key: 'set', label: copy.artifactSetDigest, children: <Code value={run.artifactSetDigest}/> },
    { key: 'replay', label: copy.replayability, children: <span>{copy.execution} <Status value={run.replayability.execution} lang={lang}/> · {copy.evaluation} <Status value={run.replayability.evaluation} lang={lang}/></span> },
    { key: 'classification', label: copy.classification, children: <Status value={run.maximumCapturedClassification} lang={lang}/> },
    { key: 'provenance', label: copy.provenance, children: <Provenance value={detail.reportProvenance}/> },
  ]}/>;
}

/** 面板内并列的多张表：表名由标题元素给出，不依赖组件库的 caption 能力。 */
function TableBlock({ label, children }: { label: string; children: ReactNode }) {
  return <div className="measure-table-block"><h3>{label}</h3>{children}</div>;
}

function Plan({ detail, copy }: { detail: CoreStudioRunDetail; copy: Copy }) {
  const emptyText = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.none}/>;
  return <section className="measure-plan">
    <h3>{copy.plan}</h3>
    <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
      { key: 'dataset', label: copy.dataset, children: <span><Code value={detail.dataset.datasetId}/> <Code value={detail.dataset.datasetRevisionDigest}/></span> },
      { key: 'samples', label: copy.samples, children: detail.dataset.sampleCount },
    ]}/>
    <TableBlock label={copy.targets}><Table className="measure-table" size="small" rowKey="targetId" pagination={false} scroll={{ x: 620 }} dataSource={[...detail.targets]} locale={{ emptyText }} columns={[
      { title: 'ID', dataIndex: 'targetId', width: 200 },
      { title: copy.kind, dataIndex: 'targetKind', width: 140 },
      { title: copy.protocol, dataIndex: 'protocolId', width: 150 },
      { title: copy.executor, dataIndex: 'executorId', width: 130 },
    ]}/></TableBlock>
    <TableBlock label={copy.evaluators}><Table className="measure-table" size="small" rowKey="evaluatorId" pagination={false} scroll={{ x: 820 }} dataSource={[...detail.evaluators]} locale={{ emptyText }} columns={[
      { title: 'ID', dataIndex: 'evaluatorId', width: 190 },
      { title: copy.kind, dataIndex: 'evaluatorKind', width: 130 },
      { title: copy.implementation, dataIndex: 'implementationId', width: 190, ellipsis: true },
      { title: copy.metrics, dataIndex: 'metricIds', render: (values: readonly string[]) => <Fragments parts={values}/> },
      { title: copy.measurement, width: 250, render: (_, evaluator) => <Code value={formatMeasurement(evaluator.measurement)}/> },
    ]}/></TableBlock>
    <TableBlock label={copy.metrics}><Table className="measure-table" size="small" rowKey="metricId" pagination={false} scroll={{ x: 760 }} dataSource={[...detail.metrics]} locale={{ emptyText }} columns={[
      { title: 'ID', dataIndex: 'metricId', width: 180 },
      { title: copy.valueType, dataIndex: 'valueType', width: 110 },
      { title: copy.scope, dataIndex: 'scope', width: 110 },
      { title: copy.direction, width: 150, render: (_, metric) => metric.direction ?? copy.notAvailable },
      { title: copy.unit, width: 100, render: (_, metric) => metric.unit ?? copy.notAvailable },
      { title: copy.scale, render: (_, metric) => metric.scale ? <Code value={JSON.stringify(metric.scale)}/> : copy.notAvailable },
    ]}/></TableBlock>
  </section>;
}

function StageCard({ title, stage, parent, copy, lang }: {
  title: string;
  stage: CoreStudioRunDetail['stages']['execution'] | CoreStudioRunDetail['stages']['evaluation'] | CoreStudioRunDetail['stages']['analysis'];
  parent: string | undefined;
  copy: Copy;
  lang: Language;
}) {
  const replayability = 'replayability' in stage ? stage.replayability : undefined;
  return <div className="measure-stage">
    <h3>{title}</h3>
    <Descriptions size="small" column={1} bordered items={[
      { key: 'status', label: copy.status, children: <Status value={stage.stageStatus} lang={lang}/> },
      { key: 'coverage', label: copy.coverage, children: <Coverage value={stage.coverage}/> },
      { key: 'records', label: copy.records, children: stage.records.length },
      { key: 'provenance', label: copy.provenance, children: <Provenance value={stage.provenance}/> },
      ...(replayability === undefined ? [] : [{ key: 'replay', label: copy.replayability, children: <Status value={replayability} lang={lang}/> }]),
      ...('budget' in stage ? [{ key: 'budget', label: copy.budget, children: <Budget value={stage.budget} lang={lang}/> }] : []),
      { key: 'bundleId', label: copy.bundleId, children: <Code value={stage.bundleId}/> },
      { key: 'bundleDigest', label: copy.bundleDigest, children: <Code value={stage.bundleDigest}/> },
      ...(parent === undefined ? [] : [{ key: 'parent', label: copy.parent, children: <Code value={parent}/> }]),
    ]}/>
  </div>;
}

function DecisionPanel({ decision, copy, lang }: { decision: CoreStudioDecision | undefined; copy: Copy; lang: Language }) {
  if (!decision) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.noDecision}/>;
  return <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} items={[
    { key: 'policy', label: copy.policy, children: <Code value={decision.decisionPolicyId}/> },
    { key: 'status', label: copy.status, children: <Status value={decision.decisionStatus} lang={lang}/> },
    { key: 'verdict', label: copy.verdict, children: decision.verdict ?? copy.notAvailable },
    { key: 'reasons', label: copy.reasons, children: decision.reasonCodes?.join(', ') || decision.errorCode || copy.notAvailable },
    { key: 'runtime', label: copy.runtime, children: <Runtime value={decision.implementation}/> },
    { key: 'analysis', label: copy.analysisResults, children: <Fragments parts={decision.analysisResultIds}/> },
    { key: 'digest', label: copy.digest, children: <Code value={decision.decisionDigest}/> },
  ]}/>;
}

function ExecutionRecords({ records, copy, lang }: { records: readonly CoreStudioExecutionRecord[]; copy: Copy; lang: Language }) {
  const emptyText = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.none}/>;
  return <Table className="measure-table" size="small" rowKey="trialId" pagination={false} scroll={{ x: 1620 }} dataSource={[...records]} locale={{ emptyText }} columns={[
    { title: copy.target, dataIndex: 'targetId', width: 140, ellipsis: true },
    { title: copy.sample, dataIndex: 'sampleId', width: 140, ellipsis: true },
    { title: copy.trial, dataIndex: 'trialIndex', width: 70 },
    { title: copy.trialId, dataIndex: 'trialId', width: 160, ellipsis: true },
    { title: copy.status, dataIndex: 'executionStatus', width: 120, render: (value: string) => <Status value={value} lang={lang}/> },
    { title: copy.runtime, width: 320, render: (_, record) => <Runtime value={record.runtime}/> },
    { title: copy.provenance, width: 240, render: (_, record) => <Provenance value={record.provenance}/> },
    { title: copy.cache, width: 120, render: (_, record) => record.cacheStatus ?? copy.notAvailable },
    { title: copy.duration, width: 100, render: (_, record) => record.durationMs === undefined ? copy.notAvailable : formatDuration(record.durationMs) },
    { title: copy.usage, width: 210, render: (_, record) => <Usage value={record.usage}/> },
    { title: copy.reasons, width: 180, ellipsis: true, render: (_, record) => record.errorCode ?? record.censorReasonCode ?? copy.notAvailable },
  ]}/>;
}

function EvaluationRecords({ records, copy, lang }: { records: readonly CoreStudioEvaluationRecord[]; copy: Copy; lang: Language }) {
  const emptyText = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.none}/>;
  return <Table className="measure-table" size="small" rowKey="evaluationId" pagination={false} scroll={{ x: 1960 }} dataSource={[...records]} locale={{ emptyText }} columns={[
    { title: copy.evaluationId, dataIndex: 'evaluationId', width: 180, ellipsis: true },
    { title: copy.target, dataIndex: 'targetId', width: 140, ellipsis: true },
    { title: copy.sample, dataIndex: 'sampleId', width: 140, ellipsis: true },
    { title: copy.trial, dataIndex: 'trialIndex', width: 70 },
    { title: copy.trialId, dataIndex: 'trialId', width: 160, ellipsis: true },
    { title: copy.evaluator, dataIndex: 'evaluatorId', width: 160, ellipsis: true },
    { title: copy.measurement, width: 250, render: (_, record) => <Code value={formatMeasurement(record.measurement)}/> },
    { title: copy.status, dataIndex: 'evaluationStatus', width: 120, render: (value: string) => <Status value={value} lang={lang}/> },
    { title: copy.runtime, width: 320, render: (_, record) => <Runtime value={record.runtime}/> },
    { title: copy.provenance, width: 240, render: (_, record) => <Provenance value={record.provenance}/> },
    { title: copy.cache, width: 120, render: (_, record) => record.cacheStatus ?? copy.notAvailable },
    { title: copy.duration, width: 100, render: (_, record) => record.durationMs === undefined ? copy.notAvailable : formatDuration(record.durationMs) },
    { title: copy.usage, width: 210, render: (_, record) => <Usage value={record.usage}/> },
    { title: copy.observations, width: 280, render: (_, record) => record.observations.length === 0 ? copy.none : <Fragments parts={record.observations.map(formatObservation)}/> },
    { title: copy.reasons, width: 180, ellipsis: true, render: (_, record) => record.errorCode ?? record.notEvaluatedReasonCode ?? copy.notAvailable },
  ]}/>;
}

function AnalysisRecords({ records, copy, lang }: { records: readonly CoreStudioAnalysisRecord[]; copy: Copy; lang: Language }) {
  const emptyText = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.none}/>;
  return <Table className="measure-table" size="small" rowKey="resultId" pagination={false} scroll={{ x: 1680 }} dataSource={[...records]} locale={{ emptyText }} columns={[
    { title: copy.resultId, dataIndex: 'resultId', width: 170, ellipsis: true },
    { title: copy.node, dataIndex: 'nodeId', width: 160, ellipsis: true },
    { title: copy.kind, dataIndex: 'analysisNodeKind', width: 110 },
    { title: copy.mode, dataIndex: 'analysisMode', width: 130 },
    { title: copy.status, dataIndex: 'analysisStatus', width: 130, render: (value: string) => <Status value={value} lang={lang}/> },
    { title: copy.result, width: 120, render: (_, record) => record.numericValue ?? record.resultType ?? copy.notAvailable },
    { title: copy.exclusionCount, dataIndex: 'exclusionCount', width: 90 },
    { title: copy.coverage, width: 240, render: (_, record) => <Coverage value={record.coverage}/> },
    { title: copy.runtime, width: 320, render: (_, record) => <Runtime value={record.runtime}/> },
    { title: copy.outputSchema, width: 220, render: (_, record) => <Code value={`${record.outputSchema.schemaVersion} · ${record.outputSchema.schemaDigest}`}/> },
    { title: copy.assumptions, width: 250, render: (_, record) => record.assumptionChecks.map(formatAssumptionCheck).join(' · ') || copy.none },
    { title: copy.reasons, width: 180, ellipsis: true, render: (_, record) => [...(record.reasonCodes ?? []), ...(record.errorCode ? [record.errorCode] : [])].join(', ') || copy.notAvailable },
    { title: copy.recordDigest, width: 200, ellipsis: true, render: (_, record) => <code className="measure-code" title={record.recordDigest}>{record.recordDigest}</code> },
  ]}/>;
}

function Lineage({ detail, copy }: { detail: CoreStudioRunDetail; copy: Copy }) {
  return <Table className="measure-table" size="small" rowKey={(entry) => `${entry.documentKind}-${entry.identityDigest}`} pagination={false} scroll={{ x: 780 }} dataSource={[...detail.lineage]} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={copy.none}/> }} columns={[
    { title: copy.document, dataIndex: 'documentKind', width: 170 },
    { title: copy.schema, dataIndex: 'schemaVersion', width: 130 },
    { title: copy.identityDigest, dataIndex: 'identityDigest', render: (value: string) => <code className="measure-code" title={value}>{value}</code> },
    { title: copy.documentDigest, dataIndex: 'documentDigest', render: (value: string) => <code className="measure-code" title={value}>{value}</code> },
  ]}/>;
}

export function RunDetail({ detail, lang }: { detail: CoreStudioRunDetail; lang: Language }) {
  const copy = COPY[lang];
  const suffix = lang === 'zh' ? '' : '?lang=en';
  const { run, stages } = detail;
  // Tabs／Collapse 默认只服务端渲染展开的那一块，证据必须整份在文档里，不靠点开才拉。
  const scopePanel = <div className="measure-tab">
    <Plan detail={detail} copy={copy}/>
    <h3>{copy.stages}</h3><div className="measure-stages">
      <StageCard title={copy.execution} stage={stages.execution} parent={undefined} copy={copy} lang={lang}/>
      <StageCard title={copy.evaluation} stage={stages.evaluation} parent={stages.evaluation.parentExecutionBundleDigest} copy={copy} lang={lang}/>
      <StageCard title={copy.analysis} stage={stages.analysis} parent={stages.analysis.parentEvaluationBundleDigest} copy={copy} lang={lang}/>
    </div>
  </div>;
  return <>
    <div className="measure-heading"><div><Link href={`/measure${suffix}`}>{copy.back}</Link><h1 className="measure-id" title={run.runId}>{run.runId}</h1><p><time dateTime={run.createdAt}>{run.createdAt}</time></p></div></div>
    <Axes run={run} copy={copy} lang={lang}/>
    <Alert className="measure-hint" type="info" showIcon title={copy.hint}/>
    <section className="measure-section measure-decision"><h2>{copy.decision}</h2><DecisionPanel decision={detail.decision} copy={copy} lang={lang}/></section>
    <Tabs className="studio-detail-tabs" items={[
      { key: 'scope', label: copy.scopeTab, forceRender: true, children: scopePanel },
      { key: 'analysis', label: copy.analysisResults, forceRender: true, children: <AnalysisRecords records={stages.analysis.records} copy={copy} lang={lang}/> },
      { key: 'evidence', label: copy.evidenceTab, forceRender: true, children: <Collapse items={[
        { key: 'identities', label: copy.identities, forceRender: true, children: <Identities detail={detail} copy={copy} lang={lang}/> },
        { key: 'execution', label: copy.executionRecords, forceRender: true, children: <ExecutionRecords records={stages.execution.records} copy={copy} lang={lang}/> },
        { key: 'evaluation', label: copy.evaluationRecords, forceRender: true, children: <EvaluationRecords records={stages.evaluation.records} copy={copy} lang={lang}/> },
        { key: 'lineage', label: copy.lineage, forceRender: true, children: <Lineage detail={detail} copy={copy}/> },
      ]}/> },
    ]}/>
  </>;
}
