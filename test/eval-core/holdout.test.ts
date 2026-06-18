import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { splitHoldout, subsetCompositeScore, computeHoldoutBreakdown } from '../../src/eval-core/holdout.js';
import type { Report } from '../../src/types/index.js';

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i}`);

describe('splitHoldout', () => {
  it('returns null when ratio is 0 (off)', () => {
    assert.equal(splitHoldout(ids(20), 0), null);
  });

  it('returns null when either side would fall below the minimum subset', () => {
    // N=4, ratio 0.5 → holdout 2 < 3 → disabled.
    assert.equal(splitHoldout(ids(4), 0.5), null);
    // ratio > 1 → holdout > N → train negative → disabled.
    assert.equal(splitHoldout(ids(10), 1.5), null);
  });

  it('splits at an even stride into disjoint train / holdout covering all ids', () => {
    const split = splitHoldout(ids(10), 0.3);
    assert.ok(split);
    assert.equal(split!.holdoutIds.size, 3);
    assert.equal(split!.trainIds.size, 7);
    // Even stride over 10 with 3 held out → indices 0, 3, 6.
    assert.deepEqual([...split!.holdoutIds].sort(), ['s0', 's3', 's6']);
    // Disjoint and exhaustive.
    for (const id of split!.holdoutIds) assert.ok(!split!.trainIds.has(id));
    assert.equal(split!.holdoutIds.size + split!.trainIds.size, 10);
  });

  it('is deterministic across calls (stable split, no RNG)', () => {
    const a = splitHoldout(ids(17), 0.25);
    const b = splitHoldout(ids(17), 0.25);
    assert.deepEqual([...a!.holdoutIds], [...b!.holdoutIds]);
  });
});

/** Build a report where each sample's treatment composite is set by `scoreOf`. */
function mockReport(n: number, scoreOf: (id: string) => number): Report {
  return {
    results: ids(n).map((id) => ({
      sample_id: id,
      variants: { skill: { ok: true, compositeScore: scoreOf(id) } },
    })),
  } as unknown as Report;
}

describe('subsetCompositeScore', () => {
  it('averages the composite over the subset, matching the headline aggregation', () => {
    const report = mockReport(10, () => 4);
    const subset = new Set(['s0', 's3', 's6']);
    assert.equal(subsetCompositeScore(report, 'skill', subset), 4);
  });

  it('returns 0 when the subset has no scorable entries for the variant', () => {
    const report = mockReport(10, () => 4);
    assert.equal(subsetCompositeScore(report, 'skill', new Set(['nope'])), 0);
  });
});

describe('computeHoldoutBreakdown', () => {
  it('reports per-variant train vs holdout composite + subset sizes', () => {
    // N=10, ratio 0.3 → holdout = s0,s3,s6 (score 2), train = the rest (score 4).
    const holdoutIds = new Set(['s0', 's3', 's6']);
    const report = mockReport(10, (id) => (holdoutIds.has(id) ? 2 : 4));
    const breakdown = computeHoldoutBreakdown(report, ['skill'], 0.3, ids(10));
    assert.equal(breakdown.disabled, undefined);
    assert.equal(breakdown.ratio, 0.3);
    assert.deepEqual(breakdown.perVariant.skill, {
      trainScore: 4,
      holdoutScore: 2,
      trainCount: 7,
      holdoutCount: 3,
      trainScorable: 7,
      holdoutScorable: 3,
    });
  });

  it('counts scorable entries separately from the authored split size', () => {
    // s0/s3/s6 = holdout; give s0 a 0 composite (errored) → holdoutCount 3 but scorable 2.
    const holdoutIds = new Set(['s0', 's3', 's6']);
    const report = mockReport(10, (id) => (id === 's0' ? 0 : holdoutIds.has(id) ? 2 : 4));
    const breakdown = computeHoldoutBreakdown(report, ['skill'], 0.3, ids(10));
    assert.equal(breakdown.perVariant.skill.holdoutCount, 3);
    assert.equal(breakdown.perVariant.skill.holdoutScorable, 2);
    assert.equal(breakdown.perVariant.skill.trainScorable, 7);
  });

  it('binds the split to the authored order, not report.results insertion order', () => {
    // Same samples + scores, but report.results in a different (concurrent-completion)
    // insertion order must yield the SAME holdout breakdown — the split follows the
    // stable authored sampleIdOrder, not the results array order.
    const holdoutIds = new Set(['s0', 's3', 's6']);
    const scoreOf = (id: string): number => (holdoutIds.has(id) ? 2 : 4);
    const ordered = mockReport(10, scoreOf);
    const shuffled = { results: [...ordered.results].reverse() } as unknown as Report;
    const order = ids(10);
    const a = computeHoldoutBreakdown(ordered, ['skill'], 0.3, order);
    const b = computeHoldoutBreakdown(shuffled, ['skill'], 0.3, order);
    assert.deepEqual(a.perVariant, b.perVariant);
    assert.deepEqual(a.perVariant.skill, { trainScore: 4, holdoutScore: 2, trainCount: 7, holdoutCount: 3, trainScorable: 7, holdoutScorable: 3 });
  });

  it('marks disabled with an empty breakdown when the split is too small', () => {
    const report = mockReport(4, () => 4);
    const breakdown = computeHoldoutBreakdown(report, ['skill'], 0.5, ids(4));
    assert.equal(breakdown.disabled, true);
    assert.deepEqual(breakdown.perVariant, {});
  });
});
