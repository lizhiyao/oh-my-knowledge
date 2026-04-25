import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { bootstrapMeanCI, bootstrapDiffCI, bootstrapWithMetric } from '../../src/eval-core/bootstrap.js';

describe('bootstrapMeanCI', () => {
  it('CI on a tight sample contains the true mean', () => {
    // True mean is exactly 4. Bootstrap CI must contain it.
    const scores = [3, 4, 5, 4, 3, 5, 4, 4, 3, 5];
    const ci = bootstrapMeanCI(scores, 0.05, 1000, 42);
    assert.ok(ci.low <= 4 && 4 <= ci.high, `CI [${ci.low}, ${ci.high}] should contain 4`);
    assert.equal(ci.estimate, 4);
    assert.equal(ci.samples, 1000);
  });

  it('skewed distribution: bootstrap CI is wider on the longer tail than t-test would assume', () => {
    // Right-skewed: most values low, a few high. Bootstrap should reflect asymmetry.
    const scores = [1, 1, 1, 2, 2, 2, 3, 3, 5, 5];
    const ci = bootstrapMeanCI(scores, 0.05, 2000, 7);
    // Mean is 2.5. Distribution is right-skewed so high tail of CI > 2.5 + (2.5 - low).
    const lowTail = ci.estimate - ci.low;
    const highTail = ci.high - ci.estimate;
    assert.ok(highTail >= lowTail, `right-skewed sample should have right tail >= left tail (got ${lowTail} vs ${highTail})`);
  });

  it('N=2 boundary: CI is well-defined and bracketed by min/max', () => {
    const ci = bootstrapMeanCI([3, 5], 0.05, 500, 1);
    assert.ok(ci.low >= 3 && ci.high <= 5, `CI [${ci.low}, ${ci.high}] must lie in [3, 5]`);
    assert.equal(ci.estimate, 4);
  });

  it('N=1 boundary: returns the single value as both bounds', () => {
    const ci = bootstrapMeanCI([4.5], 0.05, 100, 1);
    assert.equal(ci.low, 4.5);
    assert.equal(ci.high, 4.5);
    assert.equal(ci.estimate, 4.5);
  });

  it('N=0 returns zeros without crashing', () => {
    const ci = bootstrapMeanCI([], 0.05, 100, 1);
    assert.equal(ci.low, 0);
    assert.equal(ci.high, 0);
    assert.equal(ci.estimate, 0);
    assert.equal(ci.samples, 0);
  });

  it('seeded calls are deterministic across runs', () => {
    const scores = [3, 4, 5, 4, 3];
    const a = bootstrapMeanCI(scores, 0.05, 500, 12345);
    const b = bootstrapMeanCI(scores, 0.05, 500, 12345);
    assert.deepEqual(a, b, 'same seed should give identical CI');
  });

  it('N=1000 samples completes well under 1 second', () => {
    const scores = Array.from({ length: 50 }, (_, i) => 3 + (i % 3));
    const start = Date.now();
    bootstrapMeanCI(scores, 0.05, 1000);
    const ms = Date.now() - start;
    assert.ok(ms < 1000, `1000 bootstrap samples took ${ms}ms, expected < 1000ms`);
  });
});

describe('bootstrapDiffCI', () => {
  it('clearly different distributions: significant=true, 0 outside CI', () => {
    const control = [3, 3, 4, 3, 3];      // mean 3.2
    const treatment = [5, 5, 4, 5, 5];    // mean 4.8 — clear improvement
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 99);
    assert.ok(ci.significant, 'large clean difference should be significant');
    assert.ok(ci.low > 0, `diff CI low ${ci.low} should be > 0 when treatment > control`);
    assert.ok(ci.estimate > 0, `estimate ${ci.estimate} should be positive (treatment - control)`);
  });

  it('identical distributions: significant=false, 0 inside CI', () => {
    const control = [3, 4, 5, 4, 3];
    const treatment = [3, 4, 5, 4, 3]; // same data → diff is 0 with no spread
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 7);
    assert.ok(!ci.significant, 'identical samples should not be significant');
    assert.ok(ci.low <= 0 && 0 <= ci.high, `0 must be inside [${ci.low}, ${ci.high}]`);
  });

  it('treatment worse than control: significant=true, CI entirely negative', () => {
    const control = [5, 5, 5, 4, 5];
    const treatment = [2, 2, 3, 2, 2];
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 13);
    assert.ok(ci.significant, 'large negative difference should be significant');
    assert.ok(ci.high < 0, `diff CI high ${ci.high} should be < 0 when treatment < control`);
  });

  it('overlapping but distinct: small effect needs wider CI to call significant', () => {
    // Tiny difference; CI may or may not include 0 depending on N
    const control = [3, 4, 4, 3, 4];     // mean 3.6
    const treatment = [4, 4, 4, 4, 4];   // mean 4.0 — small effect
    const ci = bootstrapDiffCI(control, treatment, 0.05, 1000, 21);
    // Whether significant or not, the estimate should be ~0.4
    assert.ok(Math.abs(ci.estimate - 0.4) < 0.001, `estimate ${ci.estimate} should be close to 0.4`);
  });

  it('seeded diff CI is deterministic', () => {
    const a = bootstrapDiffCI([3, 4, 5], [4, 5, 6], 0.05, 500, 555);
    const b = bootstrapDiffCI([3, 4, 5], [4, 5, 6], 0.05, 500, 555);
    assert.deepEqual(a, b);
  });
});

describe('bootstrapWithMetric', () => {
  it('stddev metric: CI brackets the original stddev', () => {
    const scores = [3, 4, 5, 4, 3, 4, 5, 3, 4, 5];
    const stddev = (arr: number[]): number => {
      if (arr.length < 2) return 0;
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
    };
    const ci = bootstrapWithMetric(scores, stddev, 0.05, 1000, 42);
    const trueStd = stddev(scores);
    // CI should contain the original stddev (which is itself a bootstrap point estimate)
    assert.ok(ci.low <= trueStd + 0.01 && ci.high >= trueStd - 0.01,
      `CI [${ci.low}, ${ci.high}] should bracket original stddev ${trueStd}`);
  });
});
