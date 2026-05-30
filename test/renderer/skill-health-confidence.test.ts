import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { renderSkillHealthReport } from '../../src/renderer/skill-health-renderer.js';
import type { SkillHealthReport } from '../../src/observability/skill-health-analyzer.js';

// Legacy *-skill-health.json predate the `confidence` field. The renderer must derive
// it from segmentCount instead of rendering `undefined confidence`, and an underpowered
// skill must not paint a hard band / red gap bar.
const legacyReport = (segmentCount: number): SkillHealthReport => ({
  meta: {
    tracePath: '/t', kbPath: null, sessionCount: 1, segmentCount,
    messageCount: 0, toolCallCount: 1, toolFailureRate: 0,
    timeRange: { from: '2026-05-09T00:00:00Z', to: '2026-05-09T01:00:00Z' },
    generatedAt: '2026-05-09T01:00:00Z',
  },
  bySkill: {
    audit: {
      skillName: 'audit', segmentCount, toolCallCount: 1, toolFailureCount: 0, toolFailureRate: 0,
      stability: 'stable',
      usage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
        totalTokens: 0, durationMs: 0, numTurns: 0, avgTokensPerSegment: 0, avgDurationMsPerSegment: 0,
      },
      coverage: null,
      gap: { gapRate: 0.5, weightedGapRate: 0.5, samplesWithGap: 1, sampleCount: segmentCount, byType: {} },
    },
    // `confidence` intentionally absent on overall + per-skill (legacy shape).
  } as unknown as SkillHealthReport['bySkill'],
  overall: { gapRate: 0.5, weightedGapRate: 0.5, healthBand: 'red' } as unknown as SkillHealthReport['overall'],
});

describe('skill-health renderer — confidence fallback for legacy reports', () => {
  it('never renders "undefined confidence" for a legacy report (P3)', () => {
    const html = renderSkillHealthReport(legacyReport(3), 'en');
    assert.doesNotMatch(html, /undefined confidence/);
    // segmentCount 3 → derived 'underpowered' → caveat present.
    assert.match(html, /underpowered confidence/);
  });

  it('mutes the per-skill gap bar instead of hard red when underpowered (P2)', () => {
    const html = renderSkillHealthReport(legacyReport(2), 'zh');
    // gapRate 50% would normally be red; underpowered must mute it to a faint colour.
    assert.match(html, /var\(--text-faint\)/);
  });

  it('a high-N legacy report derives high confidence and shows no caveat', () => {
    const html = renderSkillHealthReport(legacyReport(40), 'en');
    assert.doesNotMatch(html, /confidence; band is indicative/);
  });
});
