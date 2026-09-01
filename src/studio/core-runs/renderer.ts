import type {
  CoreStudioAnalysisRecord,
  CoreStudioBudget,
  CoreStudioRunCard,
  CoreStudioRunDetail,
} from './contracts.js';
import type { Lang } from '../../shared/language.js';
import { e, fmtDuration, layout } from '../presentation/layout.js';

export interface CoreStudioRenderRoutes {
  readonly listPath: string;
  detailPath(runId: string): string;
}

const COPY = {
  zh: {
    title: 'Evaluation Core 运行记录',
    subtitle: '基于版本化 Core 产物的只读测量视图。三个状态轴相互独立，不合成为单一“成功”结论。',
    empty: '暂无 Evaluation Core 运行记录。',
    back: '← 返回运行记录',
    run: '运行',
    createdAt: '创建时间',
    runStatus: '运行状态',
    evidenceStatus: '证据状态',
    conclusionStatus: '结论状态',
    replayability: '可重放性',
    execution: '执行',
    evaluation: '评价',
    classification: '最高数据分级',
    identities: '产物身份',
    reportId: '报告 ID',
    contractDigest: '运行契约摘要',
    reportDigest: '报告摘要',
    artifactSetDigest: '产物集摘要',
    plan: '测量计划',
    dataset: '数据集',
    samples: '用例数',
    targets: '目标',
    evaluators: '评估器',
    metrics: '指标',
    stages: '阶段与覆盖',
    stage: '阶段',
    status: '状态',
    coverage: '覆盖',
    budget: '预算',
    records: '记录数',
    lineage: '产物谱系',
    executionRecords: '执行记录',
    evaluationRecords: '评价记录',
    analysis: '分析结果',
    decision: '决策',
    none: '无',
    notAvailable: '—',
    target: '目标',
    sample: '用例',
    trial: '试次',
    evaluator: '评估器',
    runtime: '运行时',
    duration: '耗时',
    usage: '用量',
    observations: '观测',
    node: '节点',
    mode: '模式',
    result: '结果',
    exclusionCount: '排除数',
    policy: '策略',
    verdict: '结论',
    reasons: '原因码',
    kind: '类型',
    protocol: '协议',
    implementation: '实现',
    executor: '执行器',
    measurement: '测量身份',
    valueType: '值类型',
    scope: '作用域',
    direction: '方向',
    unit: '单位',
    scale: '量尺',
    bundle: '产物包',
    bundleId: '产物包 ID',
    bundleDigest: '产物包摘要',
    parent: '父产物',
    provenance: '来源',
    cache: '缓存',
    trialId: '试次 ID',
    evaluationId: '评价 ID',
    resultId: '结果 ID',
    outputSchema: '输出 Schema',
    assumptions: '假设检查',
    recordDigest: '记录摘要',
    document: '文档',
    schema: 'Schema',
    identityDigest: '身份摘要',
    documentDigest: '文档摘要',
    digest: '摘要',
    methodNotAllowed: '仅支持 GET 请求。',
    sourceUnavailable: 'Core 产物当前不可读取。',
  },
  en: {
    title: 'Evaluation Core Runs',
    subtitle: 'A read-only measurement view backed by versioned Core artifacts. The three status axes remain independent and are never collapsed into one success verdict.',
    empty: 'No Evaluation Core runs yet.',
    back: '← Back to runs',
    run: 'Run',
    createdAt: 'Created',
    runStatus: 'Run status',
    evidenceStatus: 'Evidence status',
    conclusionStatus: 'Conclusion status',
    replayability: 'Replayability',
    execution: 'Execution',
    evaluation: 'Evaluation',
    classification: 'Maximum classification',
    identities: 'Artifact identities',
    reportId: 'Report ID',
    contractDigest: 'Run contract digest',
    reportDigest: 'Report digest',
    artifactSetDigest: 'Artifact set digest',
    plan: 'Measurement plan',
    dataset: 'Dataset',
    samples: 'Samples',
    targets: 'Targets',
    evaluators: 'Evaluators',
    metrics: 'Metrics',
    stages: 'Stages and coverage',
    stage: 'Stage',
    status: 'Status',
    coverage: 'Coverage',
    budget: 'Budget',
    records: 'Records',
    lineage: 'Artifact lineage',
    executionRecords: 'Execution records',
    evaluationRecords: 'Evaluation records',
    analysis: 'Analysis results',
    decision: 'Decision',
    none: 'None',
    notAvailable: '—',
    target: 'Target',
    sample: 'Sample',
    trial: 'Trial',
    evaluator: 'Evaluator',
    runtime: 'Runtime',
    duration: 'Duration',
    usage: 'Usage',
    observations: 'Observations',
    node: 'Node',
    mode: 'Mode',
    result: 'Result',
    exclusionCount: 'Exclusions',
    policy: 'Policy',
    verdict: 'Verdict',
    reasons: 'Reason codes',
    kind: 'Kind',
    protocol: 'Protocol',
    implementation: 'Implementation',
    executor: 'Executor',
    measurement: 'Measurement identity',
    valueType: 'Value type',
    scope: 'Scope',
    direction: 'Direction',
    unit: 'Unit',
    scale: 'Scale',
    bundle: 'Bundle',
    bundleId: 'Bundle ID',
    bundleDigest: 'Bundle digest',
    parent: 'Parent',
    provenance: 'Provenance',
    cache: 'Cache',
    trialId: 'Trial ID',
    evaluationId: 'Evaluation ID',
    resultId: 'Result ID',
    outputSchema: 'Output schema',
    assumptions: 'Assumptions',
    recordDigest: 'Record digest',
    document: 'Document',
    schema: 'Schema',
    identityDigest: 'Identity digest',
    documentDigest: 'Document digest',
    digest: 'Digest',
    methodNotAllowed: 'Only GET requests are supported.',
    sourceUnavailable: 'Core artifacts are currently unavailable.',
  },
} as const;

