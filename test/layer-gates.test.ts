import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { evaluateLayerGates } from '../src/eval-core/layer-gates.js';
import type { VariantSummary } from '../src/types/index.js';

function mkSummary(seed: Partial<VariantSummary>): VariantSummary {
  return {
    totalSamples: 5, successCount: 5, errorCount: 0, errorRate: 0,
    avgDurationMs: 2000, avgInputTokens: 100, avgOutputTokens: 500, avgTotalTokens: 600,
    totalCostUSD: 0.01, totalExecCostUSD: 0.01, totalJudgeCostUSD: 0,
    avgCostPerSample: 0.002, avgNumTurns: 1,
    ...seed,
  };
}

describe('evaluateLayerGates — PR-3 three-layer gate', () => {
  it('PASS when all three layers meet threshold', () => {
    const summary = {
      v1: mkSummary({ avgFactScore: 4.2, avgBehaviorScore: 4.0, avgJudgeScore: 3.8 }),
    };
    const { allPass, lines } = evaluateLayerGates(summary, 3.5);
    assert.equal(allPass, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^PASS: v1/);
    // No ✗ markers when all layers pass
    assert.ok(!lines[0].includes('✗'));
  });

  it('FAIL when any single layer falls below threshold', () => {
    const summary = {
      v2: mkSummary({ avgFactScore: 2.8, avgBehaviorScore: 4.2, avgJudgeScore: 4.5 }),
    };
    const { allPass, lines } = evaluateLayerGates(summary, 3.5);
    assert.equal(allPass, false);
    assert.match(lines[0], /^FAIL: v2/);
    // Fact layer should be marked with ✗, others not
    assert.match(lines[0], /Fact=2\.80 ✗/);
    assert.match(lines[0], /Behavior=4\.20(?! ✗)/);
    assert.match(lines[0], /judge=4\.50(?! ✗)/);
  });

  it('FAIL with hint when all three layers are absent', () => {
    const summary = { v3: mkSummary({}) };
    const { allPass, lines } = evaluateLayerGates(summary, 3.5);
    assert.equal(allPass, false);
    assert.match(lines[0], /^FAIL: v3/);
    assert.match(lines[0], /无分层评分/);
    assert.match(lines[0], /请检查 eval-samples/);
    // Should NOT fall back to composite
    assert.ok(!lines[0].includes('composite'));
  });

  it('PASS with partial layers (fact + judge present, behavior absent)', () => {
    const summary = {
      v4: mkSummary({ avgFactScore: 4.0, avgJudgeScore: 4.2 }),
    };
    const { allPass, lines } = evaluateLayerGates(summary, 3.5);
    assert.equal(allPass, true);
    assert.match(lines[0], /^PASS: v4/);
    assert.match(lines[0], /Fact=4\.00/);
    assert.match(lines[0], /judge=4\.20/);
    assert.ok(!lines[0].includes('Behavior'));
  });

  it('mixed PASS / FAIL across variants, allPass reflects overall', () => {
    const summary = {
      good: mkSummary({ avgFactScore: 4.5, avgBehaviorScore: 4.3, avgJudgeScore: 4.1 }),
      bad:  mkSummary({ avgFactScore: 2.0, avgBehaviorScore: 4.0, avgJudgeScore: 4.0 }),
    };
    const { allPass, lines } = evaluateLayerGates(summary, 3.5);
    assert.equal(allPass, false);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^PASS: good/);
    assert.match(lines[1], /^FAIL: bad/);
    assert.match(lines[1], /Fact=2\.00 ✗/);
  });

  it('layer at exactly threshold passes (>= not >)', () => {
    const summary = {
      edge: mkSummary({ avgFactScore: 3.5, avgBehaviorScore: 3.5, avgJudgeScore: 3.5 }),
    };
    const { allPass, lines } = evaluateLayerGates(summary, 3.5);
    assert.equal(allPass, true);
    assert.match(lines[0], /^PASS: edge/);
    assert.ok(!lines[0].includes('✗'));
  });
});
