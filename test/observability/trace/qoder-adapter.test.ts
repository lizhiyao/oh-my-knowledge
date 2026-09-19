import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTraceCorpus, loadTraceSessions } from '../../../src/observability/trace/index.js';
import { qoderFormatEvidence } from '../../../src/observability/trace/adapters/qoder/trace.js';
import type {
  TraceContextCompactionEvent,
  TraceEvent,
  TraceLifecycleEvent,
  TraceMessageEvent,
  TraceModelActivityEvent,
  TraceSession,
  TraceToolCallEvent,
  TraceToolResultEvent,
  TraceUnknownEvent,
  TraceUsageEvent,
} from '../../../src/observability/trace/trace-ir.js';

/**
 * Qoder CLI writes Claude-Code-family transcripts (`user` / `assistant` +
 * `sessionId` + `message`). The fixtures below keep the shapes verified against
 * real `~/.qoder-cn/projects/**\/*.jsonl` files, including the Qoder-only
 * bookkeeping records that distinguish them from genuine Claude Code output.
 */

const SESSION_ID = 'be818624-bdc2-452e-820f-fc9d7b83dd20';

interface RecordOptions {
  sessionId?: string;
  timestamp?: string;
  [key: string]: unknown;
}

function bookkeepingRecords(sessionId: string = SESSION_ID): object[] {
  return [
    { type: 'workspace-directories', sessionId, directories: ['/repo-a'] },
    { type: 'runtime-config', sessionId, model: 'qmodel_38max', reasoningEffort: null, contextWindow: 200000, timestamp: 1_789_138_462_877 },
    { type: 'active-leaf', sessionId, leafUuid: 'leaf-1', explicit: false, timestamp: 1_789_138_462_762 },
  ];
}

function qoderUser(content: unknown, options: RecordOptions = {}): object {
  const { sessionId = SESSION_ID, timestamp = '2026-09-11T14:54:22.659Z', ...rest } = options;
  return {
    type: 'user',
    uuid: `user-${String(rest.promptId ?? sessionId)}-${timestamp}`,
    timestamp,
    message: { role: 'user', content },
    permissionMode: 'acceptEdits',
    requestSetId: 'request-set-1',
    parentUuid: null,
    isSidechain: false,
    cwd: '/repo-a',
    sessionId,
    userType: 'external',
    entrypoint: 'cli',
    version: '1.1.47',
    gitBranch: 'main',
    ...rest,
  };
}