const CORE_STUDIO_STYLE = `<style>
.core-lead{max-width:820px}.core-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px;margin:18px 0}.core-run-card{display:block;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;color:inherit;transition:border-color .15s,box-shadow .15s}.core-run-card:hover{color:inherit;text-decoration:none;border-color:var(--accent);box-shadow:var(--shadow-md)}.core-run-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.core-run-id{font-weight:650;overflow-wrap:anywhere}.core-date{font-size:12px;color:var(--text-muted);white-space:nowrap}.core-statuses{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:14px 0}.core-axis{min-width:0}.core-axis-label{display:block;font-size:11px;color:var(--text-muted);margin-bottom:3px}.core-chip{display:inline-block;max-width:100%;padding:2px 8px;border:1px solid var(--border);border-radius:999px;background:var(--bg-soft);font-size:11px;font-weight:600;overflow-wrap:anywhere}.core-chip[data-tone="ok"]{color:var(--green);background:var(--green-bg);border-color:transparent}.core-chip[data-tone="warn"]{color:var(--yellow);background:var(--yellow-bg);border-color:transparent}.core-chip[data-tone="error"]{color:var(--red);background:var(--red-bg);border-color:transparent}.core-meta{font-size:12px;color:var(--text-secondary);overflow-wrap:anywhere}.core-digest{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}.core-kv{display:grid;grid-template-columns:minmax(130px,220px) minmax(0,1fr);border-bottom:1px solid var(--border);padding:7px 0;gap:14px}.core-kv:last-child{border-bottom:0}.core-kv dt{color:var(--text-muted)}.core-kv dd{margin:0;overflow-wrap:anywhere}.core-stage{border-left:4px solid var(--accent)}.core-stage h3{font-size:15px;margin-bottom:8px}.core-inline-list{display:flex;flex-wrap:wrap;gap:6px}.core-inline-list code{font-size:11px;background:var(--bg-soft);border:1px solid var(--border);border-radius:4px;padding:1px 5px}.core-muted{color:var(--text-muted)}.core-observations{display:flex;flex-wrap:wrap;gap:5px}.core-section-note{font-size:12px;color:var(--text-muted);margin-top:-8px;margin-bottom:10px}.core-table-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}.core-table-caption{text-align:left;padding:8px 12px;font-weight:600;color:var(--text-primary);background:var(--bg-surface)}.core-decision{border-left:4px solid var(--green)}
@media(max-width:680px){.core-statuses{grid-template-columns:1fr}.core-kv{grid-template-columns:1fr;gap:2px}.core-run-head{display:block}.core-date{display:block;margin-top:4px}}
</style>`;

