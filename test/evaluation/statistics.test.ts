import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mean, stddev, confidenceInterval, tTest, effectSize } from '../../src/eval-core/statistics.js';

describe('mean', () => {
  it('computes numeric and empty-array boundaries', () => {
    assert.equal(mean([1, 2, 3, 4, 5]), 3);
    assert.equal(mean([]), 0);
  });
});

describe('stddev', () => {
  it('computes sample and degenerate boundaries', () => {
    const sd = stddev([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.ok(Math.abs(sd - 2.138) < 0.01);
    assert.equal(stddev([5]), 0);
    assert.equal(stddev([]), 0);
  });
});

describe('confidenceInterval', () => {
  it('computes interval and single-value boundaries', () => {
    const ci = confidenceInterval([3.5, 4.0, 3.8, 4.2, 3.9]);
    assert.ok(ci.mean > 3.8 && ci.mean < 4.0);
    assert.ok(ci.lower < ci.mean);
    assert.ok(ci.upper > ci.mean);

    const single = confidenceInterval([4.0]);
    assert.equal(single.mean, 4.0);
    assert.equal(single.lower, 4.0);
    assert.equal(single.upper, 4.0);
  });
});

describe('tTest', () => {
  const cases: Array<{
    name: string;
    a: number[];
    b: number[];
    check: (result: ReturnType<typeof tTest>) => void;
  }> = [
    {
      name: 'significant difference between very different groups',
      a: [1.0, 1.1, 0.9, 1.2, 0.8],
      b: [5.0, 4.9, 5.1, 4.8, 5.2],
      check: (result) => {
        assert.ok(result.significant);
        assert.ok(result.tStatistic < 0);
      },
    },
    {
      name: 'no significant difference between similar groups',
      a: [3.0, 3.1, 2.9, 3.0, 3.05],
      b: [3.0, 3.0, 3.1, 2.95, 3.0],
      check: (result) => assert.equal(result.significant, false),
    },
    {
      name: 'single-element arrays',
      a: [3],
      b: [4],
      check: (result) => {
        assert.equal(result.tStatistic, 0);
        assert.equal(result.significant, false);
      },
    },
  ];

  it('covers significance boundaries', () => {
    for (const testCase of cases) {
      testCase.check(tTest(testCase.a, testCase.b));
    }
  });
});

describe('effectSize', () => {
  const cases: Array<{
    name: string;
    a: number[];
    b: number[];
    check: (result: ReturnType<typeof effectSize>) => void;
  }> = [
    {
      name: 'insufficient data',
      a: [3],
      b: [4],
      check: (r) => {
        assert.equal(r.primary, 'none');
        assert.equal(r.magnitude, 'none');
        assert.equal(r.cohensD, 0);
        assert.equal(r.hedgesG, 0);
      },
    },
    {
      name: 'zero pooled stddev',
      a: [4, 4, 4],
      b: [3, 3, 3],
      check: (r) => assert.equal(r.primary, 'none'),
    },
    {
      name: 'large effect for clearly separated groups',
      a: [1.0, 1.1, 0.9, 1.2, 0.8],
      b: [5.0, 4.9, 5.1, 4.8, 5.2],
      check: (r) => {
        assert.ok(r.cohensD < -0.8, `expected large negative d, got ${r.cohensD}`);
        assert.ok(r.hedgesG < -0.8);
        assert.equal(r.magnitude, 'large');
      },
    },
    {
      name: 'prefers Hedges g when n1 + n2 < 20',
      a: [3.0, 3.5, 4.0],
      b: [3.5, 4.0, 4.5],
      check: (r) => {
        assert.equal(r.primary, 'g');
        assert.ok(Math.abs(r.hedgesG) < Math.abs(r.cohensD));
      },
    },
    {
      name: 'prefers Cohen d when n1 + n2 >= 20',
      a: Array.from({ length: 10 }, (_, i) => 3.0 + i * 0.05),
      b: Array.from({ length: 10 }, (_, i) => 3.2 + i * 0.05),
      check: (r) => {
        assert.equal(r.primary, 'd');
        assert.ok(Math.abs(r.cohensD - r.hedgesG) / Math.abs(r.cohensD) < 0.06);
      },
    },
    {
      name: 'negligible magnitude',
      a: [3.0, 3.1, 2.9, 3.05, 2.95],
      b: [3.02, 3.08, 2.92, 3.0, 2.98],
      check: (r) => assert.equal(r.magnitude, 'negligible'),
    },
    {
      name: 'medium magnitude',
      a: [3.0, 3.1, 2.9, 3.05, 2.95],
      b: [3.05, 3.15, 2.95, 3.10, 3.00],
      check: (r) => assert.equal(r.magnitude, 'medium'),
    },
    {
      name: 'Hedges g shrinks Cohen d without changing direction',
      a: [2.0, 2.5, 3.0, 3.5],
      b: [4.0, 4.5, 5.0, 5.5],
      check: (r) => {
        assert.ok(Math.abs(r.hedgesG) < Math.abs(r.cohensD));
        assert.equal(Math.sign(r.hedgesG), Math.sign(r.cohensD));
      },
    },
    {
      name: 'reports n1 and n2',
      a: [1, 2, 3],
      b: [4, 5, 6, 7],
      check: (r) => {
        assert.equal(r.n1, 3);
        assert.equal(r.n2, 4);
      },
    },
  ];

  it('covers effect-size boundaries', () => {
    for (const testCase of cases) {
      testCase.check(effectSize(testCase.a, testCase.b));
    }
  });
});