function qoderAssistant(content: unknown, options: RecordOptions = {}): object {
  const { sessionId = SESSION_ID, timestamp = '2026-09-11T14:54:30.000Z', ...rest } = options;
  return {
    type: 'assistant',
    uuid: `assistant-${String(rest.agentId ?? sessionId)}-${timestamp}`,
    timestamp,
    sessionId,
    parentUuid: null,
    isSidechain: false,
    cwd: '/repo-a',
    userType: 'external',
    entrypoint: 'cli',
    version: '1.1.47',
    gitBranch: 'main',
    message: {
      id: 'chatcmpl-1',
      type: 'message',
      role: 'assistant',
      model: 'qmodel_38max',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content,
    },
    ...rest,
  };
}

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function writeSessionFile(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function sessionFor(dir: string, name: string, records: unknown[]): TraceSession {
  const path = writeSessionFile(dir, name, jsonl(records));
  const [session] = loadTraceSessions(path);
  if (!session) throw new Error(`fixture ${name} produced no trace session`);
  return session;
}

function eventsOf<K extends TraceEvent['eventKind']>(
  session: TraceSession,
  eventKind: K,
): Extract<TraceEvent, { eventKind: K }>[] {
  return session.events.filter(
    (event): event is Extract<TraceEvent, { eventKind: K }> => event.eventKind === eventKind,
  );
}

function messageEvent(session: TraceSession, index = 0): TraceMessageEvent {
  const [event] = eventsOf(session, 'message').slice(index, index + 1);
  if (!event) throw new Error(`expected a message event at ${index}`);
  return event;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omk-qoder-trace-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('qoder trace source adapter', () => {
  it('classifies a Qoder transcript as qoder instead of claude', () => {
    const session = sessionFor(tmpDir, 'qoder.jsonl', [
      ...bookkeepingRecords(),
      qoderUser('帮我看看这个模块', { origin: { kind: 'human' }, humanInput: { text: '帮我看看这个模块', mode: 'prompt' } }),
      qoderAssistant([{ type: 'text', text: '好的，我先读代码。' }]),
    ]);

    assert.equal(session.sourceKind, 'qoder');
    assert.equal(session.runId, SESSION_ID);
    assert.equal(session.rootRunId, SESSION_ID);
    assert.equal(session.label, 'qoder.jsonl');
    assert.equal(session.cwd, '/repo-a');
    assert.equal(session.gitBranch, 'main');
    assert.equal(session.entrypoint, 'cli');
    assert.equal(session.sourcePath, join(tmpDir, 'qoder.jsonl'));
    assert.equal(session.sourceMetadata?.model, 'qmodel_38max');
    assert.equal(session.startTimestamp, '2026-09-11T14:54:22.659Z');
    assert.equal(messageEvent(session, 1).role, 'assistant');
  });

  it('does not claim a genuine Claude Code transcript, even with origin.kind', () => {
    // Claude Code 2.1.x writes `origin` too, so it cannot be the discriminator.
    const claudeRecords = [
      {
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'claude-session',
        timestamp: '2026-06-24T02:41:47.094Z',
        permissionMode: 'default',
        origin: { kind: 'human' },
        promptSource: 'typed',
        promptId: 'p1',
        isSidechain: false,
        cwd: '/repo-a',
        userType: 'external',
        entrypoint: 'cli',
        version: '2.1.187',
        gitBranch: 'main',
        slug: 'reactive-sauteeing-conway',
        message: { role: 'user', content: 'hello claude' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'claude-session',
        timestamp: '2026-06-24T02:41:50.094Z',
        cwd: '/repo-a',
        gitBranch: 'main',
        entrypoint: 'cli',
        version: '2.1.187',
        message: {
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 3, output_tokens: 4 },
        },
      },
      { type: 'attachment', uuid: 'att1', sessionId: 'claude-session', timestamp: '2026-06-24T02:41:51.094Z', attachment: { type: 'hook_success' } },
      { type: 'mode', sessionId: 'claude-session', mode: 'normal' },
      { type: 'file-history-snapshot', messageId: 'u1', snapshot: { a: 1 } },
    ];

    assert.equal(claudeRecords.some(qoderFormatEvidence), false);
    const session = sessionFor(tmpDir, 'claude.jsonl', claudeRecords);
    assert.equal(session.sourceKind, 'claude');
    assert.equal(eventsOf(session, 'unknown').length, 0);
  });

  it('falls back to Qoder-only transcript fields when bookkeeping records are absent', () => {
    // Real Qoder subagent transcripts hold none of the bookkeeping record types.
    const withHumanInput = [qoderUser('继续', { humanInput: { text: '继续', mode: 'prompt' } })];
    const withRequestSetId = [qoderAssistant([{ type: 'text', text: 'ok' }], { requestSetId: 'r1' })];
    // The predicate is per record: "does the file hold such a record" is composed by the
    // single-pass scan in source.ts, so these assertions replay that existence check with `some`.
    assert.equal(withHumanInput.some(qoderFormatEvidence), true);
    assert.equal(withRequestSetId.some(qoderFormatEvidence), true);
    assert.equal([qoderUser('继续', { requestSetId: undefined })].some(qoderFormatEvidence), false);

    const session = sessionFor(tmpDir, 'sidechain-less.jsonl', withHumanInput);
    assert.equal(session.sourceKind, 'qoder');
  });

  it('treats Qoder bookkeeping records as known metadata with no unknown noise', () => {
    const corpus = loadTraceCorpus(writeSessionFile(tmpDir, 'bookkeeping.jsonl', jsonl([
      ...bookkeepingRecords(),
      { type: 'last-prompt', sessionId: SESSION_ID, lastPrompt: '帮我看看这个模块' },
      { type: 'custom-title', sessionId: SESSION_ID, customTitle: '看法 GitHub issue', timestamp: '2026-09-15T15:41:57.818Z' },
      { type: 'file-history-snapshot', messageId: 'u1', snapshot: { a: 1 }, isSnapshotUpdate: false },
      { type: 'attachment', uuid: 'att1', sessionId: SESSION_ID, timestamp: '2026-09-11T14:54:23.659Z', attachment: { type: 'goal_state', objective: 'ship' } },
      qoderUser('帮我看看这个模块', { origin: { kind: 'human' } }),
    ])));

    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'qoder');
    assert.deepEqual(
      corpus.sessions[0].events.map((event) => event.sourceType),
      ['user'],
    );
    assert.equal(corpus.ingestion.unknownEventCount, 0);
    assert.equal(eventsOf(corpus.sessions[0], 'unknown').length, 0);
  });

  it('keeps genuinely unrecognized Qoder records as unknown evidence', () => {
    const session = sessionFor(tmpDir, 'future.jsonl', [
      ...bookkeepingRecords(),
      { type: 'qoder-future-signal', uuid: 'x1', sessionId: SESSION_ID, timestamp: '2026-09-11T14:54:24.659Z', payload: { a: 1 } },
    ]);

    const [unknown] = eventsOf(session, 'unknown') as TraceUnknownEvent[];
    assert.equal(unknown.sourceType, 'qoder-future-signal');
    assert.equal(unknown.sourceEventId, 'x1');
    assert.equal(unknown.timestamp, '2026-09-11T14:54:24.659Z');
    assert.deepEqual(unknown.raw, {
      type: 'qoder-future-signal',
      uuid: 'x1',
      sessionId: SESSION_ID,
      timestamp: '2026-09-11T14:54:24.659Z',
      payload: { a: 1 },
    });
  });

  it('keeps a message record whose payload cannot be projected as unknown evidence', () => {
    const session = sessionFor(tmpDir, 'headless-message.jsonl', [
      ...bookkeepingRecords(),
      { type: 'user', uuid: 'user-1', sessionId: SESSION_ID, timestamp: '2026-09-11T14:54:22.659Z', permissionMode: 'acceptEdits' },
      qoderUser('真实输入'),
    ]);

    const [unknown] = eventsOf(session, 'unknown') as TraceUnknownEvent[];
    assert.equal(unknown.sourceType, 'user');
    assert.equal(unknown.sourceEventId, 'user-1');
    assert.deepEqual(unknown.raw, {
      type: 'user',
      uuid: 'user-1',
      sessionId: SESSION_ID,
      timestamp: '2026-09-11T14:54:22.659Z',
      permissionMode: 'acceptEdits',
    });
    assert.deepEqual(eventsOf(session, 'message').map((event) => event.text), ['真实输入']);
  });

  it('projects an assistant record whose content is a plain string', () => {
    const session = sessionFor(tmpDir, 'string-content.jsonl', [
      ...bookkeepingRecords(),
      {
        ...qoderAssistant('ignored'),
        message: { role: 'assistant', model: 'qmodel_38max', content: '直接返回的字符串回答' },
      },
    ]);

    const [message] = eventsOf(session, 'message') as TraceMessageEvent[];
    assert.deepEqual([message.role, message.origin, message.text], ['assistant', 'synthetic', '直接返回的字符串回答']);
    assert.equal(eventsOf(session, 'unknown').length, 0);
  });

  it('turns a SessionStart hook attachment into the session lifecycle event', () => {
    const attachment = (name: string, output: string): object => ({
      type: 'attachment',
      uuid: `att-${name}`,
      sessionId: SESSION_ID,
      timestamp: '2026-09-11T14:53:00.000Z',
      attachment: { type: 'hook_output', hookEventName: name, output },
    });
    const session = sessionFor(tmpDir, 'session-start.jsonl', [
      ...bookkeepingRecords(),
      attachment('SessionStart', '# Project knowledge overview'),
      attachment('PostToolUse', 'hook printed something'),
      {
        type: 'attachment',
        uuid: 'att-goal',
        sessionId: SESSION_ID,
        timestamp: '2026-09-11T14:53:30.000Z',
        attachment: { type: 'goal_state', objective: 'ship', turnsUsed: 0, maxTurns: 20 },
      },
      qoderUser('开始干活'),
    ]);

    const [started] = eventsOf(session, 'lifecycle') as TraceLifecycleEvent[];
    assert.deepEqual(
      [started.phase, started.sourceType, started.sourceEventId, started.timestamp],
      ['session_started', 'attachment', 'att-SessionStart', '2026-09-11T14:53:00.000Z'],
    );
    assert.deepEqual(session.startTimestamp, '2026-09-11T14:53:00.000Z');
    assert.deepEqual(
      session.events.filter((event) => event.eventKind !== 'message').map((event) => event.eventKind),
      ['lifecycle'],
    );
    assert.equal(eventsOf(session, 'unknown').length, 0);
  });

  it('reads origin.kind as the authoritative message origin', () => {
    const session = sessionFor(tmpDir, 'origins.jsonl', [
      ...bookkeepingRecords(),
      qoderUser('人写的提示词', { origin: { kind: 'human' } }),
      qoderUser([{ type: 'text', text: '<task-notification>背景任务已完成</task-notification>' }], { origin: { kind: 'task-notification' } }),
      qoderUser('模型自述的续写', { origin: { kind: 'synthetic' } }),
      qoderUser('未来新增的来源类型', { origin: { kind: 'subagent-handoff' } }),
      qoderUser('没有 origin 字段的人类输入'),
    ]);

    assert.deepEqual(
      eventsOf(session, 'message').map((event) => [event.role, event.origin]),
      [
        ['user', 'human'],
        ['user', 'runtime'],
        ['user', 'synthetic'],
        ['user', 'runtime'],
        ['user', 'human'],
      ],
    );
  });

  it('correlates tool calls with results and keeps runtime tool status', () => {
    const session = sessionFor(tmpDir, 'tools.jsonl', [
      ...bookkeepingRecords(),
      qoderUser('查一下', { origin: { kind: 'human' } }),
      qoderAssistant([
        { type: 'thinking', thinking: '先读文件。', signature: '' },
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
      ]),
      qoderUser([
        { type: 'tool_result', tool_use_id: 'call-1', content: 'AGENTS.md', is_error: false },
      ]),
      qoderAssistant([
        { type: 'tool_use', id: 'call-2', name: 'mcp__kit__list_dir', input: {} },
      ]),
      qoderUser([
        { type: 'tool_result', tool_use_id: 'call-2', content: 'Error: tool not found' },
      ]),
    ]);

    const calls = eventsOf(session, 'tool_call') as TraceToolCallEvent[];
    const results = eventsOf(session, 'tool_result') as TraceToolResultEvent[];
    assert.deepEqual(calls.map((event) => [event.callId, event.tool.name, event.model, event.sourceIndex]), [
      ['call-1', 'Bash', 'qmodel_38max', 4],
      ['call-2', 'kit.list_dir', 'qmodel_38max', 6],
    ]);
    assert.deepEqual(results.map((event) => [
      event.callId,
      event.status,
      event.statusSource,
      event.callInstanceId,
    ]), [
      ['call-1', 'success', 'runtime', calls[0].eventId],
      ['call-2', 'failure', 'inferred', calls[1].eventId],
    ]);
    const [activity] = eventsOf(session, 'model_activity') as TraceModelActivityEvent[];
    assert.deepEqual([activity.activityKind, activity.contentVisibility, activity.text, activity.sourceIndex], [
      'reasoning',
      'plaintext',
      '先读文件。',
      4,
    ]);
  });

  it('marks redacted reasoning as opaque model activity', () => {
    const session = sessionFor(tmpDir, 'opaque-thinking.jsonl', [
      ...bookkeepingRecords(),
      qoderAssistant([{ type: 'thinking', thinking: '', signature: 'sig-1' }]),
    ]);

    const [activity] = eventsOf(session, 'model_activity') as TraceModelActivityEvent[];
    assert.equal(activity.contentVisibility, 'opaque');
    assert.equal(activity.text, undefined);
  });

  it('maps assistant usage counters and keeps invalid usage as unknown', () => {
    const valid = sessionFor(tmpDir, 'usage.jsonl', [
      ...bookkeepingRecords(),
      qoderAssistant([{ type: 'text', text: 'done' }], {
        message: {
          role: 'assistant',
          model: 'qmodel_38max',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 11,
            output_tokens: 22,
            cache_read_input_tokens: 33,
            cache_creation_input_tokens: 44,
            service_tier: 'standard',
            context_usage_ratio: 0.4,
          },
        },
      }),
    ]);
    const [usage] = eventsOf(valid, 'usage') as TraceUsageEvent[];
    assert.deepEqual([
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
      usage.model,
      usage.sourceType,
    ], [11, 22, 33, 44, 'qmodel_38max', 'assistant']);

    const invalid = sessionFor(tmpDir, 'invalid-usage.jsonl', [
      ...bookkeepingRecords(),
      qoderAssistant([{ type: 'text', text: 'done' }], {
        message: {
          role: 'assistant',
          model: 'qmodel_38max',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: -5, output_tokens: 2 },
        },
      }),
    ]);
    const [unknown] = eventsOf(invalid, 'unknown') as TraceUnknownEvent[];
    assert.equal(unknown.eventId, `${SESSION_ID}:3:invalid-usage`);
    assert.deepEqual((unknown.raw as { message: { usage: unknown } }).message.usage, {
      input_tokens: -5,
      output_tokens: 2,
    });
  });

  it('reports a source-marked API failure next to its fallback message', () => {
    // Real Qoder transcripts flag the failure on an assistant record that also
    // carries the user-visible fallback text; the marker must not be lost.
    const session = sessionFor(tmpDir, 'api-error.jsonl', [
      ...bookkeepingRecords(),
      qoderAssistant([{ type: 'text', text: 'Connection interrupted.\nProgress saved. Type "continue" to resume.' }], {
        isApiErrorMessage: true,
        error: 'unknown',
        displayErrorCode: '112',
        errorFallbackMessage: 'Connection interrupted.',
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Connection interrupted.\nProgress saved. Type "continue" to resume.' }],
          stop_reason: 'stop_sequence',
        },
      }),
    ]);

    const messages = eventsOf(session, 'message') as TraceMessageEvent[];
    assert.deepEqual(messages.map((event) => event.role), ['assistant']);
    assert.match(messages[0].text, /Connection interrupted/);

    const [failure] = eventsOf(session, 'lifecycle') as TraceLifecycleEvent[];
    assert.deepEqual(
      [failure.phase, failure.reason, failure.sourceType, failure.sourceEventId],
      ['turn_failed', 'unknown', 'assistant', `assistant-${SESSION_ID}-2026-09-11T14:54:30.000Z`],
    );
    assert.equal(eventsOf(session, 'unknown').length, 0);
  });

  it('maps a Qoder compaction boundary onto the source-neutral compaction event', () => {
    const session = sessionFor(tmpDir, 'compacted.jsonl', [
      ...bookkeepingRecords(),
      {
        type: 'system',
        uuid: 'sys-1',
        sessionId: SESSION_ID,
        timestamp: '2026-09-11T16:26:36.197Z',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        compactMetadata: { trigger: 'auto', messagesSummarized: 205 },
        parentUuid: null,
        isSidechain: false,
      },
    ]);

    const [compaction] = eventsOf(session, 'context_compaction') as TraceContextCompactionEvent[];
    assert.equal(compaction.summary, 'Conversation compacted');
    assert.equal(compaction.sourceEventId, 'sys-1');
    assert.equal(eventsOf(session, 'unknown').length, 0);
  });

  it('keeps a sidechain transcript as its own run under the parent session', () => {
    const agentId = 'aExplore-199aa8b80d28b942';
    const session = sessionFor(tmpDir, `agent-${agentId}.jsonl`, [
      qoderUser('只读调查任务', {
        origin: { kind: 'human' },
        humanInput: { text: '只读调查任务', mode: 'prompt' },
        isSidechain: true,
        agentId,
        parent_tool_use_id: 'call-parent',
      }),
      qoderAssistant([{ type: 'text', text: '开始' }], { isSidechain: true, agentId }),
    ]);

    assert.equal(session.sourceKind, 'qoder');
    assert.equal(session.role, 'subagent');
    assert.equal(session.runId, agentId);
    assert.equal(session.parentRunId, SESSION_ID);
    assert.equal(session.rootRunId, SESSION_ID);
  });

  it('groups a main session with its subagent transcripts without identity collision', () => {
    const root = join(tmpDir, 'project');
    mkdirSync(join(root, SESSION_ID, 'subagents'), { recursive: true });
    const agentId = 'aExplore-199aa8b80d28b942';
    writeSessionFile(root, `${SESSION_ID}.jsonl`, jsonl([
      ...bookkeepingRecords(),
      qoderUser('主会话输入', { origin: { kind: 'human' } }),
      qoderAssistant([{ type: 'tool_use', id: 'call-1', name: 'Task', input: {} }]),
      qoderUser([{ type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false }]),
    ]));
    writeSessionFile(join(root, SESSION_ID, 'subagents'), `agent-${agentId}.jsonl`, jsonl([
      qoderUser('子任务输入', { origin: { kind: 'human' }, humanInput: { text: '子任务输入', mode: 'prompt' }, isSidechain: true, agentId }),
      qoderAssistant([{ type: 'text', text: '子任务输出' }], { isSidechain: true, agentId }),
    ]));

    const corpus = loadTraceCorpus(root);
    const byRunId = new Map(corpus.sessions.map((session) => [session.runId, session]));
    assert.equal(corpus.sessions.length, 2);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
    const main = byRunId.get(SESSION_ID);
    const subagent = byRunId.get(agentId);
    assert.ok(main && subagent);
    assert.deepEqual([main.role, main.sourceKind], ['standalone', 'qoder']);
    assert.deepEqual([subagent.role, subagent.sourceKind], ['subagent', 'qoder']);
    assert.equal(main.rootRunId, SESSION_ID);
    assert.equal(subagent.rootRunId, SESSION_ID);
    assert.equal(subagent.parentRunId, SESSION_ID);
    // The sidechain keeps its own run identity, so the two evidence streams stay
    // distinguishable while still resolving to one group.
    assert.equal(main.groupPath, `qoder:${SESSION_ID}`);
    assert.equal(subagent.groupPath, `qoder:${SESSION_ID}`);
    assert.notEqual(subagent.traceId, main.traceId);
  });

  it('tolerates malformed and non-record lines without losing the session', () => {
    const path = writeSessionFile(tmpDir, 'broken.jsonl', [
      '{not json',
      jsonl(bookkeepingRecords()),
      'null',
      '[]',
      jsonl([qoderUser('输入', { origin: { kind: 'human' } })]),
      '',
      '   ',
    ].join('\n'));

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'qoder');
    assert.equal(corpus.sessions[0].runId, SESSION_ID);
    assert.deepEqual(messageEvent(corpus.sessions[0]).text, '输入');
    assert.equal(corpus.ingestion.malformedRecordCount, 1);
    assert.equal(corpus.ingestion.ignoredValueCount, 2);
    assert.equal(corpus.ingestion.parsedRecordCount, 4);
  });

  it('strips only builtin slash-command envelopes from Qoder prompts', () => {
    const session = sessionFor(tmpDir, 'commands.jsonl', [
      ...bookkeepingRecords(),
      qoderUser('<command-name>/clear</command-name><command-message>clear</command-message>', { origin: { kind: 'human' } }),
      qoderUser('<command-name>/my-skill</command-name>\n执行技能', { origin: { kind: 'human' } }),
    ]);

    const messages = eventsOf(session, 'message');
    assert.deepEqual(messages.map((event) => event.text), [
      '<command-name>/my-skill</command-name>\n执行技能',
    ]);
  });
});
