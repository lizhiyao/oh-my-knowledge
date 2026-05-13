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
  loadObservationInboxReports,
  normalizeObservationKeyInput,
  queryObservationInbox,
  saveObservationInboxReport,
  selectExploreInboxItems,
  type ObservationInboxItem,
} from '../../src/observability/inbox.js';
import {
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  hasNegativeFeedbackSignal,
  hasPositiveFeedbackSignal,
  hasUserCorrectionSignal,
} from '../../src/observability/experience.js';
import {
  deleteObservationReviewState,
  loadObservationReviewState,
  observationMetricAnnotationTargetId,
  observationReviewStateKey,
  updateObservationReviewState,
} from '../../src/observability/review-state.js';

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
  it('does not count embedded words as user correction signals', () => {
    assert.equal(hasUserCorrectionSignal('这里的拆解不对称，是不是需要换一种图形？'), false);
    assert.equal(hasUserCorrectionSignal('不对，应该直接使用原来的分组。'), true);
    assert.equal(hasUserCorrectionSignal('这里不是；重来。'), true);
    const text = '这里的拆解不对称。不是，重新看。';
    assert.deepEqual(findUserCorrectionMatches(text).map((range) => text.slice(range.start, range.end)), ['不是']);
  });

  it('detects neutral user goal shift separately from correction', () => {
    const text = '先不看这个，换个方向，另外一个问题后面再处理。';
    assert.deepEqual(findUserGoalShiftMatches(text).map((range) => text.slice(range.start, range.end)), ['先不', '换个方向', '另外一个问题']);
    assert.equal(hasUserCorrectionSignal(text), false);
  });

  it('detects negative and positive emotional feedback signals', () => {
    const negative = '这个做错了，没用，太垃圾了。';
    assert.equal(hasNegativeFeedbackSignal(negative), true);
    assert.deepEqual(findNegativeFeedbackMatches(negative).map((range) => negative.slice(range.start, range.end)), ['做错了', '没用', '太垃圾']);
    assert.equal(hasNegativeFeedbackSignal('若设计工具链因为登录态失败且存在 token，则改走回退。'), false);
    assert.equal(hasNegativeFeedbackSignal('这个菜单入口在哪里？'), false);
    assert.equal(hasNegativeFeedbackSignal('垃圾桶的位置在哪里？'), false);
    assert.equal(hasNegativeFeedbackSignal('垃圾，重做。'), true);

    const positive = '很好，good job，做的好，很棒，很有价值。';
    assert.equal(hasPositiveFeedbackSignal(positive), true);
    assert.deepEqual(findPositiveFeedbackMatches(positive).map((range) => positive.slice(range.start, range.end)), ['很好', 'good job', '做的好', '很棒', '很有价值']);
  });

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
        message: { role: 'user', content: [{ type: 'text', text: '<aima-cmd name="demo-skill">生成示例</aima-cmd>' }] },
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
      schemaVersion: 1 as const,
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
      schemaVersion: 1 as const,
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

  it('preserves openclaw sourceKind through inbox and experience reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'caifu_openclaw.jsonl');
    const records = [
      { type: 'session', version: 3, id: 'oc-1', timestamp: '2026-05-12T00:00:00.000Z', cwd: '/tmp/example/.openclaw/workspace' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-05-12T00:00:01.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Conversation info (untrusted metadata):\n```json\n{"channel":"aima","sender":"示例用户","sender_id":"example-sender"}\n```\n\n帮我写一个 PRD\n<aima-cmd name="生成PRD">请生成 PRD</aima-cmd>' }],
        },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-05-12T00:00:02.000Z',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          model: 'gpt-5.5',
          content: [
            { type: 'toolCall', id: 'read-skill', name: 'read', arguments: { path: '/tmp/example/.openclaw/workspace/skills/prd-create/SKILL.md' } },
            { type: 'toolCall', id: 'grep-1', name: 'grep', arguments: { pattern: 'missing_field', path: 'domain' } },
          ],
        },
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2026-05-12T00:00:03.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'read-skill',
          toolName: 'read',
          content: [{ type: 'text', text: '# PRD Creation Skill' }],
          isError: false,
        },
      },
      {
        type: 'message',
        id: 'tr2',
        parentId: 'tr1',
        timestamp: '2026-05-12T00:00:04.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'grep-1',
          toolName: 'grep',
          content: [{ type: 'text', text: 'No matches found' }],
          isError: false,
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].skillName, 'prd-create');
    assert.equal(report.items[0].sourceKind, 'openclaw');
    assert.equal(report.experience?.invocations[0].sourceKind, 'openclaw');
    assert.equal(report.experience?.invocations[0].entrypoint, 'openclaw');
    assert.equal(report.experience?.invocations[0].attribution.source, 'read-skill-md');
    assert.equal(report.experience?.invocations[0].attribution.commandName, undefined);
    assert.equal(report.experience?.invocations[0].sourceMetadata?.channel, 'aima');
    assert.equal(report.experience?.invocations[0].sourceMetadata?.sender, '示例用户');
    assert.deepEqual(report.experience?.invocations[0].sourceMetadata?.aimaCommands, ['生成PRD']);
    assert.equal(report.experience?.skills[0].sourceMetadataCounts.channels.aima, 1);
    assert.equal(report.experience?.skills[0].sourceMetadataCounts.aimaCommands['生成PRD'], 1);
    assert.equal(report.experience?.goalSlices[0].inferredUserGoal, '帮我写一个 PRD <aima-cmd name="生成PRD">请生成 PRD</aima-cmd>');
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

  it('keeps query hard_miss when later Bash ls only shares repo path tokens', () => {
    // 回归: Grep("payment") 失败后, 后续 Bash(ls /repos/payment-app/src/auth.ts) 成功。
    // 旧逻辑把 Bash command 全文当 query, 命中 "payment" token 把 hard_miss 误降级为
    // exploratory_miss。新结构化解析里 Bash ls 走 path-only 不污染 query 维度。
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
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls /repos/payment-app/src/auth.ts' } },
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
            { type: 'tool_result', tool_use_id: 't2', content: '/repos/payment-app/src/auth.ts', is_error: false },
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

  it('saves two same-second observe-inbox reports without overwriting', () => {
    // 回归: report 文件名以前 slice(0, 19) 把毫秒砍掉, 导致 .111Z 和 .999Z 两份同秒
    // 不同毫秒的 report 共用同一文件名, 第二份静默覆盖第一份。修复后保留毫秒。
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const reportA = {
      kind: 'observe-inbox' as const,
      schemaVersion: 1 as const,
      meta: {
        generatedAt: '2026-05-07T12:00:00.111Z',
        tracePath: '/tmp/A',
        sourceKind: 'claude' as const,
        sessionCount: 1,
        sessionTimeRange: { from: '2026-05-07T12:00:00.111Z', to: '2026-05-07T12:00:00.111Z', durationMs: 0 },
        sessionTimeRanges: [{
          sessionId: 'session-a',
          sourceTrace: '/tmp/A',
          sourceKind: 'claude' as const,
          startTimestamp: '2026-05-07T12:00:00.111Z',
          endTimestamp: '2026-05-07T12:00:00.111Z',
          durationMs: 0,
        }],
        segmentCount: 1,
        itemCount: 1,
        skillInvocationCounts: { skill_a: 1 },
      },
      items: [baseItem({ id: 'a', skillName: 'skill_a', lastSeen: '2026-05-07T12:00:00.111Z' })],
    };
    const reportB = {
      ...reportA,
      meta: {
        ...reportA.meta,
        generatedAt: '2026-05-07T12:00:00.999Z',
        tracePath: '/tmp/B',
      },
      items: [baseItem({ id: 'b', skillName: 'skill_a', lastSeen: '2026-05-07T12:00:00.999Z' })],
    };

    const pathA = saveObservationInboxReport(reportA, dir);
    const pathB = saveObservationInboxReport(reportB, dir);

    assert.notEqual(pathA, pathB);
    const reports = loadObservationInboxReports(dir);
    assert.equal(reports.length, 2);
    const tracePaths = new Set(reports.map((r) => r.meta.tracePath));
    assert.ok(tracePaths.has('/tmp/A'));
    assert.ok(tracePaths.has('/tmp/B'));
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

  it('builds evidence-only experience report for 2.0 skill review', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u-runtime',
        parentUuid: null,
        promptId: 'p1',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        entrypoint: 'sdk-ts',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '进入新增模板流程。当前页面已经完成本地工作区恢复，请直接命中 gui-workflow route。若设计工具链因为登录态失败且存在 token，则改走回退，必须不要误判 token。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: 'u-runtime',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:00.500Z',
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
      {
        type: 'user',
        uuid: 'u-meta',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:02.500Z',
        cwd: '/repo-a',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Base directory for this skill: /repo-a/.claude/skills/audit\n\n# audit\n\n不对，这里是 skill 文档里的规则，不是用户说的话。' }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u-meta',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:03.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '不对，必须直接找到 schema 定义，不要猜。' },
      },
      {
        type: 'user',
        uuid: 'u4',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-01T00:00:04.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '[Request interrupted by user]' },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const experience = report.experience;
    assert.ok(experience);
    assert.equal(experience.kind, 'observe-experience');
    assert.equal(experience.scope, 'evidence-only');
    assert.equal(experience.meta.skillCount, 1);
    assert.equal(experience.goalSlices.length, 1);
    assert.equal(experience.goalSlices[0].sliceReasonCode, 'skill_segment_boundary');
    assert.equal(experience.goalSlices[0].sliceConfidence, 'high');
    assert.equal(experience.sessions[0].entrypoint, 'sdk-ts');
    assert.deepEqual(experience.skills[0].entrypoints, ['sdk-ts']);
    assert.deepEqual(experience.skills[0].entrypointCounts, { 'sdk-ts': 1 });
    assert.deepEqual(experience.skills[0].toolCounts, { Grep: 1 });
    assert.equal(experience.sessions[0].reviewPriority, 'review_first');
    assert.ok(experience.sessions[0].reviewBasisCodes.includes('has_high_observation'));
    assert.ok(experience.sessions[0].reviewBasisCodes.includes('user_correction'));
    assert.ok(experience.sessions[0].reviewBasisCodes.includes('user_interruption'));
    assert.ok(experience.sessions[0].timelinePreview.some((event) => event.kind === 'tool_use' && event.toolUseId === 't1'));
    assert.ok(experience.sessions[0].timelinePreview.some((event) => event.kind === 'skill_context'));
    assert.ok(experience.sessions[0].timelinePreview.some((event) => event.kind === 'runtime_context'));
    assert.equal(experience.sessions[0].evidenceChain.runtimeContextCount, 2);
    assert.equal(experience.sessions[0].evidenceChain.skillContextCount, 1);
    assert.equal(experience.sessions[0].evidenceChain.userMessageCount, 3);
    assert.ok(experience.sessions[0].ruleFindings.some((finding) => finding.code === 'runtime_context_excluded'));
    assert.ok(experience.sessions[0].ruleFindings.some((finding) => finding.code === 'user_correction_seen' && finding.level === 'attention'));
    assert.ok(experience.sessions[0].ruleFindings.some((finding) => finding.code === 'tool_failure_seen') === false);
    assert.equal(experience.sessions[0].assistiveInference.mode, 'deterministic_rules_only');
    assert.equal(experience.sessions[0].assistiveInference.code, 'review_recommended');
    assert.equal(experience.sessions[0].assistiveInference.confidence, 'high');
    assert.ok(experience.sessions[0].assistiveInference.cautionCodes.includes('no_llm_judge'));
    assert.equal(experience.skills[0].assistiveInference.code, 'review_recommended');
    assert.equal(experience.skills[0].evidenceChain.runtimeContextCount, 2);
    assert.equal(experience.goalSlices[0].inferredUserGoal?.startsWith('Base directory for this skill:'), false);
    assert.equal(experience.invocations[0].indicators.negativeFeedbackCount, 0);
    assert.equal(experience.invocations[0].indicators.userCorrectionCount, 1);
    assert.equal(experience.invocations[0].indicators.userInterruptionCount, 1);
    assert.ok(experience.invocations[0].problemPatterns.some((pattern) => pattern.bucket === 'missing_context'));
    assert.ok(experience.sessions[0].problemPatterns.some((pattern) => pattern.bucket === 'rule_violation'));
    assert.ok(experience.skills[0].problemPatterns.some((pattern) => pattern.bucket === 'workflow_mismatch'));
    assert.equal('verdict' in experience.sessions[0], false);

    const correctionTargetId = observationMetricAnnotationTargetId({
      sourceTrace: file,
      sessionId: 's1',
      messageIndex: 5,
      messageUuid: 'u3',
    }, 'user_correction');
    const goalShiftTargetId = observationMetricAnnotationTargetId({
      sourceTrace: file,
      sessionId: 's1',
      messageIndex: 5,
      messageUuid: 'u3',
    }, 'user_goal_shift');
    const annotatedReport = buildObservationInboxReport(file, {
      reviewState: {
        kind: 'observe-review-state',
        schemaVersion: 1,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {
          [observationReviewStateKey('evidence_metric', correctionTargetId)]: {
            targetType: 'evidence_metric',
            targetId: correctionTargetId,
            verdict: 'rejected',
            metricKey: 'user_correction',
            reviewedAt: '2026-05-01T00:00:00.000Z',
          },
          [observationReviewStateKey('evidence_metric', goalShiftTargetId)]: {
            targetType: 'evidence_metric',
            targetId: goalShiftTargetId,
            verdict: 'confirmed',
            metricKey: 'user_goal_shift',
            reviewedAt: '2026-05-01T00:00:00.000Z',
          },
        },
      },
    });
    assert.equal(annotatedReport.experience?.invocations[0].indicators.userCorrectionCount, 0);
    assert.equal(annotatedReport.experience?.invocations[0].indicators.userGoalShiftCount, 1);
    assert.equal(annotatedReport.experience?.invocations[0].problemPatterns.some((pattern) => pattern.signalTypes.includes('user_correction')), false);
    assert.equal(annotatedReport.experience?.invocations[0].problemPatterns.some((pattern) => pattern.signalTypes.includes('user_goal_shift')), true);
  });

  it('keeps skill timeline open through skill context until the next skill starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const file = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:08.236Z',
        cwd: '/repo-a',
        entrypoint: 'cli',
        message: { role: 'user', content: '画一个给老板汇报的时序图。步骤简单一点' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:15.646Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill-tool-1', name: 'Skill', input: { skill: 'my-diagram', args: '画时序图' } }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:16.500Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'skill-tool-1', content: 'Launching skill: my-diagram' }],
        },
      },
      {
        type: 'user',
        uuid: 'u3',
        parentUuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:16.115Z',
        cwd: '/repo-a',
        isMeta: true,
        sourceToolUseID: 'skill-tool-1',
        message: { role: 'user', content: 'Base directory for this skill: /repo-a/.claude/skills/my-diagram\n# my-diagram\n画图流程说明' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        parentUuid: 'u3',
        sessionId: 's1',
        timestamp: '2026-05-09T06:02:24.003Z',
        cwd: '/repo-a',
        message: { role: 'assistant', content: [{ type: 'text', text: '内容、类型、格式都已明确，直接生成 Mermaid 时序图。' }] },
      },
      {
        type: 'user',
        uuid: 'u4',
        parentUuid: 'a2',
        sessionId: 's1',
        timestamp: '2026-05-09T06:03:28.380Z',
        cwd: '/repo-a',
        message: { role: 'user', content: '把这个时序图的系统-工具改为 agent，做一个diff图' },
      },
      {
        type: 'assistant',
        uuid: 'a3',
        parentUuid: 'u4',
        sessionId: 's1',
        timestamp: '2026-05-09T06:03:46.528Z',
        cwd: '/repo-a',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Diff 需要红色标注，推荐用 PlantUML。' }] },
      },
      {
        type: 'assistant',
        uuid: 'a4',
        parentUuid: 'u4',
        sessionId: 's1',
        timestamp: '2026-05-09T06:07:23.444Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'skill-tool-2', name: 'Skill', input: { skill: 'excalidraw-diagram', args: 'before after' } }],
        },
      },
    ];
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(file);
    const myDiagramSession = report.experience?.sessions.find((session) => session.skillName === 'my-diagram');
    assert.ok(myDiagramSession);
    const timeline = myDiagramSession.timelinePreview;
    assert.ok(timeline.some((event) => event.messageIndex === 3 && event.kind === 'skill_context'));
    assert.ok(timeline.some((event) => event.messageIndex === 4 && event.kind === 'assistant_message' && event.snippet?.includes('直接生成 Mermaid')));
    assert.ok(timeline.some((event) => event.messageIndex === 5 && event.kind === 'user_message' && event.snippet?.includes('做一个diff图')));
    assert.ok(timeline.some((event) => event.messageIndex === 6 && event.kind === 'assistant_message' && event.snippet?.includes('PlantUML')));
    assert.equal(timeline.some((event) => event.messageIndex === 7 && event.kind === 'tool_use' && event.toolName === 'Skill'), false);
  });

  it('persists local reviewer state for D1 workflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-review-state-'));
    const state = updateObservationReviewState(dir, {
      targetType: 'experience_session',
      targetId: 'session-1',
      verdict: 'not_issue',
      note: 'probe only',
    }, '2026-05-01T00:00:00.000Z');
    const key = observationReviewStateKey('experience_session', 'session-1');
    assert.equal(state.entries[key].verdict, 'not_issue');
    assert.equal(state.entries[key].note, 'probe only');

    const loaded = loadObservationReviewState(dir);
    assert.equal(loaded.entries[key].targetType, 'experience_session');
    assert.equal(loaded.entries[key].reviewedAt, '2026-05-01T00:00:00.000Z');

    const correction = updateObservationReviewState(dir, {
      targetType: 'goal_slice_correction',
      targetId: 'session-1:42',
      verdict: 'reviewed',
      note: 'slice here',
      reason: 'manual boundary',
    }, '2026-05-01T00:01:00.000Z');
    const correctionKey = observationReviewStateKey('goal_slice_correction', 'session-1:42');
    assert.equal(correction.entries[correctionKey].targetType, 'goal_slice_correction');
    assert.equal(correction.entries[correctionKey].note, 'slice here');
    assert.equal(correction.entries[correctionKey].reason, 'manual boundary');

    const metricTargetId = 'metric:user_correction:abc';
    const metric = updateObservationReviewState(dir, {
      targetType: 'evidence_metric',
      targetId: metricTargetId,
      verdict: 'confirmed',
      metricKey: 'user_correction',
      reason: '用户明确否定上一轮结果',
    }, '2026-05-01T00:01:30.000Z');
    const metricKey = observationReviewStateKey('evidence_metric', metricTargetId);
    assert.equal(metric.entries[metricKey].metricKey, 'user_correction');
    assert.equal(metric.entries[metricKey].reason, '用户明确否定上一轮结果');

    const afterDelete = deleteObservationReviewState(dir, 'goal_slice_correction', 'session-1:42', '2026-05-01T00:02:00.000Z');
    assert.equal(afterDelete.entries[correctionKey], undefined);
  });
});