type Copy = { readonly [K in keyof typeof COPY.zh]: string };

function c(lang: Lang): Copy {
  return COPY[lang];
}

function withLang(path: string, lang: Lang): string {
  if (lang !== 'en') return path;
  return `${path}${path.includes('?') ? '&' : '?'}lang=en`;
}

function separator(lang: Lang): string {
  return lang === 'zh' ? '：' : ': ';
}

function tone(value: string): 'ok' | 'warn' | 'error' | 'neutral' {
  if (['completed', 'complete', 'conclusive', 'within-budget', 'decided', 'observed', 'passed', 'self-contained'].includes(value)) return 'ok';
  if (['failed', 'unresolvable', 'invalid'].includes(value)) return 'error';
  if (['cancelled', 'budget-exhausted', 'partial', 'inconclusive', 'not-evaluated', 'missing', 'unverifiable', 'exhausted', 'summary-only'].includes(value)) return 'warn';
  return 'neutral';
}

function chip(value: string): string {
  return `<span class="core-chip" data-tone="${tone(value)}">${e(value)}</span>`;
}

function statusAxes(card: CoreStudioRunCard, copy: Copy): string {
  const axes = [
    [copy.runStatus, card.status.runStatus],
    [copy.evidenceStatus, card.status.evidenceStatus],
    [copy.conclusionStatus, card.status.conclusionStatus],
  ] as const;
  return `<div class="core-statuses" aria-label="${e(copy.status)}">${axes.map(([label, value]) => (
    `<div class="core-axis"><span class="core-axis-label">${e(label)}</span>${chip(value)}</div>`
  )).join('')}</div>`;
}

