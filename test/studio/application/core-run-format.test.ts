/**
 * 评测运行记录的呈现口径：状态着色、时长／用量／预算／运行时身份／来源／测量的文本化。
 *
 * 这些都是「同一个取值在列表、详情、中英两份词表下必须读成同一件事」的口径，与 React 的措辞
 * 无关，所以在 application 层直接锁；页面上渲染出什么由 web/measure-react.test.tsx 负责。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type {
  CoreStudioBudget,
  CoreStudioEvaluationRecord,
  CoreStudioMetricObservation,
  CoreStudioProvenance,
  CoreStudioRuntimeIdentity,
} from '../../../src/studio/view-models/measure/core-runs.js';
import {
  formatAssumptionCheck,
  formatBudget,
  formatCoverage,
  formatMeasurement,
  formatObservation,
  formatProvenance,
  formatRuntimeIdentity,
  formatUsage,
  statusTone,
} from '../../../src/studio/application/measure/core-run-format.js';

function budget(over: Partial<CoreStudioBudget> = {}): CoreStudioBudget {
  return {
    summaryStatus: 'within-budget',
    admissionMode: 'strict-reservation',
    invocations: 2,
    activeDurationMs: 90_000,
    reportedProviderCosts: [],
    unreportedProviderCostInvocations: 0,
    wallClock: { elapsedMs: 100_000, overshootMs: 0 },
    ledgerDigest: 'ledger-1',
    ...over,
  };
}

function identity(over: Partial<CoreStudioRuntimeIdentity> = {}): CoreStudioRuntimeIdentity {
  return {
    implementationId: 'executor-fixture',
    version: '1.2.3',
    fingerprint: 'sha256:abc',
    fingerprintBasis: 'content-derived',
    assuranceLevel: 'verified',
    ...over,
  };
}

function provenance(over: Partial<CoreStudioProvenance> = {}): CoreStudioProvenance {
  return { provenanceKind: 'native', trust: 'verified', parentDigests: [], ...over };
}

function observation(over: Partial<CoreStudioMetricObservation>): CoreStudioMetricObservation {
  return { observationId: 'o-1', metricId: 'quality', valueType: 'numeric', observationStatus: 'observed', ...over };
}

describe('状态取值的着色口径', () => {
  it('表达结论的取值按好坏着色，与它出现在哪个字段无关', () => {
    for (const value of ['completed', 'complete', 'conclusive', 'within-budget', 'decided', 'observed', 'passed', 'self-contained']) {
      assert.equal(statusTone(value), 'success', value);
    }
    for (const value of ['cancelled', 'budget-exhausted', 'exhausted', 'partial', 'inconclusive', 'not-evaluated', 'not-decided', 'missing', 'unverifiable', 'summary-only', 'budget-censored']) {
      assert.equal(statusTone(value), 'warning', value);
    }
    for (const value of ['failed', 'unresolvable', 'invalid']) {
      assert.equal(statusTone(value), 'error', value);
    }
  });

  it('只表达事实的取值一律不着色，未列出的取值也不着色', () => {
    // 数据分级、缓存命中、`resolvable` 都只说明「是什么」，染成任何一档颜色都等于伪造结论。
    for (const value of ['public', 'sensitive', 'secret', 'gold', 'not-used', 'miss', 'replay', 'transparent-hit', 'resolvable', 'unknown-future-status', '']) {
      assert.equal(statusTone(value), 'neutral', value);
    }
  });
});

describe('用量文本化', () => {
  it('缺席的字段不补 0，也不把未上报折算成零成本', () => {
    assert.deepEqual(formatUsage(undefined), []);
    assert.deepEqual(formatUsage({}), []);
    assert.deepEqual(formatUsage({ outputTokens: 7 }), ['out 7']);
  });

  it('按固定顺序交出报回的事实，成本带币种', () => {
    assert.deepEqual(
      formatUsage({ inputTokens: 10, outputTokens: 7, totalTokens: 17, providerCost: { amount: 0.004, currency: 'USD' } }),
      ['in 10', 'out 7', 'total 17', '0.004 USD'],
    );
  });
});

describe('覆盖计数', () => {
  it('保持记录自带的键顺序，不排序也不补零', () => {
    assert.deepEqual(formatCoverage({ sourceUnavailable: 1, trialCancelled: 0 }), [['sourceUnavailable', 1], ['trialCancelled', 0]]);
    assert.deepEqual(formatCoverage({}), []);
  });
});

describe('预算片段', () => {
  it('只交出这次运行真正存在的事实：无上限、无成本、无终止原因时不留空片段', () => {
    assert.deepEqual(formatBudget(budget()), [
      ['summaryStatus', 'within-budget'],
      ['admission', 'strict-reservation'],
      ['invocations', 2],
      ['active', '1m30s'],
      ['wall', '1m40s'],
      ['overshoot', '0ms'],
      ['ledger', 'ledger-1'],
    ]);
  });

  it('上限、成本、未上报计数与终止原因存在时才追加，并沿用同一份时长口径', () => {
    const parts = formatBudget(budget({
      summaryStatus: 'exhausted',
      reportedProviderCosts: [{ amount: 0.01, currency: 'USD' }, { amount: 2, currency: 'CNY' }],
      unreportedProviderCostInvocations: 3,
      wallClock: { elapsedMs: 100_000, limitMs: 60_000, overshootMs: 40_000 },
      termination: { terminationKind: 'active-budget-exhausted', resourceKind: 'active-duration', reasonCode: 'active-budget-exhausted' },
    }));
    assert.deepEqual(Object.fromEntries(parts), {
      summaryStatus: 'exhausted',
      admission: 'strict-reservation',
      invocations: 2,
      active: '1m30s',
      wall: '1m40s',
      limit: '1m',
      overshoot: '40s',
      cost: '0.01 USD, 2 CNY',
      'unreported-cost': 3,
      termination: 'active-budget-exhausted:active-duration:active-budget-exhausted',
      ledger: 'ledger-1',
    });
    // 顺序本身是口径：预算结论在前、计数居中、终止原因紧贴台账摘要。
    assert.deepEqual(parts.map(([key]) => key), [
      'summaryStatus', 'admission', 'invocations', 'active', 'wall', 'limit', 'overshoot', 'cost', 'unreported-cost', 'termination', 'ledger',
    ]);
  });

  it('终止原因只交出的段不补占位，段间仍以 : 分隔', () => {
    const parts = formatBudget(budget({
      termination: { terminationKind: 'cancelled', scopeKind: 'run', reasonCode: 'user-stopped' },
    }));
    assert.deepEqual(Object.fromEntries(parts).termination, 'cancelled:run:user-stopped');
  });
});

describe('运行时身份与来源', () => {
  it('身份固定四段，缺版本用占位符而不是丢掉这一段', () => {
    assert.deepEqual(formatRuntimeIdentity(identity()), ['executor-fixture@1.2.3', 'sha256:abc', 'content-derived', 'verified']);
    assert.equal(formatRuntimeIdentity(identity({ version: undefined }))[0], 'executor-fixture@—');
  });

  it('来源始终交出父摘要这一段，无父时用占位符而不是省略', () => {
    assert.deepEqual(formatProvenance(provenance()), ['native', 'verified', 'parents=—']);
    assert.deepEqual(
      formatProvenance(provenance({ provenanceKind: 'derived', trust: 'declared', parentDigests: ['sha256:a', 'sha256:b'] })),
      ['derived', 'declared', 'parents=sha256:a, sha256:b'],
    );
  });
});

describe('测量身份、观测与假设检查', () => {
  it('测量身份按 instrument / member / replicate 组 / 序号交出，序号 0 不折叠成空', () => {
    const measurement: CoreStudioEvaluationRecord['measurement'] = {
      instrumentId: 'instrument-1', ensembleMemberId: 'member-1', replicateGroupId: 'replicate-1', replicateIndex: 0,
    };
    assert.equal(formatMeasurement(measurement), 'instrument-1 / member-1 / replicate-1 / 0');
  });

  it('观测文本带状态，数值与原因码只在存在时追加', () => {
    assert.equal(formatObservation(observation({ numericValue: 4.25 })), 'quality:observed=4.25');
    assert.equal(formatObservation(observation({ observationStatus: 'missing', numericValue: undefined, reasonCode: 'no-response' })), 'quality:missing (no-response)');
    assert.equal(formatObservation(observation({ observationStatus: 'invalid', numericValue: undefined })), 'quality:invalid');
  });

  it('假设检查用 `id=status` 表达，原因码存在才追加', () => {
    assert.equal(formatAssumptionCheck({ assumptionId: 'iid', checkStatus: 'passed' }), 'iid=passed');
    assert.equal(
      formatAssumptionCheck({ assumptionId: 'iid', checkStatus: 'failed', reasonCode: 'unequal-variance' }),
      'iid=failed (unequal-variance)',
    );
  });
});
