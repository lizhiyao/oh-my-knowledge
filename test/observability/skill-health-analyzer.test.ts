import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  computeSkillHealthFromSegments,
} from '../../src/observability/skill-health-analyzer.js';
import {
  segmentBySkill,
  type CcSession,
  type SkillSegment,
  type TraceSession,
} from '../../src/observability/trace-adapter.js';
import type { ToolCallStatus } from '../../src/types/index.js';

// ---------- Helpers ----------

function makeSegment(
  skillName: string,
  segmentIndex: number,
  opts: {
    sessionId?: string;
    startTimestamp?: string;
    timestampObserved?: boolean;
    toolCalls?: Array<{
      tool: string;
      input?: unknown;
      output?: unknown;
      success?: boolean;
      status?: ToolCallStatus;
    }>;
    turnContent?: string;
  } = {},
): SkillSegment {
  const sessionId = opts.sessionId ?? 's1';
  const timestamp = opts.startTimestamp ?? '2026-04-19T10:00:00.000Z';
  const toolCalls = (opts.toolCalls ?? []).map((tc) => {
    const status = tc.status ?? (tc.success === false ? 'failure' : 'success');
    return {
      tool: tc.tool,
      input: tc.input ?? {},
      output: tc.output ?? '',
      status,
      success: status === 'success',
    };
  });
  const numFails = toolCalls.filter((t) => t.status === 'failure').length;
  const numCancelled = toolCalls.filter((t) => t.status === 'cancelled').length;
  const numUnknown = toolCalls.filter((t) => t.status === 'unknown').length;
  return {
    skillName,
    sessionId,
    segmentIndex,
    startTimestamp: timestamp,
    endTimestamp: timestamp,
    ...(opts.timestampObserved === undefined
      ? {}
      : { timestampObserved: opts.timestampObserved }),
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
      tokenUsageObserved: false,
      numTurns: 1,
      numToolCalls: toolCalls.length,
      numToolFailures: numFails,
      numToolCancelled: numCancelled,
      numToolUnknown: numUnknown,
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

describe('statistical confidence guard', () => {
  const segs = (skill: string, n: number): SkillSegment[] =>
    Array.from({ length: n }, (_, i) => makeSegment(skill, i));

  it('flags a tiny sample as underpowered (per-skill and overall)', () => {
    const report = computeSkillHealthFromSegments(segs('audit', 2), [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.confidence, 'underpowered');
    assert.equal(report.overall.confidence, 'underpowered');
  });

  it('flags a mid-size sample as low confidence', () => {
    const report = computeSkillHealthFromSegments(segs('audit', 12), [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.confidence, 'low');
    assert.equal(report.overall.confidence, 'low');
  });

  it('marks a sufficiently large sample as high confidence', () => {
    const report = computeSkillHealthFromSegments(segs('audit', 25), [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.confidence, 'high');
    assert.equal(report.overall.confidence, 'high');
  });
});

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

  it('keeps untimestamped segments measurable without inventing a time range', () => {
    const report = computeSkillHealthFromSegments(
      [makeSegment('audit', 0, {
        startTimestamp: '1970-01-01T00:00:00.000Z',
        timestampObserved: false,
      })],
      [makeSession('s1')],
      '/tmp',
    );

    assert.equal(report.meta.segmentCount, 1);
    assert.equal(report.meta.timestampedSegmentCount, 0);
    assert.equal(report.meta.timestampCoverage, 0);
    assert.equal(report.meta.excludedUntimestampedSegmentCount, 0);
    assert.deepEqual(report.meta.timeRange, { from: '', to: '' });
  });

  it('excludes untimestamped segments from time-window measurements and discloses the exclusion', () => {
    const report = computeSkillHealthFromSegments(
      [makeSegment('audit', 0, {
        startTimestamp: '1970-01-01T00:00:00.000Z',
        timestampObserved: false,
      })],
      [makeSession('s1')],
      '/tmp',
      { from: '2026-04-01T00:00:00.000Z' },
    );

    assert.equal(report.meta.segmentCount, 0);
    assert.equal(report.meta.timestampedSegmentCount, 0);
    assert.equal(report.meta.timestampCoverage, 1);
    assert.equal(report.meta.excludedUntimestampedSegmentCount, 1);
    assert.deepEqual(report.meta.timeRange, { from: '', to: '' });
  });

  it('computes timestamp coverage within the selected skill scope', () => {
    const report = computeSkillHealthFromSegments(
      [
        makeSegment('audit', 0, { startTimestamp: '2026-04-15T10:00:00.000Z' }),
        makeSegment('audit', 1, {
          startTimestamp: '1970-01-01T00:00:00.000Z',
          timestampObserved: false,
        }),
        makeSegment('polish', 0, {
          startTimestamp: '1970-01-01T00:00:00.000Z',
          timestampObserved: false,
        }),
      ],
      [makeSession('s1')],
      '/tmp',
      { skills: ['audit'] },
    );

    assert.equal(report.meta.segmentCount, 2);
    assert.equal(report.meta.timestampedSegmentCount, 1);
    assert.equal(report.meta.timestampCoverage, 0.5);
    assert.equal(report.meta.excludedUntimestampedSegmentCount, 0);
    assert.deepEqual(report.meta.timeRange, {
      from: '2026-04-15T10:00:00.000Z',
      to: '2026-04-15T10:00:00.000Z',
    });
  });

  it('does not count untimestamped segments outside the selected skill as time-filter exclusions', () => {
    const report = computeSkillHealthFromSegments(
      [
        makeSegment('audit', 0, { startTimestamp: '2026-04-15T10:00:00.000Z' }),
        makeSegment('polish', 0, {
          startTimestamp: '1970-01-01T00:00:00.000Z',
          timestampObserved: false,
        }),
      ],
      [makeSession('s1')],
      '/tmp',
      {
        skills: ['audit'],
        from: '2026-04-14T00:00:00.000Z',
        to: '2026-04-18T00:00:00.000Z',
      },
    );

    assert.equal(report.meta.segmentCount, 1);
    assert.equal(report.meta.excludedUntimestampedSegmentCount, 0);
  });

  it('includes a segment whose execution interval crosses the time-window boundary', () => {
    const segment = makeSegment('audit', 0, {
      sessionId: 'crossing',
      startTimestamp: '2026-04-13T23:59:00.000Z',
    });
    segment.endTimestamp = '2026-04-14T00:01:00.000Z';
    const report = computeSkillHealthFromSegments(
      [segment],
      [makeSession('crossing')],
      '/tmp',
      { from: '2026-04-14T00:00:00.000Z' },
    );
    assert.equal(report.meta.segmentCount, 1);
  });

  it('skill whitelist filter limits analysis scope', () => {
    const segs = [
      makeSegment('audit', 0, { sessionId: 'audit-session' }),
      makeSegment('polish', 0, { sessionId: 'polish-session' }),
      makeSegment('typeset', 0, { sessionId: 'typeset-session' }),
    ];
    const report = computeSkillHealthFromSegments(
      segs,
      [
        makeSession('audit-session'),
        makeSession('polish-session'),
        makeSession('typeset-session'),
      ],
      '/tmp',
      { skills: ['audit'] },
    );
    assert.ok('audit' in report.bySkill);
    assert.ok(!('polish' in report.bySkill));
    assert.equal(report.meta.segmentCount, 1);
    assert.equal(report.meta.sessionCount, 1);
  });

  it('counts only messages inside the filtered skill ranges', () => {
    const session: TraceSession = {
      runId: 'shared',
      rootRunId: 'shared',
      traceId: 'shared-trace',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'shared',
      sourcePath: '/tmp/shared.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'message',
          eventId: 'audit-user',
          sourceIndex: 0,
          sourceType: 'message',
          role: 'user',
          origin: 'human',
          text: 'audit request',
        },
        {
          eventKind: 'message',
          eventId: 'audit-assistant',
          sourceIndex: 1,
          sourceType: 'message',
          role: 'assistant',
          origin: 'synthetic',
          text: 'audit response',
        },
        {
          eventKind: 'message',
          eventId: 'polish-user',
          sourceIndex: 2,
          sourceType: 'message',
          role: 'user',
          origin: 'human',
          text: 'polish request',
        },
        {
          eventKind: 'message',
          eventId: 'polish-assistant',
          sourceIndex: 3,
          sourceType: 'message',
          role: 'assistant',
          origin: 'synthetic',
          text: 'polish response',
        },
      ],
    };
    const audit = {
      ...makeSegment('audit', 0, { sessionId: 'shared', turnContent: 'audit response' }),
      traceId: 'shared-trace',
      sourceTrace: session.sourcePath,
      startRecordIndex: 0,
      endRecordIndex: 1,
    };
    const polish = {
      ...makeSegment('polish', 1, { sessionId: 'shared', turnContent: 'polish response' }),
      traceId: 'shared-trace',
      sourceTrace: session.sourcePath,
      startRecordIndex: 2,
      endRecordIndex: 3,
    };

    const report = computeSkillHealthFromSegments(
      [audit, polish],
      [session],
      '/tmp',
      { skills: ['audit'] },
    );
    assert.equal(report.meta.sessionCount, 1);
    assert.equal(report.meta.segmentCount, 1);
    assert.equal(report.meta.messageCount, 2);
  });

  it('keeps unattributed general segments out of skill health statistics', () => {
    const report = computeSkillHealthFromSegments(
      [makeSegment('general', 0), makeSegment('audit', 1)],
      [makeSession('s1')],
      '/tmp',
    );
    assert.deepEqual(Object.keys(report.bySkill), ['audit']);
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

  it('excludes unknown tool outcomes from the failure-rate denominator', () => {
    const segment = makeSegment('audit', 0, {
      toolCalls: [
        { tool: 'Edit', success: true },
        { tool: 'Edit', success: false },
        { tool: 'Edit', success: false },
      ],
    });
    segment.toolCalls[2].status = 'unknown';
    segment.toolCalls[2].statusSource = 'unknown';
    segment.metrics.numToolFailures = 1;
    segment.metrics.numToolUnknown = 1;

    const report = computeSkillHealthFromSegments([segment], [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.toolUnknownCount, 1);
    assert.equal(report.bySkill.audit.toolResolvedCount, 2);
    assert.equal(report.bySkill.audit.toolOutcomeCoverage, 0.6667);
    assert.equal(report.bySkill.audit.toolFailureRate, 0.5);
    assert.equal(report.meta.toolUnknownCount, 1);
    assert.equal(report.meta.toolResolvedCount, 2);
    assert.equal(report.meta.toolFailureRate, 0.5);
  });

  it('does not label a high failure rate very unstable with fewer than five resolved outcomes', () => {
    const segment = makeSegment('audit', 0, {
      toolCalls: [
        { tool: 'Edit', success: false },
        { tool: 'Edit', success: false },
      ],
    });
    segment.toolCalls[1].status = 'unknown';
    segment.toolCalls[1].statusSource = 'unknown';
    segment.metrics.numToolFailures = 1;
    segment.metrics.numToolUnknown = 1;

    const report = computeSkillHealthFromSegments([segment], [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.toolFailureRate, 1);
    assert.equal(report.bySkill.audit.toolResolvedCount, 1);
    assert.equal(report.bySkill.audit.stability, 'unstable');
  });

  it('marks stability unknown when no tool outcome can be resolved', () => {
    const segment = makeSegment('audit', 0, {
      toolCalls: [{ tool: 'Edit', success: false }],
    });
    segment.toolCalls[0].status = 'unknown';
    segment.toolCalls[0].statusSource = 'unknown';
    segment.metrics.numToolFailures = 0;
    segment.metrics.numToolUnknown = 1;

    const report = computeSkillHealthFromSegments([segment], [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.toolResolvedCount, 0);
    assert.equal(report.bySkill.audit.toolOutcomeCoverage, 0);
    assert.equal(report.bySkill.audit.toolFailureRate, 0);
    assert.equal(report.bySkill.audit.stability, 'unknown');
  });

  it('tracks cancelled outcomes without inflating the tool failure rate', () => {
    const segment = makeSegment('audit', 0, {
      toolCalls: [
        { tool: 'Edit', success: true, status: 'success' },
        { tool: 'Edit', success: false, status: 'cancelled' },
      ],
    });
    segment.metrics.numToolFailures = 0;
    segment.metrics.numToolCancelled = 1;
    segment.metrics.numToolUnknown = 0;

    const report = computeSkillHealthFromSegments([segment], [makeSession('s1')], '/tmp');
    assert.equal(report.bySkill.audit.toolCancelledCount, 1);
    assert.equal(report.bySkill.audit.toolResolvedCount, 2);
    assert.equal(report.bySkill.audit.toolOutcomeCoverage, 1);
    assert.equal(report.bySkill.audit.toolFailureRate, 0);
    assert.equal(report.bySkill.audit.stability, 'stable');
    assert.equal(report.meta.toolCancelledCount, 1);
    assert.equal(report.meta.toolFailureRate, 0);
  });

  it('counts Trace IR messages instead of every event as a message', () => {
    const session: TraceSession = {
      runId: 'trace-1',
      rootRunId: 'trace-1',
      traceId: 'trace-1',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'trace-1',
      sourcePath: '/tmp/trace-1.jsonl',
      sourceKind: 'codex',
      events: [
        {
          eventKind: 'message',
          eventId: 'm1',
          sourceIndex: 0,
          sourceType: 'message',
          role: 'user',
          origin: 'human',
          text: 'hello',
        },
        {
          eventKind: 'tool_call',
          eventId: 't1',
          sourceIndex: 1,
          sourceType: 'tool',
          callId: 'call-1',
          tool: { name: 'Read' },
          input: {},
        },
        {
          eventKind: 'usage',
          eventId: 'u1',
          sourceIndex: 1,
          sourceType: 'usage',
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          eventKind: 'message',
          eventId: 'm2',
          sourceIndex: 2,
          sourceType: 'message',
          role: 'assistant',
          origin: 'synthetic',
          text: 'done',
        },
      ],
    };
    const report = computeSkillHealthFromSegments(
      [makeSegment('audit', 0, { sessionId: 'trace-1' })],
      [session],
      '/tmp',
    );
    assert.equal(report.meta.messageCount, 2);
  });

  it('keeps legacy messageCount aligned with Trace IR by excluding tool-only wrappers', () => {
    const session: CcSession = {
      ...makeSession('legacy-1'),
      records: [
        {
          type: 'user',
          message: { role: 'user', content: 'hello' },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }],
          },
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
          },
        },
        {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
        },
      ],
    };
    const report = computeSkillHealthFromSegments(
      [makeSegment('audit', 0, { sessionId: 'legacy-1' })],
      [session],
      '/tmp',
    );
    assert.equal(report.meta.messageCount, 2);
  });

  it('resolves canonical trace identity for legacy sessions without duplicating adapter logic', () => {
    const session: CcSession = {
      ...makeSession('legacy-canonical-id'),
      records: [
        {
          type: 'user',
          uuid: 'u1',
          parentUuid: null,
          sessionId: 'legacy-canonical-id',
          timestamp: '2026-04-19T10:00:00.000Z',
          message: {
            role: 'user',
            content: '<command-name>/audit</command-name>\nInspect this.',
          },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          parentUuid: 'u1',
          sessionId: 'legacy-canonical-id',
          timestamp: '2026-04-19T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }],
          },
        },
      ],
    };
    const segments = segmentBySkill(session);
    assert.match(segments[0].traceId ?? '', /^trace:[a-f0-9]{32}$/);

    const report = computeSkillHealthFromSegments(segments, [session], '/tmp');
    assert.equal(report.meta.sessionCount, 1);
    assert.equal(report.meta.messageCount, 2);
  });

  it('usage aggregates tokens/duration/turns from SkillSegment metrics', () => {
    const segs: SkillSegment[] = [
      {
        skillName: 'audit',
        sessionId: 's1',
        segmentIndex: 0,
        startTimestamp: '2026-04-19T10:00:00.000Z',
        endTimestamp: '2026-04-19T10:00:00.000Z',
        turns: [],
        toolCalls: [],
        metrics: {
          durationMs: 2000,
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 200,
          cacheCreationTokens: 100,
          tokenUsageObserved: true,
          numTurns: 3,
          numToolCalls: 0,
          numToolFailures: 0,
          numToolUnknown: 0,
        },
      },
      {
        skillName: 'audit',
        sessionId: 's2',
        segmentIndex: 0,
        startTimestamp: '2026-04-19T11:00:00.000Z',
        endTimestamp: '2026-04-19T11:00:00.000Z',
        turns: [],
        toolCalls: [],
        metrics: {
          durationMs: 4000,
          inputTokens: 2000,
          outputTokens: 1000,
          cacheReadTokens: 400,
          cacheCreationTokens: 200,
          tokenUsageObserved: true,
          numTurns: 5,
          numToolCalls: 0,
          numToolFailures: 0,
          numToolUnknown: 0,
        },
      },
    ];
    const report = computeSkillHealthFromSegments(segs, [makeSession('s1')], '/tmp');
    const u = report.bySkill.audit.usage;
    assert.equal(u.inputTokens, 3000);
    assert.equal(u.outputTokens, 1500);
    assert.equal(u.cacheReadTokens, 600);
    assert.equal(u.cacheCreationTokens, 300);
    assert.equal(u.totalTokens, 5400);
    assert.equal(u.tokenObservedSegmentCount, 2);
    assert.equal(u.tokenCoverage, 1);
    assert.equal(u.durationMs, 6000);
    assert.equal(u.numTurns, 8);
    assert.equal(u.avgTokensPerSegment, 2700);
    assert.equal(u.avgDurationMsPerSegment, 3000);
  });

  it('excludes unobserved token placeholders and exposes partial coverage', () => {
    const measured = makeSegment('audit', 0, { sessionId: 's1' });
    measured.metrics.inputTokens = 100;
    measured.metrics.outputTokens = 20;
    measured.metrics.tokenUsageObserved = true;
    const unobserved = makeSegment('audit', 0, { sessionId: 's2' });
    unobserved.metrics.inputTokens = 0;
    unobserved.metrics.outputTokens = 0;
    unobserved.metrics.tokenUsageObserved = false;

    const usage = computeSkillHealthFromSegments(
      [measured, unobserved],
      [makeSession('s1'), makeSession('s2')],
      '/tmp',
    ).bySkill.audit.usage;

    assert.equal(usage.totalTokens, 120);
    assert.equal(usage.avgTokensPerSegment, 120);
    assert.equal(usage.tokenObservedSegmentCount, 1);
    assert.equal(usage.tokenCoverage, 0.5);
  });

  it('rejects aggregate tool-count overflow before deriving rates', () => {
    const first = makeSegment('audit', 0, { sessionId: 's1' });
    first.metrics.numToolCalls = Number.MAX_SAFE_INTEGER;
    const second = makeSegment('audit', 0, { sessionId: 's2' });
    second.metrics.numToolCalls = 1;

    assert.throws(
      () => computeSkillHealthFromSegments(
        [first, second],
        [makeSession('s1'), makeSession('s2')],
        '/tmp',
      ),
      /exceeds Number\.MAX_SAFE_INTEGER/,
    );
  });
});
