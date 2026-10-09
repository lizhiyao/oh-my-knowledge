import type { StudioTone } from '../../view-models/display/tone.js';
import type {
  CoreStudioBudget,
  CoreStudioEvaluationRecord,
  CoreStudioMetricObservation,
  CoreStudioProvenance,
  CoreStudioRuntimeIdentity,
  CoreStudioRunDetail,
  CoreStudioUsage,
} from '../../view-models/measure/core-runs.js';
import { formatDuration } from '../display/format.js';

/**
 * Evaluation Core 运行记录的口径计算：状态着色、预算／覆盖／运行时身份／来源的文本化。
 * 只产出结构与纯文本，不产出标记，页面由 Next 组件消费（见 src/studio/README.md）。
 * 时长不在这里：它是跨域口径，owner 在 `application/display/format.ts`。
 */

const TONES: Readonly<Record<Exclude<StudioTone, 'neutral'>, readonly string[]>> = {
  success: ['completed', 'complete', 'within-budget', 'observed', 'passed', 'self-contained'],
  warning: ['cancelled', 'budget-exhausted', 'exhausted', 'partial', 'inconclusive', 'not-evaluated', 'not-decided', 'missing', 'unverifiable', 'summary-only', 'budget-censored'],
  error: ['failed', 'unresolvable', 'invalid'],
};

/**
 * 状态取值的着色口径。未列出的取值一律归 `neutral`：数据分级（public／sensitive／secret／gold）、
 * 缓存命中与 `resolvable` 只表达事实，不表达好坏，误染成告警色等于伪造结论。
 */
export function statusTone(value: string): StudioTone {
  for (const tone of ['error', 'warning', 'success'] as const) {
    if (TONES[tone].includes(value)) return tone;
  }
  return 'neutral';
}

/** 用量只表达 executor 报回的事实：缺席的字段不补 0，也不把未上报折算成零成本。 */
export function formatUsage(usage: CoreStudioUsage | undefined): readonly string[] {
  if (!usage) return [];
  return [
    usage.inputTokens === undefined ? undefined : `in ${usage.inputTokens}`,
    usage.outputTokens === undefined ? undefined : `out ${usage.outputTokens}`,
    usage.totalTokens === undefined ? undefined : `total ${usage.totalTokens}`,
    usage.providerCost === undefined ? undefined : `${usage.providerCost.amount} ${usage.providerCost.currency}`,
  ].filter((part): part is string => part !== undefined);
}

export function formatCoverage(coverage: Readonly<Record<string, number>>): readonly (readonly [string, number])[] {
  return Object.entries(coverage);
}

/** 预算的每一项都是可核对的计数或摘要，按键值对交出，由视图渲染成等宽片段。 */
export function formatBudget(budget: CoreStudioBudget): readonly (readonly [string, string | number])[] {
  const costs = budget.reportedProviderCosts.map((cost) => `${cost.amount} ${cost.currency}`).join(', ');
  const termination = budget.termination === undefined
    ? undefined
    : [
        budget.termination.terminationKind,
        budget.termination.resourceKind,
        budget.termination.scopeKind,
        budget.termination.reasonCode,
      ].filter(Boolean).join(':');
  return [
    ['summaryStatus', budget.summaryStatus],
    ['admission', budget.admissionMode],
    ['invocations', budget.invocations],
    ['active', formatDuration(budget.activeDurationMs)],
    ['wall', formatDuration(budget.wallClock.elapsedMs)],
    ...(budget.wallClock.limitMs === undefined ? [] : [['limit', formatDuration(budget.wallClock.limitMs)] as const]),
    ['overshoot', formatDuration(budget.wallClock.overshootMs)],
    ...(costs === '' ? [] : [['cost', costs] as const]),
    ...(budget.unreportedProviderCostInvocations > 0
      ? [['unreported-cost', budget.unreportedProviderCostInvocations] as const]
      : []),
    ...(termination === undefined ? [] : [['termination', termination] as const]),
    ['ledger', budget.ledgerDigest],
  ];
}

/** 运行时身份：实现@版本 · 指纹 · 指纹依据 · 保证等级，四段缺一不可核对。 */
export function formatRuntimeIdentity(identity: CoreStudioRuntimeIdentity): readonly string[] {
  return [
    `${identity.implementationId}@${identity.version ?? '—'}`,
    identity.fingerprint,
    identity.fingerprintBasis,
    identity.assuranceLevel,
  ];
}

