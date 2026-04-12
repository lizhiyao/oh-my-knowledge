import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mean, stddev, confidenceInterval, tTest, effectSize } from '../../src/eval-core/statistics.js';

describe('mean', () => {
  it('computes mean of numbers', () => {
    assert.equal(mean([1, 2, 3, 4, 5]), 3);
  });

  it('returns 0 for empty array', () => {
    assert.equal(mean([]), 0);
  });
});

describe('stddev', () => {
  it('computes sample standard deviation', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] => mean=5, stddev≈2.138
    const sd = stddev([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(sd - 2.138) < 0.01);
  });

  it('returns 0 for single element', () => {
    assert.equal(stddev([5]), 0);
  });

  it('returns 0 for empty array', () => {
    assert.equal(stddev([]), 0);
  });
});

describe('confidenceInterval', () => {
  it('computes 95% CI', () => {
    const ci = confidenceInterval([3.5, 4.0, 3.8, 4.2, 3.9]);
    assert.ok(ci.mean > 3.8 && ci.mean < 4.0);
    assert.ok(ci.lower < ci.mean);
    assert.ok(ci.upper > ci.mean);
  });

  it('returns same value for single element', () => {
    const ci = confidenceInterval([4.0]);
    assert.equal(ci.mean, 4.0);
    assert.equal(ci.lower, 4.0);
    assert.equal(ci.upper, 4.0);
  });
});

describe('tTest', () => {
  it('detects significant difference between very different groups', () => {
    const a = [1.0, 1.1, 0.9, 1.2, 0.8];
    const b = [5.0, 4.9, 5.1, 4.8, 5.2];
    const result = tTest(a, b);
    assert.ok(result.significant);
    assert.ok(result.tStatistic < 0); // a < b
  });

  it('detects no significant difference between similar groups', () => {
    const a = [3.0, 3.1, 2.9, 3.0, 3.05];
    const b = [3.0, 3.0, 3.1, 2.95, 3.0];
    const result = tTest(a, b);
    assert.equal(result.significant, false);
  });

  it('handles single-element arrays gracefully', () => {
    const result = tTest([3], [4]);
    assert.equal(result.tStatistic, 0);
    assert.equal(result.significant, false);
  });
});

describe('effectSize', () => {
  it('returns none for insufficient data', () => {
    const r = effectSize([3], [4]);
    assert.equal(r.primary, 'none');
    assert.equal(r.magnitude, 'none');
    assert.equal(r.cohensD, 0);
    assert.equal(r.hedgesG, 0);
  });

  it('returns none when pooled stddev is zero', () => {
    // Both groups are constants — no variance
    const r = effectSize([4, 4, 4], [3, 3, 3]);
    assert.equal(r.primary, 'none');
  });

  it('computes large positive effect for clearly separated groups', () => {
    // mean_a = 1, mean_b = 5, pooled stddev ≈ 0.13 → d ≈ -30 (huge)
    const r = effectSize([1.0, 1.1, 0.9, 1.2, 0.8], [5.0, 4.9, 5.1, 4.8, 5.2]);
    assert.ok(r.cohensD < -0.8, `expected large negative d, got ${r.cohensD}`);
    assert.ok(r.hedgesG < -0.8);
    assert.equal(r.magnitude, 'large');
  });

  it('prefers Hedges g when n1 + n2 < 20', () => {
    const r = effectSize([3.0, 3.5, 4.0], [3.5, 4.0, 4.5]);
    assert.equal(r.primary, 'g');
    // Hedges correction shrinks magnitude, so |g| < |d|
    assert.ok(Math.abs(r.hedgesG) < Math.abs(r.cohensD));
  });

  it('prefers Cohen d when n1 + n2 >= 20', () => {
    const a = Array.from({ length: 10 }, (_, i) => 3.0 + i * 0.05);
    const b = Array.from({ length: 10 }, (_, i) => 3.2 + i * 0.05);
    const r = effectSize(a, b);
    assert.equal(r.primary, 'd');
    // d and g should be nearly identical at n1+n2=20 (correction < 5%)
    assert.ok(Math.abs(r.cohensD - r.hedgesG) / Math.abs(r.cohensD) < 0.06);
  });

  it('classifies magnitude negligible for nearly identical groups', () => {
    // mean diff ≈ 0, variance dominated → |g| < 0.2
    const neg = effectSize([3.0, 3.1, 2.9, 3.05, 2.95], [3.02, 3.08, 2.92, 3.0, 2.98]);
    assert.equal(neg.magnitude, 'negligible');
  });

  it('classifies magnitude medium for moderate separation', () => {
    // Small mean gap but tiny variance → medium effect
    const med = effectSize([3.0, 3.1, 2.9, 3.05, 2.95], [3.05, 3.15, 2.95, 3.10, 3.00]);
    assert.equal(med.magnitude, 'medium');
  });

  it('Hedges g magnitude is smaller than Cohen d in absolute value', () => {
    const r = effectSize([2.0, 2.5, 3.0, 3.5], [4.0, 4.5, 5.0, 5.5]);
    assert.ok(Math.abs(r.hedgesG) < Math.abs(r.cohensD));
    // Both should point in the same direction
    assert.equal(Math.sign(r.hedgesG), Math.sign(r.cohensD));
  });

  it('reports n1 and n2 correctly', () => {
    const r = effectSize([1, 2, 3], [4, 5, 6, 7]);
    assert.equal(r.n1, 3);
    assert.equal(r.n2, 4);
  });
});
