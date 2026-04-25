import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  findSaturationPoint,
  buildCumulativeScores,
} from '../../src/analysis/saturation.js';

describe('findSaturationPoint — bootstrap-ci-width (default)', () => {
  it('declares saturated when CI width stops shrinking meaningfully', () => {
    // Stable scores — variance ~0, CI width converges fast.
    const scores: number[] = [];
    for (let i = 0; i < 60; i++) scores.push(4);
    // Build cumulative slices in chunks of 10.
    const cumulative: number[][] = [];
    for (let n = 10; n <= 60; n += 10) cumulative.push(scores.slice(0, n));
    const result = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, 3, 200, 1);
    assert.equal(result.saturated, true);
    assert.ok(result.atN! >= 30, `expected atN >= 30, got ${result.atN}`);
    assert.equal(result.confidence, 'high');
  });

  it('does NOT declare saturated when CI is still widening at the tail', () => {
    // Increasing variance — adding samples keeps revealing new spread.
    const cumulative = [
      [3, 3, 3, 3, 3, 3, 3, 3, 3, 3],
      [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
    ];
    const result = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, 3, 200, 1);
    assert.equal(result.saturated, false);
  });

  it('reports "数据点不足" when fewer than windowSize+1 checkpoints', () => {
    const cumulative = [[3, 3, 3], [3, 3, 3, 4]];
    const result = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, 3, 200, 1);
    assert.equal(result.saturated, false);
    assert.match(result.reason, /数据点不足/);
  });
});

describe('findSaturationPoint — slope', () => {
  it('saturates when mean stabilizes', () => {
    const cumulative: number[][] = [];
    const scores: number[] = [];
    // First 30 samples push mean from ~3 to ~4; thereafter all 4s.
    for (let i = 0; i < 30; i++) scores.push(3 + i / 30);
    for (let i = 0; i < 60; i++) scores.push(4);
    for (let n = 10; n <= scores.length; n += 10) cumulative.push(scores.slice(0, n));
    const result = findSaturationPoint(cumulative, 'slope', 0.005, 3, 200, 1);
    assert.equal(result.saturated, true);
  });

  it('does not saturate when mean is still climbing', () => {
    const scores = Array.from({ length: 50 }, (_, i) => 1 + i * 0.05);
    const cumulative: number[][] = [];
    for (let n = 10; n <= 50; n += 10) cumulative.push(scores.slice(0, n));
    const result = findSaturationPoint(cumulative, 'slope', 0.005, 3, 200, 1);
    assert.equal(result.saturated, false);
  });
});

describe('findSaturationPoint — plateau-height', () => {
  it('saturates when cumulative mean stabilizes', () => {
    // Each chunk has the same true mean so the cumulative mean barely moves.
    // Slight noise around 4.0 keeps the test honest.
    const cumulative: number[][] = [];
    let acc: number[] = [];
    const chunks = [
      Array(10).fill(3.9),
      Array(10).fill(4.1),
      Array(10).fill(3.9),
      Array(10).fill(4.1),
      Array(10).fill(3.95),
      Array(10).fill(4.05),
    ];
    for (const c of chunks) {
      acc = acc.concat(c);
      cumulative.push([...acc]);
    }
    const result = findSaturationPoint(cumulative, 'plateau-height', 0.1, 3, 200, 1);
    assert.equal(result.saturated, true, `saturation should hold; reason: ${result.reason}`);
  });

  it('does not saturate while means still drift > threshold', () => {
    const cumulative: number[][] = [];
    let acc: number[] = [];
    const chunks = [Array(10).fill(2), Array(10).fill(3), Array(10).fill(4), Array(10).fill(5)];
    for (const c of chunks) {
      acc = acc.concat(c);
      cumulative.push([...acc]);
    }
    const result = findSaturationPoint(cumulative, 'plateau-height', 0.1, 3, 200, 1);
    assert.equal(result.saturated, false);
  });
});

describe('confidence band', () => {
  it("'low' for cumulative samples < 20", () => {
    const cumulative = [[3, 3, 3, 3], [3, 3, 3, 3, 4, 4], [3, 3, 3, 3, 4, 4, 4, 4]];
    const result = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, 2, 200, 1);
    assert.equal(result.confidence, 'low');
  });

  it("'medium' between 20 and 50 cumulative samples", () => {
    const cumulative: number[][] = [];
    const scores = Array(40).fill(4);
    for (let n = 10; n <= 40; n += 10) cumulative.push(scores.slice(0, n));
    const result = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, 3, 200, 1);
    assert.equal(result.confidence, 'medium');
  });

  it("'high' at >= 50 cumulative samples", () => {
    const cumulative: number[][] = [];
    const scores = Array(80).fill(4);
    for (let n = 10; n <= 80; n += 10) cumulative.push(scores.slice(0, n));
    const result = findSaturationPoint(cumulative, 'bootstrap-ci-width', undefined, 3, 200, 1);
    assert.equal(result.confidence, 'high');
  });
});

describe('buildCumulativeScores', () => {
  it('produces cumulative slices from per-run arrays', () => {
    const runs = [[3, 4], [5], [2, 2, 4]];
    const cumulative = buildCumulativeScores(runs);
    assert.deepEqual(cumulative, [[3, 4], [3, 4, 5], [3, 4, 5, 2, 2, 4]]);
  });

  it('handles empty runs gracefully', () => {
    assert.deepEqual(buildCumulativeScores([]), []);
    assert.deepEqual(buildCumulativeScores([[]]), [[]]);
  });
});