export function formatProvenance(provenance: CoreStudioProvenance): readonly string[] {
  return [
    provenance.provenanceKind,
    provenance.trust,
    `parents=${provenance.parentDigests.length === 0 ? '—' : provenance.parentDigests.join(', ')}`,
  ];
}

export function formatMeasurement(measurement: CoreStudioEvaluationRecord['measurement']): string {
  return [
    measurement.instrumentId,
    measurement.ensembleMemberId,
    measurement.replicateGroupId,
    String(measurement.replicateIndex),
  ].join(' / ');
}

export function formatObservation(observation: CoreStudioMetricObservation): string {
  const observedValue = observation.numericValue ?? observation.booleanValue;
  const value = observedValue === undefined ? '' : `=${observedValue}`;
  const reason = observation.reasonCode === undefined ? '' : ` (${observation.reasonCode})`;
  return `${observation.metricId}:${observation.observationStatus}${value}${reason}`;
}

export function formatAssumptionCheck(check: {
  readonly assumptionId: string;
  readonly checkStatus: string;
  readonly reasonCode?: string;
}): string {
  return `${check.assumptionId}=${check.checkStatus}${check.reasonCode ? ` (${check.reasonCode})` : ''}`;
}

const RELEASE_CONCLUSIONS: Readonly<Record<string, { title: readonly [string, string]; summary: readonly [string, string]; tone: StudioTone }>> = {
  UNDERPOWERED: { title: ['证据不足，暂不能判断改动效果', 'Insufficient evidence to assess the change'], summary: ['当前比较未能区分版本差异，且比较证据未达到本次策略的数量要求。', 'The comparison did not distinguish the versions and does not meet the policy’s minimum evidence count.'], tone: 'warning' },
  NOISE: { title: ['当前测量未能区分版本差异', 'This measurement did not distinguish the versions'], summary: ['未检出差异不代表两个版本等效，也不证明改动没有作用。', 'Not detecting a difference does not establish equivalence or prove that the change has no effect.'], tone: 'warning' },
  CAUTIOUS: { title: ['尚不足以确认改进，仍需复核', 'Improvement still requires review'], summary: ['报告给出谨慎判定；请先处理下方原因与限制，再判断是否采纳。', 'The report calls for caution. Review the reasons and limitations before deciding whether to adopt the change.'], tone: 'warning' },
  REGRESSION: { title: ['本次比较支持表现退步', 'This comparison supports a regression'], summary: ['报告判定实验组表现变差，请从失败用例与变差指标核对原因。', 'The report finds worse treatment performance. Review failing cases and deteriorating metrics.'], tone: 'error' },
  PROGRESS: { title: ['本次比较支持改进', 'This comparison supports improvement'], summary: ['报告判定改进，但仍需核对用例代表性与适用范围。', 'The report supports improvement. Case representativeness and applicability still require review.'], tone: 'success' },
  SOLO: { title: ['缺少版本对照，不能判断改进', 'No comparison version to assess improvement'], summary: ['本次只有一个被测版本，不能形成版本改动的比较结论。', 'Only one version was measured, so this run cannot assess a version change.'], tone: 'warning' },
};

const RELEASE_REASONS: Readonly<Record<string, readonly [string, string]>> = {
  'comparison-sample-size-below-minimum': ['比较证据的数量未达到本次策略要求。', 'The comparison evidence count is below the policy minimum.'],
  'comparison-not-significant': ['当前比较未检出显著差异。', 'The comparison did not detect a significant difference.'],
  'comparison-interval-overlaps-zero': ['差异区间包含零，方向尚不明确。', 'The difference interval includes zero; its direction is uncertain.'],
  'comparison-sample-size-sufficient': ['比较证据的数量达到本次策略下限；这不证明两个版本等效。', 'The comparison evidence count meets the policy minimum; this does not establish equivalence.'],
  'comparison-significant-progress': ['本次比较检出显著向好的差异。', 'This comparison detected a significant improvement.'],
  'comparison-significant-regression': ['本次比较检出显著变差的差异。', 'This comparison detected a significant regression.'],
  'comparison-effect-practically-trivial': ['改善尚未达到本次策略要求的实际效应门槛。', 'Improvement did not meet the policy’s practical-effect threshold.'],
  'treatment-layer-gate-failed': ['实验组未通过本次评分层门槛。', 'The treatment did not pass the scoring-layer gate.'],
  'judge-ensemble-dissent': ['评委之间存在分歧。', 'The judges disagree.'],
  'judge-uncertainty-unmeasured': ['评委不确定性尚未充分测量。', 'Judge uncertainty has not been sufficiently measured.'],
  'holdout-generalization-gap': ['验证集表现存在策略标记的差距。', 'The policy flagged a holdout generalization gap.'],
  'release-evidence-incomplete': ['证据不完整，策略未形成效果判定。', 'Incomplete evidence prevented a policy verdict.'],
  'release-comparison-interval-unavailable': ['比较区间不可用，不能用点估计代替结论。', 'The comparison interval is unavailable; a point estimate cannot replace it.'],
  'release-bootstrap-monte-carlo-indeterminate': ['重采样近似误差下，显著性仍不确定。', 'Significance remains uncertain under resampling approximation error.'],
  'release-gates-passed': ['本次策略的发布门槛已通过。', 'The configured release gates passed.'],
};

