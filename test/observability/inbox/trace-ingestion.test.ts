import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildObservationInboxReport,
  formatObservationShow,
  inferObservationSourceKind,
  loadObservationInboxReports,
  saveObservationInboxReport,
} from '../../../src/observability/inbox/index.js';
import { renderObservationInboxPage } from '../../../src/studio/presentation/observation-inbox-renderer.js';
import { baseItem, businessActionTag, businessChannel, reviewProjectionForFixture } from './_helpers.js';

describe('observe inbox - trace ingestion', () => {
  it('skips unsupported experience reports without changing files or hiding current inbox v2', () => {
    const root = mkdtempSync(join(tmpdir(), 'omk-experience-version-'));
    try {
      const trace = join(root, 'trace.jsonl');
      writeFileSync(trace, readFileSync(new URL('../../fixtures/codex-knowledge-debugger-failure.jsonl', import.meta.url)));
      const report = buildObservationInboxReport(trace);
      const current = saveObservationInboxReport(report, root);
      const old = saveObservationInboxReport(report, root);
      const legacy = JSON.parse(readFileSync(old, 'utf8'));
      legacy.experience.schemaVersion = 2;
      writeFileSync(old, JSON.stringify(legacy));
      const before = readFileSync(old, 'utf8');
      const loaded = loadObservationInboxReports(root);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].schemaVersion, 2);
      assert.equal(loaded[0].experience?.schemaVersion, 3);
      assert.equal(readFileSync(old, 'utf8'), before);
      assert.equal(JSON.parse(readFileSync(current, 'utf8')).experience.schemaVersion, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].severityReason, undefined);
    assert.equal(report.items[0].severityReasonCode, 'knowledge_gap_suspected');
    assert.equal(report.items[0].skillName, 'audit');
    assert.equal(report.items[0].sourceKind, 'claude');
    assert.equal(report.meta.skillInvocationCounts?.audit, 1);
    assert.equal(report.meta.skillSessionCounts?.audit, 1);
    assert.equal(report.meta.skillToolCallCounts?.audit?.Grep, 1);
    assert.deepEqual(report.meta.ingestion, {
      fileCount: 1,
      sourceRecordCount: 3,
      parsedRecordCount: 3,
      malformedRecordCount: 0,
      ignoredValueCount: 0,
      unknownEventCount: 0,
      filteredSessionCount: 0,
    });
    assert.equal(report.items[0].signalSubtype, 'hard_miss');
    assert.equal(report.items[0].confidence, 0.9);
    assert.equal(report.items[0].attributionConfidence, 0.85);
  });

  it('persists and reloads a report when an unattributed prefix precedes the skill', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-general-prefix-'));
    const trace = join(dir, 'session.jsonl');
    const records = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's-general-prefix',
        timestamp: '2026-05-01T00:00:00.000Z',
        cwd: '/repo-a',
        message: { role: 'user', content: 'Please inspect the audit workflow.' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's-general-prefix',
        timestamp: '2026-05-01T00:00:01.000Z',
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'read-skill',
            name: 'Read',
            input: { file_path: '/repo-a/.agents/skills/audit/SKILL.md' },
          }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        sessionId: 's-general-prefix',
        timestamp: '2026-05-01T00:00:02.000Z',
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'read-skill',
            content: '# Audit',
            is_error: false,
          }],
        },
      },
    ];
    writeFileSync(trace, records.map((record) => JSON.stringify(record)).join('\n'));

    const report = buildObservationInboxReport(trace);
    assert.equal(report.meta.segmentCount, 1);
    assert.equal(report.experience?.invocations.length, 1);
    assert.equal(report.experience?.invocations[0].skillName, 'audit');

    const reportsDir = join(dir, 'reports');
    saveObservationInboxReport(report, reportsDir);
    const [loaded] = loadObservationInboxReports(reportsDir);
    assert.ok(loaded);
    assert.equal(loaded.meta.segmentCount, 1);
  });

  it('builds Codex rollout observations without mislabeling them as Claude', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-codex-'));
    const file = join(dir, 'rollout-codex.jsonl');
    const records = [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-1',
          session_id: 'codex-1',
          cwd: '/repo-codex',
          originator: 'Codex Desktop',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:00.100Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', model: 'gpt-codex-test' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'user-1',
          role: 'user',
          content: [{ type: 'input_text', text: '查找收入字段。' }],
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'read-skill',
          name: 'exec',
          input: 'const result = await tools.exec_command({"cmd":"sed -n \'1,200p\' .agents/skills/audit/SKILL.md"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'read-skill', output: '# Audit Skill' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'search-1',
          name: 'exec',
          input: 'const result = await tools.exec_command({"cmd":"rg revenue_schema src"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'search-1', output: 'No matches found' },
      },
    ];
    writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n'));

    const report = buildObservationInboxReport(file);
    assert.equal(report.meta.sessionCount, 1);
    assert.equal(report.meta.skillInvocationCounts?.audit, 1);
    assert.equal(report.experience?.sessions[0].sourceKind, 'codex');
    assert.equal(report.experience?.sessions[0].entrypoint, 'codex-desktop');
    assert.equal(report.experience?.sessions[0].sourceMetadata?.model, 'gpt-codex-test');
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].skillName, 'audit');
    assert.equal(report.items[0].sourceKind, 'codex');
    assert.ok(report.items[0].messageWindow);
    assert.equal(
      report.items[0].messageWindow.event.some((message) =>
        message.snippet.includes('tool_use Bash search-1')
        || message.snippet.includes('tool_result search-1 No matches found')),
      true,
    );
    assert.equal(
      report.items[0].messageWindow.event.find((message) =>
        message.snippet.includes('tool_result search-1 No matches found'))?.role,
      'other',
    );
    assert.match(formatObservationShow(report.items[0]), /查找收入字段。/);
    assert.match(formatObservationShow(report.items[0]), /tool_result search-1 No matches found/);
    assert.equal(inferObservationSourceKind('C:\\Users\\me\\.codex\\sessions\\rollout.jsonl'), 'codex');
    assert.equal(inferObservationSourceKind('C:\\Users\\me\\.OPENCLAW\\sessions\\trace.jsonl'), 'openclaw');
    assert.equal(inferObservationSourceKind('/tmp/openclawx/sessions/trace.jsonl'), 'unknown');
    assert.equal(inferObservationSourceKind('/tmp/session.LOG'), 'markdown_log');
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
          content: [{ type: 'text', text: `Conversation info (untrusted metadata):\n\`\`\`json\n{"channel":"${businessChannel()}","sender":"示例用户","sender_id":"example-sender"}\n\`\`\`\n\n帮我写一个 PRD\n${businessActionTag('生成文档', '请生成 PRD')}` }],
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
    assert.equal(report.experience?.invocations[0].sourceMetadata?.channel, businessChannel());
    assert.equal(report.experience?.invocations[0].sourceMetadata?.sender, '示例用户');
    assert.deepEqual(report.experience?.invocations[0].sourceMetadata?.businessActions, ['生成文档']);
    assert.equal(report.experience?.skills[0].sourceMetadataCounts.channels[businessChannel()], 1);
    assert.equal(report.experience?.skills[0].sourceMetadataCounts.businessActions['生成文档'], 1);
    assert.equal(report.experience?.goalSlices[0].inferredUserGoal, `帮我写一个 PRD ${businessActionTag('生成文档', '请生成 PRD')}`);
  });

  it('keeps same skill split by concrete standalone trace sessions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-'));
    const makeRecords = (suffix: string, minute: string): object[] => [
      {
        type: 'user',
        uuid: `u-${suffix}`,
        parentUuid: null,
        sessionId: 'reused-session-id',
        timestamp: `2026-05-01T00:${minute}:00.000Z`,
        cwd: '/repo-a',
        message: { role: 'user', content: '<command-name>/audit</command-name>\n检查示例字段' },
      },
      {
        type: 'assistant',
        uuid: `a-${suffix}`,
        parentUuid: `u-${suffix}`,
        sessionId: 'reused-session-id',
        timestamp: `2026-05-01T00:${minute}:01.000Z`,
        cwd: '/repo-a',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: `t-${suffix}`, name: 'Grep', input: { pattern: 'example_field', path: '/repo-a' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: `r-${suffix}`,
        parentUuid: `a-${suffix}`,
        sessionId: 'reused-session-id',
        timestamp: `2026-05-01T00:${minute}:02.000Z`,
        cwd: '/repo-a',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `t-${suffix}`, content: 'No matches found', is_error: false }],
        },
      },
    ];
    writeFileSync(join(dir, 'first.jsonl'), makeRecords('first', '00').map((r) => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'second.jsonl'), makeRecords('second', '10').map((r) => JSON.stringify(r)).join('\n'));

    const report = buildObservationInboxReport(dir);
    const experience = report.experience;
    assert.ok(experience);
    assert.equal(experience.sessions.filter((session) => session.skillName === 'audit').length, 2);
    assert.equal(experience.skills.find((skill) => skill.skillName === 'audit')?.sessionCount, 2);
    assert.equal(report.meta.skillSessionCounts?.audit, 2);
    assert.equal(new Set(report.meta.sessionTimeRanges?.map((range) => range.traceId)).size, 2);
    assert.equal(report.items.length, 1);
    assert.equal(report.items[0].occurrences, 2);
    assert.equal(report.items[0].recentTraceIds?.length, 2);
    assert.equal(report.items[0].traceId, report.items[0].evidence.traceId);
    assert.equal(report.items[0].sourceTrace, report.items[0].evidence.sourceTrace);

    const rendered = renderObservationInboxPage({
      allItems: report.items,
      items: report.items,
      reports: [report],
      experienceReports: [experience],
      skillInvocationCounts: report.meta.skillInvocationCounts ?? {},
      skillSessionCounts: report.meta.skillSessionCounts ?? {},
      skillInvocationLastSeen: report.meta.skillInvocationLastSeen ?? {},
      skillToolCallCounts: report.meta.skillToolCallCounts ?? {},
      skillChains: {},
      skillDerivedStandards: {},
      skillResolvedStandards: {},
      totalSkillInvocations: experience.invocations.length,
      severitySkillCounts: { high: 0, medium: 0, low: 1, noise: 0 },
      skillCount: 1,
      reportCount: 1,
      latestSeenLabel: '2026-05-01 00:10:02',
      reviewState: {
        kind: 'observe-review-state',
        schemaVersion: 2,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {},
      },
      ...reviewProjectionForFixture(experience, {
        kind: 'observe-review-state',
        schemaVersion: 2,
        updatedAt: '2026-05-01T00:00:00.000Z',
        entries: {},
      }),
    });
    assert.equal((rendered.match(/data-inbox-card="audit"/g) ?? []).length, 1);
    assert.equal((rendered.match(/data-session-tab="/g) ?? []).length, 2);
    assert.match(rendered, /2 次调用/);
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
    assert.equal(
      report.items[0].messageWindow.event.some((message) =>
        message.snippet.includes('tool_use Bash t1'),
      ),
      true,
    );
    assert.equal(
      report.items[0].messageWindow.event.some((message) =>
        message.snippet.includes('tool_result t1 No matches found'),
      ),
      true,
    );
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
      schemaVersion: 2 as const,
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

  it('rejects persisted inbox timestamps and aggregates that contradict source facts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-inbox-strict-'));
    const trace = join(dir, 'session.jsonl');
    writeFileSync(trace, [
      {
        type: 'user',
        uuid: 'u1',
        sessionId: 's1',
        timestamp: '2026-05-07T12:00:00.000Z',
        message: {
          role: 'user',
          content: '<command-name>/audit</command-name>\nFind the schema.',
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-05-07T12:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 't1',
            name: 'Grep',
            input: { pattern: 'schema' },
          }],
        },
      },
      {
        type: 'user',
        uuid: 'u2',
        sessionId: 's1',
        timestamp: '2026-05-07T12:00:02.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'No matches found',
            is_error: false,
          }],
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n'));
    const reportPath = saveObservationInboxReport(
      buildObservationInboxReport(trace),
      join(dir, 'reports'),
    );
    const baseline = JSON.parse(readFileSync(reportPath, 'utf-8'));
    const expectRejected = (mutate: (value: typeof baseline) => void): void => {
      const invalid = structuredClone(baseline);
      mutate(invalid);
      writeFileSync(reportPath, JSON.stringify(invalid));
      assert.equal(loadObservationInboxReports(join(dir, 'reports')).length, 0);
    };

    expectRejected((value) => { value.meta.generatedAt = 'not-a-timestamp'; });
    expectRejected((value) => { value.items[0].firstSeen = '2026-05-08T00:00:00.000Z'; });
    expectRejected((value) => { value.meta.sessionTimeRanges[0].durationMs += 1; });
    expectRejected((value) => { value.meta.segmentCount += 1; });
    expectRejected((value) => { value.items[0].timestampedOccurrences = 0; });
    expectRejected((value) => { value.items[0].representativeEvidence = []; });
    expectRejected((value) => {
      value.items[0].representativeEvidence = [
        { ...value.items[0].evidence, query: 'different' },
        value.items[0].evidence,
      ];
    });
    expectRejected((value) => {
      value.items[0].representativeEvidence.push(
        structuredClone(value.items[0].representativeEvidence[0]),
      );
    });
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
