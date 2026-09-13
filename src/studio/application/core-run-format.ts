import type {
  CoreStudioBudget,
  CoreStudioEvaluationRecord,
  CoreStudioMetricObservation,
  CoreStudioProvenance,
  CoreStudioRuntimeIdentity,
  CoreStudioUsage,
} from '../view-models/core-runs.js';

/**
 * Evaluation Core 运行记录的口径计算：状态着色、时长／预算／覆盖／运行时身份／来源的文本化。
 * 只产出结构与纯文本，不产出标记，页面由 Next 组件消费（见 src/studio/README.md）。
 */

/** 与 antd Tag 的语义色一致；`default` 表示该取值本身不表达好坏，不得着色。 */
export type StatusTone = 'success' | 'warning' | 'error' | 'default';

const TONES: Readonly<Record<Exclude<StatusTone, 'default'>, readonly string[]>> = {
  success: ['completed', 'complete', 'conclusive', 'within-budget', 'decided', 'observed', 'passed', 'self-contained'],
  warning: ['cancelled', 'budget-exhausted', 'exhausted', 'partial', 'inconclusive', 'not-evaluated', 'not-decided', 'missing', 'unverifiable', 'summary-only', 'budget-censored'],
  error: ['failed', 'unresolvable', 'invalid'],
};

/**
 * 状态取值的着色口径。未列出的取值一律不着色：数据分级（public／sensitive／secret／gold）、
 * 缓存命中与 `resolvable` 只表达事实，不表达好坏，误染成告警色等于伪造结论。
 */
export function statusTone(value: string): StatusTone {
  for (const tone of ['error', 'warning', 'success'] as const) {
    if (TONES[tone].includes(value)) return tone;
  }
  return 'default';
}

export function formatDuration(ms: number | undefined | null): string {
  const value = Number(ms || 0);
  if (value < 1000) return `${value}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
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
  const value = observation.numericValue === undefined ? '' : `=${observation.numericValue}`;
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
