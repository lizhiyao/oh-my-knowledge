import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildVariantSummary } from '../../src/eval-core/schema.js';
import type { VariantResult, EnsembleJudgeResult } from '../../src/types.js';

function makeEntry(scores: { judge: string; score: number }[], llmScore: number): VariantResult {
  const ensemble: EnsembleJudgeResult[] = scores.map((s) => ({ judge: s.judge, score: s.score }));
  return {
    ok: true,
    durationMs: 100, durationApiMs: 100,
    inputTokens: 100, outputTokens: 50, totalTokens: 150,
    cacheReadTokens: 0, cacheCreationTokens: 0,
    execCostUSD: 0, judgeCostUSD: 0, costUSD: 0,
    numTurns: 1,
    llmScore,
    llmEnsemble: ensemble,
    outputPreview: 'ok',
  };
}

describe('buildVariantSummary — aggregate-level judgeAgreement', () => {
  it('two judges, perfectly aligned across 5 samples → Pearson=1, MAD=0', () => {
    const entries = [
      makeEntry([{ judge: 'claude:opus', score: 3 }, { judge: 'openai:gpt-4o', score: 3 }], 3),
      makeEntry([{ judge: 'claude:opus', score: 4 }, { judge: 'openai:gpt-4o', score: 4 }], 4),
      makeEntry([{ judge: 'claude:opus', score: 5 }, { judge: 'openai:gpt-4o', score: 5 }], 5),
      makeEntry([{ judge: 'claude:opus', score: 2 }, { judge: 'openai:gpt-4o', score: 2 }], 2),
      makeEntry([{ judge: 'claude:opus', score: 4 }, { judge: 'openai:gpt-4o', score: 4 }], 4),
    ];
    const summary = buildVariantSummary(entries);
    assert.deepEqual(summary.judgeModels, ['claude:opus', 'openai:gpt-4o']);
    assert.equal(summary.judgeAgreement?.pearson, 1);
    assert.equal(summary.judgeAgreement?.meanAbsDiff, 0);
    assert.equal(summary.judgeAgreement?.sampleCount, 5);
    assert.equal(summary.judgeAgreement?.pairCount, 1);
  });

  it('two judges with rank-reversed scores → Pearson=-1', () => {
    // claude scores 1..5, openai scores 5..1
    const entries = [
      makeEntry([{ judge: 'claude:opus', score: 1 }, { judge: 'openai:gpt-4o', score: 5 }], 3),
      makeEntry([{ judge: 'claude:opus', score: 2 }, { judge: 'openai:gpt-4o', score: 4 }], 3),
      makeEntry([{ judge: 'claude:opus', score: 3 }, { judge: 'openai:gpt-4o', score: 3 }], 3),
      makeEntry([{ judge: 'claude:opus', score: 4 }, { judge: 'openai:gpt-4o', score: 2 }], 3),
      makeEntry([{ judge: 'claude:opus', score: 5 }, { judge: 'openai:gpt-4o', score: 1 }], 3),
    ];
    const summary = buildVariantSummary(entries);
    assert.equal(summary.judgeAgreement?.pearson, -1);
    // MAD: |1-5|+|2-4|+|3-3|+|4-2|+|5-1| = 12, /5 = 2.4
    assert.ok(Math.abs(summary.judgeAgreement!.meanAbsDiff - 2.4) < 0.01);
  });

  it('three judges → 3 pairs averaged', () => {
    const entries = [
      makeEntry([
        { judge: 'a', score: 3 }, { judge: 'b', score: 3 }, { judge: 'c', score: 3 },
      ], 3),
      makeEntry([
        { judge: 'a', score: 4 }, { judge: 'b', score: 4 }, { judge: 'c', score: 4 },
      ], 4),
    ];
    const summary = buildVariantSummary(entries);
    assert.equal(summary.judgeAgreement?.pairCount, 3);  // 3 choose 2
    assert.equal(summary.judgeAgreement?.meanAbsDiff, 0);
    assert.equal(summary.judgeAgreement?.sampleCount, 2);
  });

  it('single sample with ensemble → no aggregate (need >= 2 aligned points)', () => {
    const entries = [
      makeEntry([{ judge: 'claude:opus', score: 4 }, { judge: 'openai:gpt-4o', score: 4 }], 4),
    ];
    const summary = buildVariantSummary(entries);
    // Only 1 sample, so judgeAgreement should be omitted (not enough for Pearson).
    // judgeModels list still surfaces.
    assert.deepEqual(summary.judgeModels, ['claude:opus', 'openai:gpt-4o']);
    assert.equal(summary.judgeAgreement, undefined);
  });

  it('no ensemble data → no aggregate fields', () => {
    const entries = [
      {
        ok: true, durationMs: 100, durationApiMs: 100,
        inputTokens: 100, outputTokens: 50, totalTokens: 150,
        cacheReadTokens: 0, cacheCreationTokens: 0,
        execCostUSD: 0, judgeCostUSD: 0, costUSD: 0,
        numTurns: 1, llmScore: 4, outputPreview: 'ok',
      } as VariantResult,
    ];
    const summary = buildVariantSummary(entries);
    assert.equal(summary.judgeAgreement, undefined);
    assert.equal(summary.judgeModels, undefined);
  });

  it('rows with judge failure (score=0) excluded from aligned matrix', () => {
    // 3 samples, sample 2 has openai failure
    const entries = [
      makeEntry([{ judge: 'claude:opus', score: 3 }, { judge: 'openai:gpt-4o', score: 3 }], 3),
      makeEntry([{ judge: 'claude:opus', score: 4 }, { judge: 'openai:gpt-4o', score: 0 }], 4),
      makeEntry([{ judge: 'claude:opus', score: 5 }, { judge: 'openai:gpt-4o', score: 5 }], 5),
    ];
    const summary = buildVariantSummary(entries);
    // Only 2 rows aligned (samples 1 & 3); sample 2 dropped
    assert.equal(summary.judgeAgreement?.sampleCount, 2);
    assert.equal(summary.judgeAgreement?.pearson, 1);
  });
});
