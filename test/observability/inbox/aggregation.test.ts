import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateInboxItems,
  buildObservationInboxReport,
  loadLatestObservationInboxReports,
  normalizeObservationKeyInput,
  queryObservationInbox,
  saveObservationInboxReport,
  selectExploreInboxItems,
} from '../../../src/observability/inbox.js';
import { baseItem, businessActionTag } from './_helpers.js';

describe('observe inbox - aggregation', () => {
  it('normalizes dedup key input conservatively', () => {
    const cases: Array<[unknown, string]> = [
      ['', ''],
      ['!!!', '!!!'],
      ['，Revenue_Schema。', '，revenue_schema。'],
      [' "Revenue_Schema"  ', 'revenue_schema'],
      ['/repo//src/auth.ts:12:3', '/repo/src/auth.ts'],
      ['https://example.com//docs/a?b=1', 'https://example.com/docs/a?b=1'],
      [' find   revenue   schema ', 'find revenue schema'],
      ['revenue_schema 🔎', 'revenue_schema 🔎'],
      [{ path: '/repo//src/auth.ts:12:3' }, '{"path":"/repo/src/auth.ts"}'],
      [null, ''],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeObservationKeyInput(input), expected);
    }
  });

  it('records raw session time ranges for Claude and OpenClaw traces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-observe-session-range-'));
    const claudeFile = join(dir, 'claude-session.jsonl');
    const openClawFile = join(dir, 'openclaw-session.jsonl');
    writeFileSync(claudeFile, [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'claude-session-a',
        timestamp: '2026-05-12T12:08:09.000Z',
        cwd: '/repo/demo',
        message: { role: 'user', content: '<command-name>/demo-skill</command-name>' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'claude-session-a',
        timestamp: '2026-05-12T12:10:00.000Z',
        cwd: '/repo/demo',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ].map((record) => JSON.stringify(record)).join('\n'));
    writeFileSync(openClawFile, [
      { type: 'session', version: 3, id: 'openclaw-session-a', timestamp: '2026-05-13T01:00:00.000Z', cwd: '/repo/openclaw-demo' },
      {
        type: 'message',
        id: 'oc-u1',
        timestamp: '2026-05-13T01:02:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: businessActionTag('demo-skill', '生成示例') }] },
      },
      {
        type: 'message',
        id: 'oc-a1',
        parentId: 'oc-u1',
        timestamp: '2026-05-13T01:05:06.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      },
    ].map((record) => JSON.stringify(record)).join('\n'));

    const report = buildObservationInboxReport(dir);
    assert.equal(report.meta.sessionCount, 2);
    assert.ok(report.meta.sessionTimeRange);
    assert.ok(report.meta.sessionTimeRanges);
    assert.equal(report.meta.sessionTimeRange.from, '2026-05-12T12:08:09.000Z');
    assert.equal(report.meta.sessionTimeRange.to, '2026-05-13T01:05:06.000Z');
    const rangesById = new Map(report.meta.sessionTimeRanges.map((range) => [range.sessionId, range]));
    assert.deepEqual(
      {
        sourceKind: rangesById.get('claude-session-a')?.sourceKind,
        startTimestamp: rangesById.get('claude-session-a')?.startTimestamp,
        endTimestamp: rangesById.get('claude-session-a')?.endTimestamp,
      },
      {
        sourceKind: 'claude',
        startTimestamp: '2026-05-12T12:08:09.000Z',
        endTimestamp: '2026-05-12T12:10:00.000Z',
      },
    );
    assert.deepEqual(
      {
        sourceKind: rangesById.get('openclaw-session-a')?.sourceKind,
        startTimestamp: rangesById.get('openclaw-session-a')?.startTimestamp,
        endTimestamp: rangesById.get('openclaw-session-a')?.endTimestamp,
      },
      {
        sourceKind: 'openclaw',
        startTimestamp: '2026-05-13T01:02:03.000Z',
        endTimestamp: '2026-05-13T01:05:06.000Z',
      },
    );
  });

  it('aggregates duplicate items by skill/cwd/signal/query', () => {
    const items = aggregateInboxItems([
      baseItem({ id: 'a', sessionId: 's1', evidence: { query: 'revenue_schema' } }),
      baseItem({ id: 'b', sessionId: 's2', evidence: { query: ' revenue_schema ' }, lastSeen: '2026-05-02T00:00:00.000Z' }),
      baseItem({ id: 'c', sessionId: 's3', cwd: '/repo-b', evidence: { query: 'revenue_schema' } }),
    ]);

    assert.equal(items.length, 2);
    assert.equal(items[0].occurrences, 2);
    assert.deepEqual(items[0].recentSessionIds, ['s2', 's1']);
  });

  it('queries only the latest saved report by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const oldReport = {
      kind: 'observe-inbox' as const,
      schemaVersion: 2 as const,
      meta: {
        generatedAt: '2026-05-01T00:00:00.000Z',
        tracePath: '/tmp/old',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        sessionTimeRange: { from: '2026-05-01T00:00:00.000Z', to: '2026-05-01T00:00:00.000Z', durationMs: 0 },
        sessionTimeRanges: [{
          sessionId: 'old-session',
          sourceTrace: '/tmp/old',
          sourceKind: 'claude' as const,
          startTimestamp: '2026-05-01T00:00:00.000Z',
          endTimestamp: '2026-05-01T00:00:00.000Z',
          durationMs: 0,
        }],
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { old_skill: 1 },
      },
      items: [baseItem({ id: 'old', skillName: 'old_skill', lastSeen: '2026-05-01T00:00:00.000Z' })],
    };
    const latestReport = {
      kind: 'observe-inbox' as const,
      schemaVersion: 2 as const,
      meta: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        tracePath: '/tmp/latest',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        sessionTimeRange: { from: '2026-05-02T00:00:00.000Z', to: '2026-05-02T00:00:00.000Z', durationMs: 0 },
        sessionTimeRanges: [{
          sessionId: 'latest-session',
          sourceTrace: '/tmp/latest',
          sourceKind: 'claude' as const,
          startTimestamp: '2026-05-02T00:00:00.000Z',
          endTimestamp: '2026-05-02T00:00:00.000Z',
          durationMs: 0,
        }],
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { latest_skill: 1 },
      },
      items: [baseItem({ id: 'latest', skillName: 'latest_skill', lastSeen: '2026-05-02T00:00:00.000Z' })],
    };

    saveObservationInboxReport(oldReport, dir);
    saveObservationInboxReport(latestReport, dir);

    assert.equal(loadLatestObservationInboxReports(dir)[0].meta.tracePath, '/tmp/latest');
    assert.deepEqual(queryObservationInbox(dir).map((item) => item.skillName), ['latest_skill']);
  });

  it('keeps streaming report aggregation equivalent to direct aggregation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        entrypoint: 'cli',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind revenue schema' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'revenue_schema', path: '/repo-a' } },
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: ' revenue_schema ', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'No matches found', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].occurrences, 2);
    assert.equal(report.items[0].severityReasonCode, 'knowledge_gap_suspected');
  });

  it('aggregates bash_probe by skill/cwd/subtype without full command precision', () => {
    const items = aggregateInboxItems([
      baseItem({
        id: 'bash-1',
        signalSubtype: 'bash_probe',
        severity: 'medium',
        confidence: 0.4,
        evidence: { tool: 'Bash', query: 'find src -name "*.md" 2>/dev/null | head' },
      }),
      baseItem({
        id: 'bash-2',
        sessionId: 's2',
        signalSubtype: 'bash_probe',
        severity: 'medium',
        confidence: 0.4,
        evidence: { tool: 'Bash', query: 'grep -R "foo" docs 2>/dev/null | head' },
      }),
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0].occurrences, 2);
    assert.equal(items[0].representativeEvidence.length, 2);
  });

  it('samples explore items from medium/low and excludes noise unless requested', () => {
    const items = [
      baseItem({ id: 'high', severity: 'high', lastSeen: '2026-05-04T00:00:00.000Z' }),
      baseItem({ id: 'medium-old', severity: 'medium', signalSubtype: 'exploratory_miss', confidence: 0.4, lastSeen: '2026-05-01T00:00:00.000Z' }),
      baseItem({ id: 'medium-new', severity: 'medium', signalSubtype: 'exploratory_miss', confidence: 0.4, lastSeen: '2026-05-03T00:00:00.000Z' }),
      baseItem({ id: 'low', severity: 'low', signalType: 'explicit_marker', signalSubtype: 'marker', confidence: 0.5, lastSeen: '2026-05-02T00:00:00.000Z' }),
      baseItem({ id: 'noise', severity: 'noise', signalSubtype: 'tool_error', confidence: 0.2, lastSeen: '2026-05-05T00:00:00.000Z' }),
    ];

    const withoutNoise = selectExploreInboxItems(items, 10, false, () => 0.99);
    assert.deepEqual(withoutNoise.map((item) => item.id).sort(), ['low', 'medium-new', 'medium-old']);

    const withNoise = selectExploreInboxItems(items, 10, true, () => 0.99);
    assert.deepEqual(withNoise.map((item) => item.id).sort(), ['low', 'medium-new', 'medium-old', 'noise']);
  });
});
