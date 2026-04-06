import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mean, stddev, confidenceInterval, tTest } from '../lib/domain/index.js';

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
