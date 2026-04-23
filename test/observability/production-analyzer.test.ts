import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeSkillHealthFromSegments,
} from '../../src/observability/production-analyzer.js';
import type { CcSession, SkillSegment } from '../../src/observability/trace-adapter.js';

// ---------- Helpers ----------

function makeSegment(
  skillName: string,
  segmentIndex: number,
  opts: {
    sessionId?: string;
    startTimestamp?: string;
    toolCalls?: Array<{ tool: string; input?: unknown; output?: unknown; success?: boolean }>;
    turnContent?: string;
  } = {},
): SkillSegment {
  const sessionId = opts.sessionId ?? 's1';
  const timestamp = opts.startTimestamp ?? '2026-04-19T10:00:00.000Z';
  const toolCalls = (opts.toolCalls ?? []).map((tc) => ({
    tool: tc.tool,
    input: tc.input ?? {},
    output: tc.output ?? '',
    success: tc.success !== false,
  }));
  const numFails = toolCalls.filter((t) => !t.success).length;
  return {
    skillName,
    sessionId,
    segmentIndex,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
    turns: opts.turnContent
      ? [{ role: 'assistant', content: opts.turnContent, toolCalls }]
      : [{ role: 'assistant', content: '', toolCalls }],
    toolCalls,
    metrics: {
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 1,
      numToolCalls: toolCalls.length,
      numToolFailures: numFails,
    },
  };
}

function makeSession(sessionId: string, cwd?: string): CcSession {
  return {
    sessionId,
    sourcePath: `/tmp/${sessionId}.jsonl`,
    records: [],
    cwd,
    startTimestamp: '2026-04-19T00:00:00.000Z',
    endTimestamp: '2026-04-19T23:59:59.000Z',
  };
}

// ---------- Tests ----------

