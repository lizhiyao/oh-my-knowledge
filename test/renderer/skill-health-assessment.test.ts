import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { assessHealth } from '../../src/renderer/skill-detail-renderer.js';
import type { SkillIndexEntry } from '../../src/server/skill-index.js';

function entryWithEval(compositeScore: number, failCount = 0): SkillIndexEntry {
  const evalSnap = {
    reportId: 'r1',
    timestamp: '2026-05-16T00:00:00.000Z',
    variantName: 'skill',
    verdictLevel: 'fail',
    verdictHeadline: 'legacy gate fail',
    compositeScore,
    passCount: 7 - failCount,
    failCount,
    tripwireCount: 0,
    totalSamples: 7,
  };
  return {
    skillName: 'skill',
    doctor: null,
    eval: evalSnap,
    observe: null,
    doctorHistory: [],
    evalHistory: [evalSnap],
    observeHistory: [],
    band: 'green',
  };
}

describe('assessHealth', () => {
  it('marks eval failed samples as red regardless of composite score', () => {
    const h = assessHealth(entryWithEval(4.08, 1), [], 'zh');
    assert.equal(h.color, 'red');
    assert.equal(h.grade, 'unhealthy');
  });

  it('maps composite score to yellow (below 3.5) or green (above 3.5) when no failed samples', () => {
    assert.equal(assessHealth(entryWithEval(2.49), [], 'zh').color, 'yellow');
    assert.equal(assessHealth(entryWithEval(3.0), [], 'zh').color, 'yellow');
    assert.equal(assessHealth(entryWithEval(4.08), [], 'zh').color, 'green');
  });

  it('high-severity insight downgrades to red', () => {
    const h = assessHealth(entryWithEval(4.08), [{ severity: 'high' } as never], 'zh');
    assert.equal(h.color, 'red');
    assert.equal(h.grade, 'unhealthy');
  });
});