/** 只翻译已投影的官方策略判定，不推导新判定，也不解释自定义策略的同名代码。 */
export function formatRunConclusion(detail: CoreStudioRunDetail, lang: 'zh' | 'en') {
  const index = lang === 'zh' ? 0 : 1;
  const text = (zh: string, en: string) => index === 0 ? zh : en;
  const { decision, run } = detail;
  const releasePolicy = /^omk\.release-decision\/v[1-7]$/.test(decision?.implementation.implementationId ?? '');
  const known = releasePolicy && decision?.decisionStatus === 'decided' && decision.verdict && Object.hasOwn(RELEASE_CONCLUSIONS, decision.verdict) ? RELEASE_CONCLUSIONS[decision.verdict] : undefined;
  let title = text('本次未生成效果判定', 'This run has no effectiveness verdict');
  let summary = text('运行或评分结果不能代替效果判定。请核对分析和策略记录。', 'Execution or scoring results do not replace a verdict. Review analysis and policy records.');
  let tone: StudioTone = 'warning';
  if (decision?.decisionStatus === 'failed') {
    title = text('判定失败，无法判断改动效果', 'Decision failed; effectiveness cannot be assessed');
    tone = 'error';
  } else if (decision?.decisionStatus === 'not-decided') {
    title = text('尚无法形成效果结论', 'An effectiveness conclusion is not available');
    summary = text('策略尚未作出判定。请核对下方原因与证据限制。', 'The policy has not decided. Review reasons and evidence limitations below.');
  } else if (known) {
    title = known.title[index]; summary = known.summary[index]; tone = known.tone;
    if (decision?.verdict === 'PROGRESS' && (run.status.runStatus !== 'completed' || run.status.evidenceStatus !== 'complete' || run.status.conclusionStatus !== 'conclusive')) {
      title = text('效果结论受运行或证据限制', 'Effectiveness is limited by run or evidence status');
      summary = text('原始判定为 PROGRESS，但运行或证据状态存在限制，不能据此确认改善。', 'The recorded verdict is PROGRESS, but run or evidence limitations prevent confirming improvement.');
      tone = 'warning';
    }
  } else if (decision?.decisionStatus === 'decided') {
    title = text('报告已给出策略判定', 'The report has a policy decision');
    summary = text('请按该策略定义解读原始判定；此处不将自定义判定解释为改进或发布授权。', 'Interpret the recorded verdict using its policy definition. Custom decisions are not interpreted here as improvement or release approval.');
    tone = 'neutral';
  }
  const limitations = [text(`仅适用于本次 ${detail.dataset.sampleCount} 个用例、模型、评分准则与运行条件；不能直接外推其它任务的收益。`, `Applies only to these ${detail.dataset.sampleCount} cases, models, scoring criteria and runtime conditions; it does not establish benefits on other tasks.`)];
  if (run.status.evidenceStatus !== 'complete') limitations.push(text('证据部分缺失或无法解析，请核对覆盖与失败记录。', 'Evidence is partial or unresolvable. Review coverage and failure records.'));
  if (run.status.runStatus !== 'completed') limitations.push(text('运行未完整结束，请核对取消、失败或预算截断的记录。', 'The run did not complete. Review cancellation, failure or budget-censoring records.'));
  if (detail.reportProvenance.trust !== 'verified') limitations.push(text('报告来源未达到已验证等级，请核对原始证据与来源保证。', 'Report provenance is not verified. Review source evidence and assurance.'));
  const codes = decision?.reasonCodes ?? [];
  return { title, summary, tone, limitations, reasons: [...codes, ...(decision?.errorCode ? [decision.errorCode] : [])].map(code => ({ code, label: releasePolicy && Object.hasOwn(RELEASE_REASONS, code) ? RELEASE_REASONS[code][index] : code })) };
}
