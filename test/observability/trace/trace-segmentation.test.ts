import { loadClaudeTraceFixture } from '../../helpers/claude-trace.js';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadTraceSessions, segmentTraceBySkill, segmentsToAnalysisEntries, normalizeSkillName, type TraceSession } from '../../../src/observability/trace/index.js';
import { buildObservationExperienceReport, compactObservationExperienceReport, normalizeObservationExperienceReport } from '../../../src/observability/experience.js';
import { asstRec, userRec, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('segmentTraceBySkill', () => {
  it('plain text without any skill signal → single "general" segment', () => {
    const plain = loadClaudeTraceFixture([asstRec('a1', [{ type: 'text', text: 'hello' }])], 's1');
    const segs = segmentTraceBySkill(plain);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'general');
  });

  it('Read of non-SKILL.md file does not trigger signal 3 → "general" segment', () => {
    // extractSkillReadFileRefFromEvent 对 references/cmds.md 返回 null 的分支
    const readRef = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '.claude/skills/review/references/cmds.md' } }]),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
    ], 's1');
    const readRefSegs = segmentTraceBySkill(readRef);
    assert.equal(readRefSegs.length, 1);
    assert.equal(readRefSegs[0].skillName, 'general');
  });

  it('CC builtin command (/clear) is NOT treated as skill → "general" segment', () => {
    // isClaudeBuiltinCommand 命中 CLAUDE_BUILTIN_COMMANDS 后剥离 command-name 信封的分支
    const ccBuiltin = loadClaudeTraceFixture([
      userRec('u1', '<command-name>/clear</command-name>'),
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
    ], 's1');
    const ccSegs = segmentTraceBySkill(ccBuiltin);
    assert.equal(ccSegs.length, 1);
    assert.equal(ccSegs[0].skillName, 'general', '/clear 是 cc 内置命令, 不切段');
  });

  it('slash-command signal cuts new segment', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'text', text: 'hi' }]),
      userRec('u1', '<command-name>/audit</command-name>\n<command-message>audit</command-message>'),
      asstRec('a2', [
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.md' } },
      ]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].skillName, 'general');
    assert.equal(segs[1].skillName, 'audit');
    assert.equal(segs[1].attribution?.source, 'command-name');
    assert.equal(segs[1].attribution?.commandName, '/audit');
    assert.equal(segs[1].turns.some((turn) => turn.content.includes('<command-message>')), false);
    assert.equal(segs[1].toolCalls.length, 1);
    assert.equal(segs[1].toolCalls[0].tool, 'Read');
  });

  it('keeps segmentation and event-level model attribution source-neutral', () => {
    const makeSession = (sourceKind: TraceSession['sourceKind']): TraceSession => ({
      runId: `run-${sourceKind}`,
      rootRunId: `run-${sourceKind}`,
      traceId: `trace-${sourceKind}`,
      groupPath: '/repo',
      role: 'standalone',
      label: sourceKind,
      sourcePath: `/repo/${sourceKind}.jsonl`,
      sourceKind,
      sourceMetadata: { provider: 'example-provider', model: 'session-model' },
      events: [
        {
          eventKind: 'message',
          eventId: `${sourceKind}:user`,
          sourceIndex: 0,
          sourceType: 'message',
          timestamp: '2026-07-25T00:00:00.000Z',
          role: 'user',
          origin: 'human',
          text: '<command-name>/audit</command-name>',
        },
        {
          eventKind: 'tool_call',
          eventId: `${sourceKind}:read`,
          sourceIndex: 1,
          sourceType: 'tool_call',
          timestamp: '2026-07-25T00:00:01.000Z',
          callId: `${sourceKind}:read`,
          tool: { name: 'Read' },
          input: { file_path: '/repo/.agents/skills/reference/SKILL.md' },
          model: 'turn-model',
        },
        {
          eventKind: 'tool_result',
          eventId: `${sourceKind}:result`,
          sourceIndex: 2,
          sourceType: 'tool_result',
          timestamp: '2026-07-25T00:00:02.000Z',
          callId: `${sourceKind}:read`,
          output: '# Reference',
          status: 'success',
          statusSource: 'runtime',
        },
      ],
    });

    const summaries = (['claude', 'codex', 'dsh', 'openclaw', 'unknown'] as const).map((sourceKind) => {
      const segments = segmentTraceBySkill(makeSession(sourceKind));
      return {
        skills: segments.map((segment) => segment.skillName),
        models: segments.map((segment) => segment.sourceMetadata?.model),
      };
    });

    assert.deepEqual(summaries, summaries.map(() => ({
      skills: ['audit'],
      models: ['turn-model'],
    })));
  });

  it('derives segment bounds from source evidence instead of trusting record order', () => {
    const session: TraceSession = {
      runId: 'out-of-order-time',
      rootRunId: 'out-of-order-time',
      traceId: 'out-of-order-time',
      groupPath: '/repo',
      role: 'standalone',
      label: 'out-of-order-time',
      sourcePath: '/repo/out-of-order-time.jsonl',
      sourceKind: 'unknown',
      startTimestamp: '2026-07-25T00:00:05.000Z',
      events: [
        {
          eventKind: 'message',
          eventId: 'earlier',
          sourceIndex: 0,
          sourceType: 'message',
          timestamp: '2026-07-25T00:00:01.000Z',
          role: 'assistant',
          origin: 'synthetic',
          text: 'start',
        },
        {
          eventKind: 'message',
          eventId: 'later',
          sourceIndex: 1,
          sourceType: 'message',
          timestamp: '2026-07-25T00:00:09.000Z',
          role: 'assistant',
          origin: 'synthetic',
          text: 'end',
        },
      ],
    };

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.startTimestamp, '2026-07-25T00:00:01.000Z');
    assert.equal(segment.endTimestamp, '2026-07-25T00:00:09.000Z');
    assert.equal(segment.metrics.durationMs, 8_000);
  });

  it('normalizes mixed timezone offsets before deriving segment bounds', () => {
    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
      asstRec('later', [{ type: 'text', text: 'later' }], {
        timestamp: '2026-07-25T08:00:09.000+08:00',
      }),
      asstRec('earlier', [{ type: 'text', text: 'earlier' }], {
        timestamp: '2026-07-25T00:00:01.000Z',
      }),
    ], 'mixed-offsets'));

    assert.equal(segment.startTimestamp, '2026-07-25T00:00:01.000Z');
    assert.equal(segment.endTimestamp, '2026-07-25T00:00:09.000Z');
    assert.equal(segment.metrics.durationMs, 8_000);
  });

  it('derives loaded session bounds from all timestamp evidence', () => {
    const path = writeSession(fixture.directory, 'out-of-order-session.jsonl', [
      asstRec('later', [{ type: 'text', text: 'later' }], {
        sessionId: 'out-of-order-session',
        timestamp: '2026-07-25T08:00:09.000+08:00',
      }),
      asstRec('earlier', [{ type: 'text', text: 'earlier' }], {
        sessionId: 'out-of-order-session',
        timestamp: '2026-07-25T00:00:01.000Z',
      }),
    ]);

    const [session] = loadTraceSessions(path);
    assert.equal(session.startTimestamp, '2026-07-25T00:00:01.000Z');
    assert.equal(session.endTimestamp, '2026-07-25T00:00:09.000Z');
  });

  it('Skill tool_use signal cuts new segment', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu0', name: 'Skill', input: { skill: 'wiki', args: 'publish' } }]),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu0', content: 'done' }]),
      asstRec('a2', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.md' } }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'content' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    // Skill tool_use 本身也归属 wiki 段, 因为信号触发即切段, 该条 tool_use 进入新段
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'wiki');
  });

  it('multiple skills in one session → multiple segments', () => {
    const s = loadClaudeTraceFixture([
      userRec('u1', '<command-name>/audit</command-name>'),
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      userRec('u3', '<command-name>/polish</command-name>'),
      asstRec('a2', [{ type: 'tool_use', id: 'tu2', name: 'Grep', input: {} }]),
      userRec('u4', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'y' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    const skills = segs.map((seg) => seg.skillName);
    assert.ok(skills.includes('audit'));
    assert.ok(skills.includes('polish'));
    const audit = segs.find((seg) => seg.skillName === 'audit')!;
    const polish = segs.find((seg) => seg.skillName === 'polish')!;
    assert.equal(audit.toolCalls[0].tool, 'Read');
    assert.equal(polish.toolCalls[0].tool, 'Grep');
  });

  it('is_error=true → ToolCallInfo.success=false + numToolFailures++', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'foo' } }]),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'err', is_error: true }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].toolCalls[0].success, false);
    assert.equal(segs[0].metrics.numToolFailures, 1);
  });

  it('keeps cancelled tool results separate from failures and success-rate evidence', () => {
    const session: TraceSession = {
      runId: 'cancelled-run',
      rootRunId: 'cancelled-run',
      traceId: 'cancelled-run',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'cancelled-run',
      sourcePath: '/tmp/cancelled.jsonl',
      sourceKind: 'codex',
      events: [
        {
          eventKind: 'tool_call',
          eventId: 'call',
          sourceIndex: 0,
          sourceType: 'response_item:function_call',
          callId: 'c1',
          tool: { name: 'Grep' },
          input: { pattern: 'needle' },
        },
        {
          eventKind: 'tool_result',
          eventId: 'result',
          sourceIndex: 1,
          sourceType: 'response_item:function_call_output',
          callId: 'c1',
          output: '',
          status: 'cancelled',
          statusSource: 'runtime',
        },
      ],
    };

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.toolCalls[0].status, 'cancelled');
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolCancelled, 1);
    assert.equal(segment.metrics.numToolUnknown, 0);
    const result = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(result.numToolFailures, 0);
    assert.equal(result.numToolCancelled, 1);
    assert.equal(result.numToolUnknown, 0);
    assert.equal(result.toolSuccessRate, undefined);
  });

  it('orphan tool_use (no matching result) stays unknown without inflating failures', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu-orphan', name: 'Read', input: {} }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs[0].toolCalls[0].success, false);
    assert.equal(segs[0].toolCalls[0].status, 'unknown');
    assert.equal(segs[0].metrics.numToolFailures, 0);
    assert.equal(segs[0].metrics.numToolUnknown, 1);
    const result = segmentsToAnalysisEntries(segs)[0].variants.general;
    assert.equal(result.numToolUnknown, 1);
    assert.equal(result.toolSuccessRate, undefined);
  });

  it('keeps assistant text and Skill tool use from one source record in the same segment', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [
        { type: 'text', text: 'I will inspect it.' },
        {
          type: 'tool_use',
          id: 'tu-skill',
          name: 'Skill',
          input: { skill: 'demo' },
        },
      ]),
    ], 's1');

    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'demo');
    assert.equal(segs[0].turns[0]?.content, 'I will inspect it.');
    assert.equal(segs[0].turns[0]?.toolCalls?.[0]?.tool, 'Skill');
  });

  it('coalesces source-neutral tool-before-text events from one record into one turn', () => {
    const session = {
      runId: 'ir-order',
      rootRunId: 'ir-order',
      traceId: 'ir-order',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-order',
      sourcePath: '/tmp/ir-order.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'tool_call',
          eventId: 'call',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'call-1',
          tool: { name: 'Skill' },
          input: { skill: 'demo' },
        },
        {
          eventKind: 'message',
          eventId: 'message',
          sourceIndex: 0,
          sourceType: 'custom',
          role: 'assistant',
          origin: 'synthetic',
          text: 'I will inspect it.',
        },
      ],
    } satisfies TraceSession;

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.numTurns, 1);
    assert.equal(segment.turns[0]?.content, 'I will inspect it.');
    assert.equal(segment.turns[0]?.toolCalls?.[0]?.tool, 'Skill');
  });

  it('correlates same-record tool results independently of adapter event order', () => {
    const session = {
      runId: 'ir-result-first',
      rootRunId: 'ir-result-first',
      traceId: 'ir-result-first',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-result-first',
      sourcePath: '/tmp/ir-result-first.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'tool_result',
          eventId: 'result',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'call-1',
          output: 'done',
          status: 'success',
          statusSource: 'runtime',
        },
        {
          eventKind: 'tool_call',
          eventId: 'call',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'call-1',
          tool: { name: 'Skill' },
          input: { skill: 'demo' },
        },
      ],
    } satisfies TraceSession;

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.toolCalls[0].status, 'success');
    assert.equal(segment.toolCalls[0].output, 'done');
    assert.equal(segment.metrics.numToolUnknown, 0);
  });

  it('correlates reused call ids in FIFO order without dropping an invocation', () => {
    const session = {
      runId: 'ir-reused-call-id',
      rootRunId: 'ir-reused-call-id',
      traceId: 'ir-reused-call-id',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-reused-call-id',
      sourcePath: '/tmp/ir-reused-call-id.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'tool_call',
          eventId: 'call-1',
          sourceIndex: 0,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/first' },
        },
        {
          eventKind: 'tool_call',
          eventId: 'call-2',
          sourceIndex: 1,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/second' },
        },
        {
          eventKind: 'tool_result',
          eventId: 'result-1',
          sourceIndex: 2,
          sourceType: 'custom',
          callId: 'reused',
          output: 'first result',
          status: 'success',
          statusSource: 'runtime',
        },
        {
          eventKind: 'tool_result',
          eventId: 'result-2',
          sourceIndex: 3,
          sourceType: 'custom',
          callId: 'reused',
          output: 'second result',
          status: 'failure',
          statusSource: 'runtime',
        },
      ],
    } satisfies TraceSession;

    const [segment] = segmentTraceBySkill(session);
    assert.deepEqual(
      segment.toolCalls.map((call) => [call.input, call.output, call.status]),
      [
        [{ file_path: '/first' }, 'first result', 'success'],
        [{ file_path: '/second' }, 'second result', 'failure'],
      ],
    );
    assert.equal(segment.metrics.numToolFailures, 1);
    assert.equal(segment.metrics.numToolUnknown, 0);
    assert.deepEqual(
      segment.toolCalls.map((call) => call.callInstanceId),
      ['call-1', 'call-2'],
    );
  });

  it('keeps reused call ids isolated across skill boundaries', () => {
    const session = {
      runId: 'ir-reused-call-id-across-skills',
      rootRunId: 'ir-reused-call-id-across-skills',
      traceId: 'ir-reused-call-id-across-skills',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'ir-reused-call-id-across-skills',
      sourcePath: '/tmp/ir-reused-call-id-across-skills.jsonl',
      sourceKind: 'unknown',
      events: [
        {
          eventKind: 'message',
          eventId: 'alpha-command',
          sourceIndex: 0,
          sourceType: 'custom',
          role: 'user',
          origin: 'human',
          text: '<command-name>/alpha</command-name>\nRun alpha.',
        },
        {
          eventKind: 'tool_call',
          eventId: 'alpha-call',
          sourceIndex: 1,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/alpha' },
        },
        {
          eventKind: 'message',
          eventId: 'beta-command',
          sourceIndex: 2,
          sourceType: 'custom',
          role: 'user',
          origin: 'human',
          text: '<command-name>/beta</command-name>\nRun beta.',
        },
        {
          eventKind: 'tool_result',
          eventId: 'alpha-result',
          sourceIndex: 3,
          sourceType: 'custom',
          callId: 'reused',
          output: 'alpha failed',
          status: 'failure',
          statusSource: 'runtime',
        },
        {
          eventKind: 'tool_call',
          eventId: 'beta-call',
          sourceIndex: 4,
          sourceType: 'custom',
          callId: 'reused',
          tool: { name: 'Read' },
          input: { file_path: '/beta' },
        },
        {
          eventKind: 'tool_result',
          eventId: 'beta-result',
          sourceIndex: 5,
          sourceType: 'custom',
          callId: 'reused',
          output: 'beta passed',
          status: 'success',
          statusSource: 'runtime',
        },
      ],
    } satisfies TraceSession;

    const segments = segmentTraceBySkill(session);
    const report = buildObservationExperienceReport({
      sessions: [session],
      segments,
      items: [],
      generatedAt: '2026-07-25T00:00:00.000Z',
    });
    const alpha = report.invocations.find((invocation) => invocation.skillName === 'alpha');
    const beta = report.invocations.find((invocation) => invocation.skillName === 'beta');

    assert.ok(alpha);
    assert.ok(beta);
    assert.equal(alpha.indicators.toolFailureCount, 1);
    assert.equal(beta.indicators.toolFailureCount, 0);
    assert.equal(
      segments.find((segment) => segment.skillName === 'alpha')?.toolCalls[0].callInstanceId,
      'alpha-call',
    );
    assert.equal(
      segments.find((segment) => segment.skillName === 'beta')?.toolCalls[0].callInstanceId,
      'beta-call',
    );
    assert.ok(alpha.timeline.some((event) =>
      event.kind === 'tool_result' && event.callInstanceId === 'alpha-call'
    ));
    assert.ok(normalizeObservationExperienceReport(
      compactObservationExperienceReport(report),
    ));
  });

  it('preserves human messages as user turns instead of tool results', () => {
    const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
      userRec('u1', '<command-name>/audit</command-name>\nPlease inspect this.'),
      asstRec('a1', [{ type: 'text', text: 'Done.' }]),
    ], 's1'));

    assert.deepEqual(
      segment.turns.map((turn) => [turn.role, turn.content]),
      [
        ['user', 'Please inspect this.'],
        ['assistant', 'Done.'],
      ],
    );
    assert.equal(segment.metrics.numTurns, 1);
  });

  it('keeps a late tool result on its originating call without overlapping skill record ranges', () => {
    const s = loadClaudeTraceFixture([
      userRec('u0', '<command-name>/audit</command-name>'),
      asstRec('a1', [{ type: 'tool_use', id: 'tu-late', name: 'Read', input: {} }]),
      userRec('u1', '<command-name>/review</command-name>'),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu-late', content: 'done' }]),
      asstRec('a2', [{ type: 'text', text: 'review done' }]),
    ], 's1');

    const [audit, review] = segmentTraceBySkill(s);
    assert.equal(audit.skillName, 'audit');
    assert.equal(audit.toolCalls[0].output, 'done');
    assert.equal(audit.endRecordIndex, 1);
    assert.equal(review.skillName, 'review');
    assert.equal(review.startRecordIndex, 2);
    assert.equal(review.endRecordIndex, 4);
  });

  it('Read .claude/skills/<name>/SKILL.md signal cuts new segment (signal 3 fallback)', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/home/user/project/.claude/skills/review/SKILL.md' } }]),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'skill body' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'review');
  });

  it('recognizes Codex plugin-cache skills but ignores repository skill fixtures', () => {
    const installed = loadClaudeTraceFixture([
      asstRec('a1', [{
        type: 'tool_use',
        id: 'tu1',
        name: 'Read',
        input: {
          file_path: '/home/user/.codex/plugins/cache/openai-bundled/browser/1.0.0/skills/control-browser/SKILL.md',
        },
      }]),
    ], 's1');
    const fixture = loadClaudeTraceFixture([
      asstRec('a2', [{
        type: 'tool_use',
        id: 'tu2',
        name: 'Read',
        input: {
          file_path: '/repo/examples/agent-eval/skills/strict-reader/SKILL.md',
        },
      }], { sessionId: 's2' }),
    ], 's2');

    assert.equal(segmentTraceBySkill(installed)[0].skillName, 'control-browser');
    assert.equal(segmentTraceBySkill(fixture)[0].skillName, 'general');
  });

  it('signal 1 (Skill tool_use) wins over signal 3 (Read SKILL.md) when both present', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [
        { type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'audit' } },
        { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '.claude/skills/other/SKILL.md' } },
      ]),
      userRec('u1', [
        { type: 'tool_result', tool_use_id: 'tu1', content: 'x' },
        { type: 'tool_result', tool_use_id: 'tu2', content: 'y' },
      ]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'audit');
  });

  it('signal 2 (slash command) wins over signal 3 (Read SKILL.md)', () => {
    const s = loadClaudeTraceFixture([
      userRec('u1', '<command-name>/polish</command-name>'),
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '.claude/skills/other/SKILL.md' } }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'polish');
  });

  it('repeated Read of same SKILL.md does not cut multiple segments', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '.claude/skills/review/SKILL.md' } }]),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
      asstRec('a2', [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '.claude/skills/review/SKILL.md' } }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'y' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'review');
  });

  it('does not leak Claude builtin command names into source-neutral skill identity', () => {
    assert.equal(normalizeSkillName('doctor'), 'doctor');
    const codexSession: TraceSession = {
      runId: 'codex-doctor',
      rootRunId: 'codex-doctor',
      traceId: 'trace-codex-doctor',
      sourcePath: '/tmp/codex-doctor.jsonl',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'codex-doctor',
      sourceKind: 'codex',
      events: [{
        eventKind: 'message',
        eventId: 'u1',
        sourceIndex: 0,
        sourceType: 'message',
        role: 'user',
        origin: 'human',
        text: '<command-name>/doctor</command-name>\nRun the skill.',
      }],
    };
    const [codexSegment] = segmentTraceBySkill(codexSession);
    assert.equal(codexSegment.skillName, 'doctor');

    const [explicitSkillSegment] = segmentTraceBySkill(loadClaudeTraceFixture([
      asstRec('a1', [{
        type: 'tool_use',
        id: 'doctor-call',
        name: 'Skill',
        input: { skill: 'doctor' },
      }]),
    ], 'claude-doctor-skill'));
    assert.equal(explicitSkillSegment.skillName, 'doctor');
  });

  it('rejects unsafe or non-slug skill identities at the attribution boundary', () => {
    for (const command of ['__proto__', 'constructor', '../audit', 'audit/child']) {
      const [segment] = segmentTraceBySkill(loadClaudeTraceFixture([
        userRec('u1', `<command-name>/${command}</command-name>\nInspect this.`),
        asstRec('a1', [{ type: 'text', text: 'Done.' }]),
      ], `unsafe-${command}`));
      assert.equal(segment.skillName, 'general');
    }
  });

  it('plugin-prefixed skill name keeps source metadata (pbakaus/impeccable:audit → audit from plugin)', () => {
    const s = loadClaudeTraceFixture([
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'pbakaus/impeccable:audit' } }]),
      userRec('u1', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }]),
      asstRec('a2', [{ type: 'tool_use', id: 'tu2', name: 'Skill', input: { skill: 'impeccable:audit' } }]),
      userRec('u2', [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    // skillName 仍归一化为 audit, 但 plugin 来源不同, 需要保留成两段。
    assert.equal(segs.length, 2);
    assert.equal(segs[0].skillName, 'audit');
    assert.equal(segs[0].attribution?.rawSkillRef, 'pbakaus/impeccable:audit');
    assert.equal(segs[0].attribution?.pluginName, 'pbakaus/impeccable');
    assert.equal(segs[1].skillName, 'audit');
    assert.equal(segs[1].attribution?.rawSkillRef, 'impeccable:audit');
    assert.equal(segs[1].attribution?.pluginName, 'impeccable');
  });

  it('plugin slash command keeps source metadata and command name', () => {
    const s = loadClaudeTraceFixture([
      userRec('u1', '<command-name>/code-security:secure-coding</command-name>\n<command-message>code-security:secure-coding</command-message>'),
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'secure-coding');
    assert.equal(segs[0].attribution?.source, 'command-name');
    assert.equal(segs[0].attribution?.rawSkillRef, 'code-security:secure-coding');
    assert.equal(segs[0].attribution?.pluginName, 'code-security');
    assert.equal(segs[0].attribution?.commandName, '/code-security:secure-coding');
  });

  it('repeated same-skill signal does not create spurious empty segments', () => {
    const s = loadClaudeTraceFixture([
      userRec('u1', '<command-name>/audit</command-name>'),
      userRec('u2', '<command-name>/audit</command-name>'),  // 重复,不应切段
      asstRec('a1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      userRec('u3', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].skillName, 'audit');
  });

  it('token usage accumulates into segment metrics', () => {
    const first = asstRec('a1', [{ type: 'text', text: 'a' }]) as {
      message: { usage: { cache_read_input_tokens: number } };
    };
    first.message.usage.cache_read_input_tokens = 7;
    const s = loadClaudeTraceFixture([
      first,
      asstRec('a2', [{ type: 'text', text: 'b' }]),
    ], 's1');
    const segs = segmentTraceBySkill(s);
    // 每条 asstRec 默认 input=10 output=20 → 累加 2 次
    assert.equal(segs[0].metrics.inputTokens, 20);
    assert.equal(segs[0].metrics.outputTokens, 40);
    assert.equal(segs[0].metrics.cacheReadTokens, 7);
    assert.equal(segs[0].metrics.tokenUsageObserved, true);
  });

  it('fails closed when aggregated segment token usage exceeds a safe integer', () => {
    const session: TraceSession = {
      runId: 'overflow',
      rootRunId: 'overflow',
      traceId: 'trace-overflow',
      groupPath: '/tmp',
      role: 'standalone',
      label: 'overflow',
      sourcePath: '/tmp/overflow.jsonl',
      sourceKind: 'codex',
      events: [
        {
          eventKind: 'message',
          eventId: 'answer',
          sourceIndex: 0,
          sourceType: 'message',
          role: 'assistant',
          origin: 'runtime',
          text: 'done',
        },
        {
          eventKind: 'usage',
          eventId: 'usage-1',
          sourceIndex: 0,
          sourceType: 'usage',
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          eventKind: 'usage',
          eventId: 'usage-2',
          sourceIndex: 1,
          sourceType: 'usage',
          inputTokens: 1,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ],
    };

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.inputTokens, 0);
    assert.equal(segment.metrics.tokenUsageObserved, false);
    const projected = segmentsToAnalysisEntries([segment])[0].variants.general;
    assert.equal(projected.totalTokens, 0);
    assert.equal(projected.tokenUsageReportedByExecutor, false);
  });
});
