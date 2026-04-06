import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractWeakSamples, buildImprovementPrompt, evolveSkill } from '../../lib/authoring/evolver.js';
import type { Report } from '../../lib/types.js';

function toReport(value: unknown): Report {
  return value as Report;
}

describe('extractWeakSamples', () => {
  const mockReport = {
    results: [
      { sample_id: 's001', variants: { skill: { compositeScore: 4.5, llmReason: 'Good', assertions: { details: [{ type: 'contains', value: 'SQL', passed: true }] } } } },
      { sample_id: 's002', variants: { skill: { compositeScore: 2.0, llmReason: 'Missing key points', assertions: { details: [{ type: 'contains', value: 'error', passed: false }] } } } },
      { sample_id: 's003', variants: { skill: { compositeScore: 3.0, llmReason: 'Partial', assertions: { details: [] }, dimensions: { security: { score: 3 }, actionability: { score: 4 } } } } },
    ],
  };

  it('returns samples sorted by score ascending', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill');
    assert.equal(weak[0].sample_id, 's002');
    assert.equal(weak[1].sample_id, 's003');
    assert.equal(weak[2].sample_id, 's001');
  });

  it('respects count limit', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill', 2);
    assert.equal(weak.length, 2);
  });

  it('includes failed assertions', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill');
    assert.equal(weak[0].failedAssertions.length, 1);
    assert.ok(weak[0].failedAssertions[0].includes('contains'));
  });

  it('includes dimension scores', () => {
    const weak = extractWeakSamples(toReport(mockReport), 'skill');
    const s003 = weak.find((s: { sample_id: string }) => s.sample_id === 's003');
    assert.equal(s003!.dimensions!.security, 3);
    assert.equal(s003!.dimensions!.actionability, 4);
  });
});

describe('buildImprovementPrompt', () => {
  it('includes skill content and score', () => {
    const prompt = buildImprovementPrompt('你是一个助手', 3.5, []);
    assert.ok(prompt.includes('你是一个助手'));
    assert.ok(prompt.includes('3.50'));
  });

  it('includes weak sample details', () => {
    const weakSamples = [
      { sample_id: 's001', compositeScore: 2.0, llmReason: 'Missing analysis', failedAssertions: ['contains: SQL'], dimensions: null },
    ];
    const prompt = buildImprovementPrompt('test skill', 3.0, weakSamples);
    assert.ok(prompt.includes('s001'));
    assert.ok(prompt.includes('2/5.0'));
    assert.ok(prompt.includes('Missing analysis'));
    assert.ok(prompt.includes('contains: SQL'));
  });
});

describe('evolveSkill', () => {
  it('is a function', () => {
    assert.equal(typeof evolveSkill, 'function');
  });
});
