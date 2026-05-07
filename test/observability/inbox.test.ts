import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  aggregateInboxItems,
  buildObservationInboxReport,
  formatObservationShow,
  loadLatestObservationInboxReports,
  normalizeObservationKeyInput,
  queryObservationInbox,
  saveObservationInboxReport,
  selectExploreInboxItems,
  type ObservationInboxItem,
} from '../../src/observability/inbox.js';

function baseItem(partial: Partial<ObservationInboxItem>): ObservationInboxItem {
  return {
    id: partial.id ?? 'i1',
    skillName: partial.skillName ?? 'audit',
    artifactVersion: 'unknown',
    cwd: partial.cwd ?? '/repo-a',
    sessionId: partial.sessionId ?? 's1',
    sourceTrace: '/tmp/s1.jsonl',
    sourceKind: partial.sourceKind ?? 'claude',
    signalType: partial.signalType ?? 'failed_search',
    signalSubtype: partial.signalSubtype ?? 'hard_miss',
    confidence: partial.confidence ?? 0.9,
    attributionConfidence: partial.attributionConfidence ?? 0.85,
    severity: partial.severity ?? 'high',
    evidence: partial.evidence ?? { query: 'revenue_schema' },
    firstSeen: partial.firstSeen ?? '2026-05-01T00:00:00.000Z',
    lastSeen: partial.lastSeen ?? '2026-05-01T00:00:00.000Z',
    occurrences: partial.occurrences ?? 1,
    recentSessionIds: partial.recentSessionIds ?? [partial.sessionId ?? 's1'],
    representativeEvidence: partial.representativeEvidence ?? [partial.evidence ?? { query: 'revenue_schema' }],
  };
}