function keyValues(values: readonly (readonly [string, string])[]): string {
  return `<dl>${values.map(([key, value]) => `<div class="core-kv"><dt>${e(key)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
}

function formatUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; providerCost?: { amount: number; currency: string } } | undefined, copy: Copy): string {
  if (!usage) return copy.notAvailable;
  const parts = [
    usage.inputTokens === undefined ? undefined : `in ${usage.inputTokens}`,
    usage.outputTokens === undefined ? undefined : `out ${usage.outputTokens}`,
    usage.totalTokens === undefined ? undefined : `total ${usage.totalTokens}`,
    usage.providerCost === undefined ? undefined : `${usage.providerCost.amount} ${usage.providerCost.currency}`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? copy.notAvailable : parts.map(e).join(' · ');
}

function formatCoverage(coverage: Readonly<Record<string, number>>): string {
  return Object.entries(coverage).map(([key, value]) => `<code>${e(key)}=${value}</code>`).join(' ');
}

function formatBudget(budget: CoreStudioBudget): string {
  const costs = budget.reportedProviderCosts.map((cost) => `${cost.amount} ${cost.currency}`).join(', ');
  return [
    chip(budget.summaryStatus),
    `<code>admission=${e(budget.admissionMode)}</code>`,
    `<code>invocations=${budget.invocations}</code>`,
    `<code>active=${e(fmtDuration(budget.activeDurationMs))}</code>`,
    `<code>wall=${e(fmtDuration(budget.wallClock.elapsedMs))}</code>`,
    budget.wallClock.limitMs === undefined ? '' : `<code>limit=${e(fmtDuration(budget.wallClock.limitMs))}</code>`,
    `<code>overshoot=${e(fmtDuration(budget.wallClock.overshootMs))}</code>`,
    costs ? `<code>cost=${e(costs)}</code>` : '',
    budget.unreportedProviderCostInvocations > 0 ? `<code>unreported-cost=${budget.unreportedProviderCostInvocations}</code>` : '',
    budget.termination === undefined ? '' : `<code>termination=${e([
      budget.termination.terminationKind,
      budget.termination.resourceKind,
      budget.termination.scopeKind,
      budget.termination.reasonCode,
    ].filter(Boolean).join(':'))}</code>`,
    `<code>ledger=${e(budget.ledgerDigest)}</code>`,
  ].filter(Boolean).join(' ');
}

function formatRuntime(value: {
  implementationId: string;
  version?: string;
  fingerprint: string;
  fingerprintBasis: string;
  assuranceLevel: string;
}, copy: Copy): string {
  return `<span class="core-table-code">${e(value.implementationId)}@${e(value.version ?? copy.notAvailable)} · ${e(value.fingerprint)} · ${e(value.fingerprintBasis)} · ${e(value.assuranceLevel)}</span>`;
}

function formatProvenance(value: {
  provenanceKind: string;
  trust: string;
  parentDigests: readonly string[];
}, copy: Copy): string {
  const parents = value.parentDigests.length === 0
    ? copy.none
    : value.parentDigests.map(e).join(', ');
  return `<span class="core-table-code">${e(value.provenanceKind)} · ${e(value.trust)} · parents=${parents}</span>`;
}

function header(label: string): string {
  return `<th scope="col">${e(label)}</th>`;
}

function runCard(card: CoreStudioRunCard, lang: Lang, routes: CoreStudioRenderRoutes, copy: Copy): string {
  const href = withLang(routes.detailPath(card.runId), lang);
  const colon = separator(lang);
  return `<a class="core-run-card" href="${e(href)}">
    <div class="core-run-head"><span class="core-run-id">${e(card.runId)}</span><time class="core-date" datetime="${e(card.createdAt)}">${e(card.createdAt)}</time></div>
    ${statusAxes(card, copy)}
    <div class="core-meta">${e(copy.replayability)}${colon}${e(copy.execution)} ${chip(card.replayability.execution)} · ${e(copy.evaluation)} ${chip(card.replayability.evaluation)}</div>
    <div class="core-meta">${e(copy.classification)}${colon}${chip(card.maximumCapturedClassification)} · ${e(copy.reportId)}${colon}${e(card.reportId)}</div>
    <div class="core-meta core-digest">${e(copy.artifactSetDigest)}${colon}${e(card.artifactSetDigest)}</div>
  </a>`;
}

export function renderCoreRunList(
  cards: readonly CoreStudioRunCard[],
  routes: CoreStudioRenderRoutes,
  lang: Lang = 'zh',
): string {
  const copy = c(lang);
  const content = cards.length === 0
    ? `<p class="core-muted">${e(copy.empty)}</p>`
    : `<div class="core-grid">${cards.map((card) => runCard(card, lang, routes, copy)).join('')}</div>`;
  return layout(copy.title, `${CORE_STUDIO_STYLE}<main><h1>${e(copy.title)}</h1><p class="subtitle core-lead">${e(copy.subtitle)}</p>${content}</main>`, lang, {
    homeHref: withLang(routes.listPath, lang),
  });
}

function renderPlan(detail: CoreStudioRunDetail, copy: Copy): string {
  const targets = detail.targets.map((target) => (
    `<tr><td>${e(target.targetId)}</td><td>${e(target.targetKind)}</td><td>${e(target.protocolId)}</td><td>${e(target.executorId)}</td></tr>`
  )).join('');
  const evaluators = detail.evaluators.map((evaluator) => (
    `<tr><td>${e(evaluator.evaluatorId)}</td><td>${e(evaluator.evaluatorKind)}</td><td>${e(evaluator.implementationId)}</td><td><span class="core-inline-list">${evaluator.metricIds.map((metricId) => `<code>${e(metricId)}</code>`).join('')}</span></td><td>${e(evaluator.measurement.instrumentId)} / ${e(evaluator.measurement.ensembleMemberId)} / ${e(evaluator.measurement.replicateGroupId)} / ${evaluator.measurement.replicateIndex}</td></tr>`
  )).join('');
  const metrics = detail.metrics.map((metric) => (
    `<tr><td>${e(metric.metricId)}</td><td>${e(metric.valueType)}</td><td>${e(metric.scope)}</td><td>${e(metric.direction ?? copy.notAvailable)}</td><td>${e(metric.unit ?? copy.notAvailable)}</td><td>${metric.scale ? e(JSON.stringify(metric.scale)) : copy.notAvailable}</td></tr>`
  )).join('');
  return `<section><h2>${e(copy.plan)}</h2>
    ${keyValues([
      [copy.dataset, `<span class="core-table-code">${e(detail.dataset.datasetId)}</span> · <span class="core-digest">${e(detail.dataset.datasetRevisionDigest)}</span>`],
      [copy.samples, String(detail.dataset.sampleCount)],
    ])}
    <div class="table-wrap"><table><caption class="core-table-caption">${e(copy.targets)}</caption><thead><tr>${['ID', copy.kind, copy.protocol, copy.executor].map(header).join('')}</tr></thead><tbody>${targets}</tbody></table></div>
    <div class="table-wrap"><table><caption class="core-table-caption">${e(copy.evaluators)}</caption><thead><tr>${['ID', copy.kind, copy.implementation, copy.metrics, copy.measurement].map(header).join('')}</tr></thead><tbody>${evaluators}</tbody></table></div>
    <div class="table-wrap"><table><caption class="core-table-caption">${e(copy.metrics)}</caption><thead><tr>${['ID', copy.valueType, copy.scope, copy.direction, copy.unit, copy.scale].map(header).join('')}</tr></thead><tbody>${metrics}</tbody></table></div>
  </section>`;
}

function renderStages(detail: CoreStudioRunDetail, copy: Copy): string {
  const stages = [
    {
      name: copy.execution,
      value: detail.stages.execution,
      budget: detail.stages.execution.budget,
      records: detail.stages.execution.records.length,
      parent: undefined,
      replayability: detail.stages.execution.replayability,
    },
    {
      name: copy.evaluation,
      value: detail.stages.evaluation,
      budget: detail.stages.evaluation.budget,
      records: detail.stages.evaluation.records.length,
      parent: detail.stages.evaluation.parentExecutionBundleDigest,
      replayability: detail.stages.evaluation.replayability,
    },
    {
      name: copy.analysis,
      value: detail.stages.analysis,
      budget: undefined,
      records: detail.stages.analysis.records.length,
      parent: detail.stages.analysis.parentEvaluationBundleDigest,
      replayability: undefined,
    },
  ] as const;
  return `<section><h2>${e(copy.stages)}</h2><div class="core-grid">${stages.map((stage) => (
    `<article class="card core-stage"><h3>${e(stage.name)}</h3>${keyValues([
      [copy.status, chip(stage.value.stageStatus)],
      [copy.coverage, `<span class="core-inline-list">${formatCoverage(stage.value.coverage)}</span>`],
      [copy.records, String(stage.records)],
      [copy.provenance, formatProvenance(stage.value.provenance, copy)],
      ...(stage.replayability ? [[copy.replayability, chip(stage.replayability)] as const] : []),
      ...(stage.budget ? [[copy.budget, `<span class="core-inline-list">${formatBudget(stage.budget)}</span>`] as const] : []),
      [copy.bundleId, `<span class="core-table-code">${e(stage.value.bundleId)}</span>`],
      [copy.bundleDigest, `<span class="core-digest">${e(stage.value.bundleDigest)}</span>`],
      ...(stage.parent ? [[copy.parent, `<span class="core-digest">${e(stage.parent)}</span>`] as const] : []),
    ])}</article>`
  )).join('')}</div></section>`;
}

function renderExecutionRecords(detail: CoreStudioRunDetail, copy: Copy): string {
  const rows = detail.stages.execution.records.map((record) => `<tr>
    <td>${e(record.targetId)}</td><td>${e(record.sampleId)}</td><td>${record.trialIndex}</td><td>${e(record.trialId)}</td><td>${chip(record.executionStatus)}</td>
    <td>${formatRuntime(record.runtime, copy)}</td>
    <td>${formatProvenance(record.provenance, copy)}</td><td>${e(record.cacheStatus ?? copy.notAvailable)}</td><td>${record.durationMs === undefined ? copy.notAvailable : e(fmtDuration(record.durationMs))}</td><td>${formatUsage(record.usage, copy)}</td>
    <td>${e(record.errorCode ?? record.censorReasonCode ?? copy.notAvailable)}</td>
  </tr>`).join('');
  return `<section><h2>${e(copy.executionRecords)}</h2><div class="table-wrap"><table><caption class="core-table-caption">${e(copy.executionRecords)}</caption><thead><tr>${[copy.target, copy.sample, copy.trial, copy.trialId, copy.status, copy.runtime, copy.provenance, copy.cache, copy.duration, copy.usage, copy.reasons].map(header).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderEvaluationRecords(detail: CoreStudioRunDetail, copy: Copy): string {
  const rows = detail.stages.evaluation.records.map((record) => {
    const observations = record.observations.length === 0 ? copy.none : record.observations.map((observation) => {
      const value = observation.numericValue === undefined ? '' : `=${observation.numericValue}`;
      const reason = observation.reasonCode === undefined ? '' : ` (${observation.reasonCode})`;
      return `<code>${e(observation.metricId)}:${e(observation.observationStatus)}${e(value)}${e(reason)}</code>`;
    }).join('');
    const measurement = record.measurement;
    return `<tr><td>${e(record.evaluationId)}</td><td>${e(record.targetId)}</td><td>${e(record.sampleId)}</td><td>${record.trialIndex}</td><td>${e(record.trialId)}</td><td>${e(record.evaluatorId)}</td><td>${e(measurement.instrumentId)} / ${e(measurement.ensembleMemberId)} / ${e(measurement.replicateGroupId)} / ${measurement.replicateIndex}</td><td>${chip(record.evaluationStatus)}</td><td>${formatRuntime(record.runtime, copy)}</td><td>${formatProvenance(record.provenance, copy)}</td><td>${e(record.cacheStatus ?? copy.notAvailable)}</td><td>${record.durationMs === undefined ? copy.notAvailable : e(fmtDuration(record.durationMs))}</td><td>${formatUsage(record.usage, copy)}</td><td><span class="core-observations">${observations}</span></td><td>${e(record.errorCode ?? record.notEvaluatedReasonCode ?? copy.notAvailable)}</td></tr>`;
  }).join('');
  return `<section><h2>${e(copy.evaluationRecords)}</h2><div class="table-wrap"><table><caption class="core-table-caption">${e(copy.evaluationRecords)}</caption><thead><tr>${[copy.evaluationId, copy.target, copy.sample, copy.trial, copy.trialId, copy.evaluator, copy.measurement, copy.status, copy.runtime, copy.provenance, copy.cache, copy.duration, copy.usage, copy.observations, copy.reasons].map(header).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function analysisResult(record: CoreStudioAnalysisRecord, copy: Copy): string {
  if (record.numericValue !== undefined) return String(record.numericValue);
  if (record.resultType !== undefined) return record.resultType;
  return copy.notAvailable;
}

function renderAnalysis(detail: CoreStudioRunDetail, copy: Copy): string {
  const rows = detail.stages.analysis.records.map((record) => `<tr>
    <td>${e(record.resultId)}</td><td>${e(record.nodeId)}</td><td>${e(record.analysisNodeKind)}</td><td>${e(record.analysisMode)}</td><td>${chip(record.analysisStatus)}</td>
    <td>${e(analysisResult(record, copy))}</td><td>${record.exclusionCount}</td><td><span class="core-inline-list">${formatCoverage(record.coverage)}</span></td><td>${formatRuntime(record.runtime, copy)}</td>
    <td><span class="core-table-code">${e(record.outputSchema.schemaVersion)} · ${e(record.outputSchema.schemaDigest)}</span></td>
    <td>${record.assumptionChecks.map((check) => `${e(check.assumptionId)}=${e(check.checkStatus)}${check.reasonCode ? ` (${e(check.reasonCode)})` : ''}`).join(' · ') || copy.none}</td>
    <td>${e([...(record.reasonCodes ?? []), ...(record.errorCode ? [record.errorCode] : [])].join(', ') || copy.notAvailable)}</td><td class="core-table-code">${e(record.recordDigest)}</td>
  </tr>`).join('');
  return `<section><h2>${e(copy.analysis)}</h2><div class="table-wrap"><table><caption class="core-table-caption">${e(copy.analysis)}</caption><thead><tr>${[copy.resultId, copy.node, copy.kind, copy.mode, copy.status, copy.result, copy.exclusionCount, copy.coverage, copy.runtime, copy.outputSchema, copy.assumptions, copy.reasons, copy.recordDigest].map(header).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderDecision(detail: CoreStudioRunDetail, copy: Copy): string {
  const decision = detail.decision;
  if (!decision) return `<section><h2>${e(copy.decision)}</h2><p class="core-muted">${e(copy.none)}</p></section>`;
  return `<section><h2>${e(copy.decision)}</h2><article class="card core-decision">${keyValues([
    [copy.policy, `<span class="core-table-code">${e(decision.decisionPolicyId)}</span>`],
    [copy.status, chip(decision.decisionStatus)],
    [copy.verdict, e(decision.verdict ?? copy.notAvailable)],
    [copy.reasons, e(decision.reasonCodes?.join(', ') || decision.errorCode || copy.notAvailable)],
    [copy.runtime, formatRuntime(decision.implementation, copy)],
    [copy.analysis, `<span class="core-inline-list">${decision.analysisResultIds.map((id) => `<code>${e(id)}</code>`).join('')}</span>`],
    [copy.digest, `<span class="core-digest">${e(decision.decisionDigest)}</span>`],
  ])}</article></section>`;
}

function renderLineage(detail: CoreStudioRunDetail, copy: Copy): string {
  const rows = detail.lineage.map((entry) => `<tr><td>${e(entry.documentKind)}</td><td>${e(entry.schemaVersion)}</td><td class="core-table-code">${e(entry.identityDigest)}</td><td class="core-table-code">${e(entry.documentDigest)}</td></tr>`).join('');
  return `<section><h2>${e(copy.lineage)}</h2><div class="table-wrap"><table><caption class="core-table-caption">${e(copy.lineage)}</caption><thead><tr>${[copy.document, copy.schema, copy.identityDigest, copy.documentDigest].map(header).join('')}</tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

export function renderCoreRunDetail(
  detail: CoreStudioRunDetail,
  routes: CoreStudioRenderRoutes,
  lang: Lang = 'zh',
): string {
  const copy = c(lang);
  const card = detail.run;
  return layout(`${copy.run} · ${card.runId}`, `${CORE_STUDIO_STYLE}<main>
    <nav class="nav"><a href="${e(withLang(routes.listPath, lang))}">${e(copy.back)}</a></nav>
    <h1>${e(card.runId)}</h1><p class="subtitle"><time datetime="${e(card.createdAt)}">${e(card.createdAt)}</time></p>
    ${statusAxes(card, copy)}
    <section><h2>${e(copy.identities)}</h2>${keyValues([
      [copy.reportId, `<span class="core-table-code">${e(card.reportId)}</span>`],
      [copy.contractDigest, `<span class="core-digest">${e(card.runContractDigest)}</span>`],
      [copy.reportDigest, `<span class="core-digest">${e(card.reportDigest)}</span>`],
      [copy.artifactSetDigest, `<span class="core-digest">${e(card.artifactSetDigest)}</span>`],
      [copy.replayability, `${e(copy.execution)} ${chip(card.replayability.execution)} · ${e(copy.evaluation)} ${chip(card.replayability.evaluation)}`],
      [copy.classification, chip(card.maximumCapturedClassification)],
      [copy.provenance, formatProvenance(detail.reportProvenance, copy)],
    ])}</section>
    ${renderPlan(detail, copy)}${renderStages(detail, copy)}${renderExecutionRecords(detail, copy)}${renderEvaluationRecords(detail, copy)}${renderAnalysis(detail, copy)}${renderDecision(detail, copy)}${renderLineage(detail, copy)}
  </main>`, lang, { homeHref: withLang(routes.listPath, lang) });
}

export function renderCoreStudioError(
  message: string,
  routes: CoreStudioRenderRoutes,
  lang: Lang = 'zh',
): string {
  const copy = c(lang);
  return layout(copy.title, `${CORE_STUDIO_STYLE}<main><nav class="nav"><a href="${e(withLang(routes.listPath, lang))}">${e(copy.back)}</a></nav><h1>${e(copy.title)}</h1><p role="alert">${e(message)}</p></main>`, lang, {
    homeHref: withLang(routes.listPath, lang),
  });
}

export function coreStudioSourceUnavailableMessage(lang: Lang): string {
  return c(lang).sourceUnavailable;
}

export function coreStudioMethodNotAllowedMessage(lang: Lang): string {
  return c(lang).methodNotAllowed;
}
