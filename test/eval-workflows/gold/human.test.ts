import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeKrippendorffAlpha,
  computeWeightedKappa,
  computePearson,
  computeAgreementEvidence,
  computeAgreementWithCI,
  type RatingPair,
} from '../../../src/eval-workflows/gold/human.js';

const pairsOf = (data: Array<[number, number]>): RatingPair[] =>
  data.map(([a, b], i) => ({ unitId: `u${i}`, coderA: a, coderB: b }));

describe('computeKrippendorffAlpha', () => {
  it('α = 1 for perfect agreement with variance', () => {
    const pairs = pairsOf([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    assert.equal(computeKrippendorffAlpha(pairs), 1);
  });

  it('α = -0.8 for perfect inversion of a 5-point scale', () => {
    // (1,5),(2,4),(3,3),(4,2),(5,1) — symmetric flip. Hand-computed: α = -0.8.
    const pairs = pairsOf([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]);
    const alpha = computeKrippendorffAlpha(pairs);
    assert.ok(Math.abs(alpha - -0.8) < 1e-9, `expected -0.8, got ${alpha}`);
  });

  it('α near 0 for random pairing on identical marginals', () => {
    // Both coders use {1,2,3,4,5} once each, but pairings are scrambled.
    const pairs = pairsOf([[1, 3], [2, 5], [3, 1], [4, 2], [5, 4]]);
    const alpha = computeKrippendorffAlpha(pairs);
    assert.ok(Math.abs(alpha) < 0.1, `expected |α| < 0.1, got ${alpha}`);
  });

  it('α = NaN when all ratings are identical (no variance to disagree about)', () => {
    const pairs = pairsOf([[3, 3], [3, 3], [3, 3]]);
    assert.ok(Number.isNaN(computeKrippendorffAlpha(pairs)));
  });

  it('α < 1 even when Pearson = 1 (constant offset case)', () => {
    // coderB = coderA + 1 — perfect linear, but agreement is not perfect.
    // Hand-computed: α ≈ 0.7083.
    const pairs = pairsOf([[1, 2], [2, 3], [3, 4], [4, 5]]);
    const alpha = computeKrippendorffAlpha(pairs);
    assert.ok(Math.abs(alpha - 0.7083) < 0.01, `expected ≈0.71, got ${alpha}`);
    assert.ok(alpha < 1, 'α must drop below 1 under constant offset');
  });

  it('returns NaN for empty input', () => {
    assert.ok(Number.isNaN(computeKrippendorffAlpha([])));
  });
});

describe('computeWeightedKappa', () => {
  it('κ = 1 for perfect agreement', () => {
    const pairs = pairsOf([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    const kappa = computeWeightedKappa(pairs);
    assert.ok(Math.abs(kappa - 1) < 1e-9, `expected 1, got ${kappa}`);
  });

  it('κ = -1 for perfect inversion on a 5-point scale', () => {
    const pairs = pairsOf([[1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]);
    const kappa = computeWeightedKappa(pairs);
    assert.ok(Math.abs(kappa - -1) < 1e-9, `expected -1, got ${kappa}`);
  });

  it('NaN when no rating variance on either side', () => {
    const pairs = pairsOf([[3, 3], [3, 3]]);
    assert.ok(Number.isNaN(computeWeightedKappa(pairs)));
  });
});

describe('computePearson', () => {
  it('r = 1 for perfectly linear pairs (offset case)', () => {
    const pairs = pairsOf([[1, 2], [2, 3], [3, 4], [4, 5]]);
    const r = computePearson(pairs);
    assert.ok(Math.abs(r - 1) < 1e-9, `expected 1, got ${r}`);
  });

  it('NaN when one coder has zero variance', () => {
    const pairs = pairsOf([[1, 3], [2, 3], [3, 3]]);
    assert.ok(Number.isNaN(computePearson(pairs)));
  });
});

describe('computeAgreementWithCI', () => {
  it('bootstrap CI on α covers the point estimate for tight-agreement data', () => {
    const pairs = pairsOf([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    const result = computeAgreementWithCI(pairs, { samples: 1000, seed: 42 });
    assert.equal(result.sampleCount, 10);
    // For all-agreement samples the bootstrap CI should be very tight around 1.
    assert.ok(result.alpha === 1 || Math.abs(result.alpha - 1) < 1e-6, `α=${result.alpha}`);
    assert.ok(result.alphaCI.high <= 1 + 1e-9, 'α CI upper bound must not exceed 1');
  });

  it('CI widens for noisier data — wider than 0 but bounded', () => {
    // Mix of agreement and small disagreement.
    const pairs = pairsOf([[1, 2], [2, 2], [3, 3], [4, 4], [5, 4], [1, 1], [2, 3], [3, 3], [4, 5], [5, 5]]);
    const result = computeAgreementWithCI(pairs, { samples: 1000, seed: 7 });
    const width = result.alphaCI.high - result.alphaCI.low;
    assert.ok(width > 0, 'noisy data should produce a non-zero CI width');
    assert.ok(width < 2, 'CI width on a [-1,1]-bounded metric should not blow up');
    assert.ok(result.alphaCI.low <= result.alpha && result.alpha <= result.alphaCI.high,
      `point estimate ${result.alpha} should fall inside CI [${result.alphaCI.low}, ${result.alphaCI.high}]`);
  });

  it('handles empty input without throwing', () => {
    const result = computeAgreementWithCI([], { samples: 100, seed: 1 });
    assert.equal(result.sampleCount, 0);
    assert.ok(Number.isNaN(result.alpha));
    assert.ok(Number.isNaN(result.weightedKappa));
    assert.ok(Number.isNaN(result.pearson));
  });
});

describe('computeAgreementEvidence', () => {
  it('reports the bootstrap interval as not applicable for perfect agreement', () => {
    const result = computeAgreementEvidence(
      pairsOf([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]),
      { samples: 100, seed: 42 },
    );
    assert.deepEqual(result.alphaInterval, {
      intervalStatus: 'missing',
      reasonCode: 'agreement-bootstrap-not-applicable-perfect',
      confidenceLevel: 0.95,
      drawCoverage: { plannedDraws: 100, observedDraws: 0, missingDraws: 100 },
    });
  });

  it('uses fixed expected disagreement so every non-degenerate draw is defined', () => {
    const result = computeAgreementEvidence(pairsOf([
      [1, 2], [2, 2], [3, 3], [4, 4], [5, 4],
      [1, 1], [2, 3], [3, 3], [4, 5], [5, 5],
    ]), { samples: 1_000, seed: 7 });
    assert.equal(result.alphaInterval.intervalStatus, 'observed');
    assert.deepEqual(result.alphaInterval.drawCoverage, {
      plannedDraws: 1_000,
      observedDraws: 1_000,
      missingDraws: 0,
    });
  });

  it('keeps degenerate resamples finite by retaining original expected disagreement', () => {
    const result = computeAgreementEvidence(pairsOf([[1, 2], [3, 3]]), {
      samples: 100,
      seed: 42,
    });
    assert.equal(result.alphaInterval.intervalStatus, 'observed');
    assert.deepEqual(result.alphaInterval.drawCoverage, {
      plannedDraws: 100,
      observedDraws: 100,
      missingDraws: 0,
    });
    if (result.alphaInterval.intervalStatus === 'observed') {
      assert.ok(result.alphaInterval.low >= -1);
      assert.ok(result.alphaInterval.high <= 1);
    }
  });

  it('rejects invalid interval configuration before drawing', () => {
    const pairs = pairsOf([[1, 1], [2, 2]]);
    assert.throws(() => computeAgreementEvidence(pairs, { samples: 0 }), /positive safe integer/);
    assert.throws(() => computeAgreementEvidence(pairs, { alpha: 1 }), /between 0 and 1/);
    assert.throws(() => computeAgreementEvidence(pairs, { seed: -1 }), /non-negative safe integer/);
  });
});