describe('observe inbox', () => {
  it('normalizes dedup key input conservatively', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['!!!', '!!!'],
      ['，Revenue_Schema。', '，revenue_schema。'],
      [' "Revenue_Schema"  ', 'revenue_schema'],
      ['/repo//src/auth.ts:12:3', '/repo/src/auth.ts'],
      ['https://example.com//docs/a?b=1', 'https://example.com/docs/a?b=1'],
      [' find   revenue   schema ', 'find revenue schema'],
      ['revenue_schema 🔎', 'revenue_schema 🔎'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeObservationKeyInput(input), expected);
    }
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
      schemaVersion: 1 as const,
      meta: {
        generatedAt: '2026-05-01T00:00:00.000Z',
        tracePath: '/tmp/old',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { old_skill: 1 },
      },
      items: [baseItem({ id: 'old', skillName: 'old_skill', lastSeen: '2026-05-01T00:00:00.000Z' })],
    };
    const latestReport = {
      kind: 'observe-inbox' as const,
      schemaVersion: 1 as const,
      meta: {
        generatedAt: '2026-05-02T00:00:00.000Z',
        tracePath: '/tmp/latest',
        sourceKind: 'claude' as const,
        sessionCount: 1,
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

  it('builds hard_miss inbox item from Claude Code JSONL', () => {
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
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.kind, 'observe-inbox');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].severityReason, undefined);
    assert.equal(report.items[0].severityReasonCode, 'knowledge_gap_suspected');
    assert.equal(report.items[0].skillName, 'audit');
    assert.equal(report.items[0].sourceKind, 'claude');
    assert.equal(report.meta.skillInvocationCounts?.audit, 1);
    assert.equal(report.meta.skillSessionCounts?.audit, 1);
    assert.equal(report.meta.skillToolCallCounts?.audit?.Grep, 1);
    assert.equal(report.items[0].signalSubtype, 'hard_miss');
    assert.equal(report.items[0].confidence, 0.9);
    assert.equal(report.items[0].attributionConfidence, 0.85);
  });

  it('keeps repeated_failure stronger than a single hard_miss', () => {
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
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'revenue_table', path: '/repo-a' } },
            { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'revenue_column', path: '/repo-a' } },
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
            { type: 'tool_result', tool_use_id: 't3', content: 'No matches found', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const repeated = report.items.find((item) => item.signalType === 'repeated_failure');
    assert.ok(repeated);
    assert.equal(repeated.confidence, 0.95);
    assert.equal(repeated.severity, 'high');
  });

  it('classifies bash probe misses as exploratory instead of high', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const command = 'ls /repo/config/ 2>/dev/null; find /repo -maxdepth 2 -name "routes*" 2>/dev/null | grep -v node_modules';
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind routes' },
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
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command } },
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
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'bash_probe');
    assert.equal(report.items[0].severity, 'medium');
    assert.equal(report.items[0].confidence, 0.4);
    assert.equal(report.items[0].evidence.messageIndex, 1);
    assert.equal(report.items[0].evidence.messageUuid, 'a1');
    assert.equal(report.items[0].evidence.toolUseId, 't1');
    assert.ok(report.items[0].messageWindow);
  });

  it('classifies pure ls probes as bash_probe when they use explicit tolerant markers', () => {
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
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind config' },
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
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /repo/config 2>/dev/null' } },
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
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'bash_probe');
    assert.equal(report.items[0].severity, 'medium');
  });

  it('keeps hard_miss when a later successful search is unrelated', () => {
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
            { type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'auth_router', path: '/repo-a' } },
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
            { type: 'tool_result', tool_use_id: 't2', content: 'src/auth/router.ts:1: auth_router', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const revenue = report.items.find((item) => item.evidence.query === 'revenue_schema');
    assert.ok(revenue);
    assert.equal(revenue.signalSubtype, 'hard_miss');
    assert.equal(revenue.severity, 'high');
  });

  it('keeps query hard_miss when a later successful Read only shares cwd path tokens', () => {
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
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo-a/src/auth.ts' } },
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
            { type: 'tool_result', tool_use_id: 't2', content: 'export const auth = true;', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const revenue = report.items.find((item) => item.evidence.query === 'revenue_schema');
    assert.ok(revenue);
    assert.equal(revenue.signalSubtype, 'hard_miss');
    assert.equal(revenue.severity, 'high');
  });

  it('keeps query hard_miss when query token appears only in repository directory name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repos/payment-app',
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind payment config' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repos/payment-app',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'payment', path: '/repos/payment-app' } },
            { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repos/payment-app/src/auth.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repos/payment-app',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'export const auth = true;', is_error: false },
          ],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const payment = report.items.find((item) => item.evidence.query === 'payment');
    assert.ok(payment);
    assert.equal(payment.signalSubtype, 'hard_miss');
    assert.equal(payment.severity, 'high');
  });

  it('uses a dedicated reason code for skill asset read failures', () => {
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
        message: { role: 'user', content: '<command-name>/audit</command-name>\nUse skill asset' },
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
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo-a/.claude/skills/audit/examples/schema.md' } },
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
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: ENOENT no such file or directory', is_error: true }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'skill_asset_read_failed');
    assert.equal(report.items[0].severity, 'medium');
    assert.equal(report.items[0].severityReasonCode, 'skill_asset_unavailable');
  });

  it('formats observation show output with message window context', () => {
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
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind routes' },
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
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls /repo/config 2>/dev/null' } },
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
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const output = formatObservationShow(report.items[0]);
    assert.match(output, /--- 上文 ---/);
    assert.match(output, /--- 失败点 \/ 触发点 ---/);
    assert.match(output, /tool_use Bash t1/);
  });

  it('does not degrade plain Bash find misses without explicit probe markers', () => {
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
        message: { role: 'user', content: '<command-name>/audit</command-name>\nFind routes' },
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
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'find . -name routes.ts' } },
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
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items[0].signalSubtype, 'hard_miss');
    assert.equal(report.items[0].severity, 'high');
    assert.equal(report.items[0].confidence, 0.9);
  });
});