describe('computeSkillHealthFromSegments', () => {
  it('groups segments by skill, each skill gets own gap report', () => {
    const segs = [
      makeSegment('audit', 0, {
        sessionId: 's1',
        toolCalls: [{ tool: 'Grep', input: { pattern: 'x' }, output: 'No matches found', success: true }],
      }),
      makeSegment('audit', 0, {
        sessionId: 's2',
        toolCalls: [{ tool: 'Read', input: { file_path: '/x.md' }, success: true }],
      }),
      makeSegment('polish', 0, {
        sessionId: 's3',
        toolCalls: [{ tool: 'Grep', input: { pattern: 'y' }, output: 'No matches found', success: true }],
      }),
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1'), makeSession('s2'), makeSession('s3')], '/tmp');

    assert.ok('audit' in report.bySkill);
    assert.ok('polish' in report.bySkill);
    assert.equal(report.bySkill.audit.segmentCount, 2);
    assert.equal(report.bySkill.polish.segmentCount, 1);
    // audit 有 1 个 failed_search signal (Grep No matches found)
    assert.equal(report.bySkill.audit.gap.byType.failed_search, 1);
    // polish 也有 1 个
    assert.equal(report.bySkill.polish.gap.byType.failed_search, 1);
  });

  it('overall weightedGapRate aggregates across skills by segment count', () => {
    // audit: 2 segs, 1 有 failed_search (w=1.0) → weighted=0.5, sampleCount=2
    // polish: 1 seg, 无信号 → weighted=0, sampleCount=1
    // total weighted = (0.5*2 + 0*1) / 3 = 0.333
    const segs = [
      makeSegment('audit', 0, { sessionId: 's1', toolCalls: [{ tool: 'Grep', output: 'No matches found' }] }),
      makeSegment('audit', 0, { sessionId: 's2', toolCalls: [{ tool: 'Read', success: true }] }),
      makeSegment('polish', 0, { sessionId: 's3', toolCalls: [{ tool: 'Read', success: true }] }),
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1'), makeSession('s2'), makeSession('s3')], '/tmp');
    assert.ok(report.overall.gapRate > 0);
    // 1 sample with gap out of 3 = 0.3333
    assert.equal(report.overall.gapRate, 0.3333);
    // weighted: audit 0.5 * 2 + polish 0 * 1 = 1.0 / 3 = 0.3333
    assert.equal(report.overall.weightedGapRate, 0.3333);
    assert.equal(report.overall.healthBand, 'red'); // >= 0.3
  });

  it('health band green when weightedGapRate < 0.1', () => {
    const segs = [
      makeSegment('audit', 0, { toolCalls: [{ tool: 'Read', success: true }] }),
      makeSegment('audit', 0, { toolCalls: [{ tool: 'Read', success: true }] }),
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/tmp');
    assert.equal(report.overall.healthBand, 'green');
    assert.equal(report.overall.gapRate, 0);
  });

  it('time window filter excludes out-of-range segments', () => {
    const segs = [
      makeSegment('audit', 0, { startTimestamp: '2026-04-10T10:00:00.000Z' }),
      makeSegment('audit', 0, { startTimestamp: '2026-04-15T10:00:00.000Z' }),
      makeSegment('audit', 0, { startTimestamp: '2026-04-20T10:00:00.000Z' }),
    ];
    const report = computeSkillHealthFromSegments(
      segs,
      [makeSession('s1')],
      '/tmp',
      { from: '2026-04-14T00:00:00.000Z', to: '2026-04-18T00:00:00.000Z' },
    );
    // 只第 2 个 segment 落在窗内
    assert.equal(report.meta.segmentCount, 1);
    assert.equal(report.bySkill.audit.segmentCount, 1);
  });

  it('skill whitelist filter limits analysis scope', () => {
    const segs = [
      makeSegment('audit', 0),
      makeSegment('polish', 0),
      makeSegment('typeset', 0),
    ];
    const report = computeSkillHealthFromSegments(
      segs,
      [makeSession('s1')],
      '/tmp',
      { skills: ['audit'] },
    );
    assert.ok('audit' in report.bySkill);
    assert.ok(!('polish' in report.bySkill));
    assert.equal(report.meta.segmentCount, 1);
  });

  it('no kbRoot → coverage is null but gap still computed', () => {
    const segs = [
      makeSegment('audit', 0, { toolCalls: [{ tool: 'Grep', output: 'No matches found' }] }),
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.coverage, null);
    assert.ok(report.bySkill.audit.gap);
    assert.equal(report.bySkill.audit.gap.byType.failed_search, 1);
  });

  it('gap report carries tracePath as testSetPath watermark', () => {
    const segs = [makeSegment('audit', 0, { toolCalls: [{ tool: 'Read', success: true }] })];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/my/trace/dir');
    assert.equal(report.bySkill.audit.gap.testSetPath, '/my/trace/dir');
  });

  it('empty segments → empty report does not crash', () => {
    const report = computeSkillHealthFromSegments([], [], '/tmp');
    assert.equal(report.meta.segmentCount, 0);
    assert.deepEqual(report.bySkill, {});
    assert.equal(report.overall.gapRate, 0);
    assert.equal(report.overall.healthBand, 'green');
  });

  it('per-skill toolFailureRate computed; stability stable when failures < 20%', () => {
    const segs = [
      makeSegment('audit', 0, {
        toolCalls: [
          { tool: 'Read', success: true },
          { tool: 'Read', success: true },
          { tool: 'Read', success: true },
          { tool: 'Read', success: true },
          { tool: 'Read', success: false },
        ],
      }),
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.toolCallCount, 5);
    assert.equal(report.bySkill.audit.toolFailureCount, 1);
    assert.equal(report.bySkill.audit.toolFailureRate, 0.2);
    assert.equal(report.bySkill.audit.stability, 'unstable');
  });

  it('stability flips to very-unstable when failure rate >= 40%', () => {
    const segs = [
      makeSegment('flaky-skill', 0, {
        toolCalls: [
          { tool: 'Bash', success: false },
          { tool: 'Bash', success: false },
          { tool: 'Bash', success: false },
          { tool: 'Bash', success: true },
          { tool: 'Bash', success: true },
        ],
      }),
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill['flaky-skill'].toolFailureRate, 0.6);
    assert.equal(report.bySkill['flaky-skill'].stability, 'very-unstable');
  });

  it('toolCallCount=0 → toolFailureRate=0, stability=stable', () => {
    const segs = [makeSegment('talker', 0, { toolCalls: [] })];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.talker.toolFailureRate, 0);
    assert.equal(report.bySkill.talker.stability, 'stable');
  });
});
