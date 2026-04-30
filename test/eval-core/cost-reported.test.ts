import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVariantResult, buildVariantSummary } from '../../src/eval-core/schema.js';
import { fmtCost } from '../../src/renderer/layout.js';
import type { ExecResult, VariantResult } from '../../src/types/index.js';

// 锁住 cost 未报告的语义传递路径:
//   ExecResult.costReportedByExecutor=false
//     → VariantResult.costReportedByExecutor=false (schema buildVariantResult)
//     → VariantSummary.execCostReported=false       (schema buildVariantSummary)
//     → renderer fmtCost(0, false) 显示「—」      (layout fmtCost)
// 缺位时(undefined)默认当 reported,保证向后兼容老报告 + 老 executor。

function mkExec(opts: Partial<ExecResult> = {}): ExecResult {
  return {
    ok: true,
    output: 'out',
    durationMs: 100, durationApiMs: 80,
    inputTokens: 10, outputTokens: 20,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    costUSD: 0.001,
    stopReason: 'end',
    numTurns: 1,
    ...opts,
  };
}

function mkVR(opts: Partial<VariantResult> = {}): VariantResult {
  return {
    ok: true,
    durationMs: 100, durationApiMs: 80,
    inputTokens: 10, outputTokens: 20, totalTokens: 30,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    execCostUSD: 0.001, judgeCostUSD: 0, costUSD: 0.001,
    numTurns: 1,
    outputPreview: 'p',
    ...opts,
  };
}

describe('costReportedByExecutor: ExecResult → VariantResult', () => {
  it('costReportedByExecutor=false 透传到 VariantResult', () => {
    const exec = mkExec({ costReportedByExecutor: false, costUSD: 0 });
    const r = buildVariantResult(exec, null);
    assert.equal(r.costReportedByExecutor, false);
    assert.equal(r.execCostUSD, 0);
  });

  it('costReportedByExecutor=true 不写入字段(向后兼容,保持 result 紧凑)', () => {
    const exec = mkExec({ costReportedByExecutor: true });
    const r = buildVariantResult(exec, null);
    assert.equal(r.costReportedByExecutor, undefined);
  });

  it('costReportedByExecutor 缺失(老 executor)→ VariantResult 也无字段', () => {
    const exec = mkExec({});
    const r = buildVariantResult(exec, null);
    assert.equal(r.costReportedByExecutor, undefined);
  });
});

describe('execCostReported: VariantResult[] → VariantSummary', () => {
  it('全部 sample reported(undefined)→ summary 不出 execCostReported 字段', () => {
    const entries = [mkVR(), mkVR(), mkVR()];
    const s = buildVariantSummary(entries);
    assert.equal(s.execCostReported, undefined);
  });

  it('任一 sample costReportedByExecutor=false → summary.execCostReported=false', () => {
    const entries = [
      mkVR(),
      mkVR({ costReportedByExecutor: false, execCostUSD: 0, costUSD: 0 }),
      mkVR(),
    ];
    const s = buildVariantSummary(entries);
    assert.equal(s.execCostReported, false);
  });

  it('全部 sample costReportedByExecutor=false → summary.execCostReported=false', () => {
    const entries = [
      mkVR({ costReportedByExecutor: false, execCostUSD: 0, costUSD: 0 }),
      mkVR({ costReportedByExecutor: false, execCostUSD: 0, costUSD: 0 }),
    ];
    const s = buildVariantSummary(entries);
    assert.equal(s.execCostReported, false);
  });

  it('全部 sample 失败(没 ok)→ summary 不出字段(避免 partial 误报)', () => {
    const entries = [mkVR({ ok: false, costReportedByExecutor: false })];
    const s = buildVariantSummary(entries);
    assert.equal(s.execCostReported, undefined);
  });
});

describe('fmtCost(usd, reported): renderer 显示语义', () => {
  it('reported=true(默认)→ $X.XXXX', () => {
    assert.equal(fmtCost(0.001234), '$0.0012');
    assert.equal(fmtCost(0), '$0.0000');
    assert.equal(fmtCost(null), '$0.0000');
    assert.equal(fmtCost(undefined), '$0.0000');
  });

  it('reported=false → 「—」(em-dash 风格)而不是 $0.0000', () => {
    assert.equal(fmtCost(0, false), '—');
    assert.equal(fmtCost(0.001, false), '—'); // 即使有数值,reported=false 仍显示「—」
    assert.equal(fmtCost(null, false), '—');
  });
});
