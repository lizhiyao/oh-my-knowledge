import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadTraceSessions, loadTraceCorpus, segmentTraceBySkill } from '../../../src/observability/trace/index.js';
import { asstRec, userRec, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('claude trace loading', () => {
  it('recognizes Claude metadata-only traces without reporting known records as unknown', () => {
    const path = writeSession(fixture.directory, 'claude-metadata.jsonl', [
      { type: 'mode', mode: 'normal', sessionId: 'claude-meta' },
      { type: 'permission-mode', permissionMode: 'default', sessionId: 'claude-meta' },
      { type: 'queue-operation', operation: 'enqueue', content: '/model', sessionId: 'claude-meta' },
      { type: 'file-history-snapshot', snapshot: {}, sessionId: 'claude-meta' },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions.length, 1);
    assert.equal(corpus.sessions[0].sourceKind, 'claude');
    assert.equal(corpus.sessions[0].runId, 'claude-meta');
    assert.deepEqual(corpus.sessions[0].events, []);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('does not identify a generic system JSONL record as Claude without source identity', () => {
    const path = writeSession(fixture.directory, 'generic-system.jsonl', [
      { type: 'system', message: 'service started', timestamp: '2026-04-19T10:00:00.000Z' },
    ]);

    const corpus = loadTraceCorpus(path);
    assert.equal(corpus.sessions[0].sourceKind, 'unknown');
    assert.equal(corpus.sessions[0].events[0].eventKind, 'unknown');
    assert.equal(corpus.ingestion.unknownEventCount, 1);
  });

  it('maps Claude system evidence into source-neutral runtime and lifecycle events', () => {
    const path = writeSession(fixture.directory, 'claude-system.jsonl', [
      userRec('u1', '检查配置', { sessionId: 'claude-system' }),
      {
        type: 'system',
        subtype: 'api_error',
        uuid: 'system-error',
        sessionId: 'claude-system',
        timestamp: '2026-04-19T10:00:01.000Z',
        error: { formatted: 'Unable to connect to API' },
      },
      {
        type: 'system',
        subtype: 'turn_duration',
        uuid: 'turn-duration',
        sessionId: 'claude-system',
        timestamp: '2026-04-19T10:00:02.000Z',
        durationMs: 1234,
      },
    ]);

    const corpus = loadTraceCorpus(path);
    const [runtime, lifecycle] = corpus.sessions[0].events.slice(1);
    assert.equal(runtime.eventKind, 'message');
    assert.equal(runtime.eventKind === 'message' ? runtime.role : undefined, 'system');
    assert.equal(runtime.eventKind === 'message' ? runtime.text : undefined, 'Unable to connect to API');
    assert.equal(lifecycle.eventKind, 'lifecycle');
    assert.equal(lifecycle.eventKind === 'lifecycle' ? lifecycle.phase : undefined, 'turn_completed');
    assert.equal(lifecycle.eventKind === 'lifecycle' ? lifecycle.durationMs : undefined, 1234);
    assert.equal(corpus.ingestion.unknownEventCount, 0);
  });

  it('keeps Claude tool results unknown without explicit status', () => {
    const path = writeSession(fixture.directory, 'claude-unknown-tool-result.jsonl', [
      asstRec('a1', [{
        type: 'tool_use',
        id: 'read-audit',
        name: 'Read',
        input: { file_path: '/repo/.agents/skills/audit/SKILL.md' },
      }]),
      userRec('u1', [{
        type: 'tool_result',
        tool_use_id: 'read-audit',
        content: '# audit',
      }]),
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'unknown');
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolUnknown, 1);
  });

  it('maps a Claude-family sibling host AI-SDK tool block into a correlated call/result pair', () => {
    const path = writeSession(fixture.directory, 'claude-family-tool-blocks.jsonl', [
      asstRec('a1', [{
        type: 'tool-call',
        toolCallId: 'fc-read',
        toolName: 'Read',
        input: { file_path: '/repo/.agents/skills/audit/SKILL.md', encoding: 'utf8' },
      }]),
      {
        type: 'tool',
        uuid: 't1',
        parentUuid: 'a1',
        sessionId: 's1',
        timestamp: '2026-04-19T10:00:01.000Z',
        cwd: '/tmp/p',
        mode: 'code',
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'fc-read',
            toolName: 'Read',
            output: { type: 'text', value: '# audit' },
          }],
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'fc-read',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'Read');
    assert.equal((call.input as { file_path?: string }).file_path, '/repo/.agents/skills/audit/SKILL.md');
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'fc-read',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.output, '# audit');
    // 同族宿主不写显式成败字段：状态只能保持未知，不能凭输出文本冒充运行时结论。
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'unknown');
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.numToolCalls, 1);
    assert.equal(segment.metrics.numToolUnknown, 1);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('reads a Claude-family sibling host isError as the runtime tool failure signal', () => {
    const path = writeSession(fixture.directory, 'claude-family-tool-error.jsonl', [
      asstRec('a1', [{ type: 'text', text: '跑一下看看' }]),
      {
        type: 'tool',
        uuid: 't1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-04-19T10:00:01.000Z',
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'fc-bash',
            toolName: 'Bash',
            isError: true,
            output: { type: 'error-text', value: 'command not found: foo' },
          }],
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
  });

  it('keeps a non-text Claude-family sibling tool output as JSON instead of dropping evidence', () => {
    const path = writeSession(fixture.directory, 'claude-family-json-tool-output.jsonl', [
      asstRec('a1', [{ type: 'text', text: '搜索一下' }]),
      {
        type: 'tool',
        uuid: 't1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-04-19T10:00:01.000Z',
        message: {
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId: 'fc-search',
            toolName: 'Grep',
            output: { type: 'content', value: [{ file: 'src/a.ts' }] },
          }],
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.match(result.output, /src\/a\.ts/);
  });

  it('still counts a Claude-family sibling tool record without recognizable blocks as unknown', () => {
    const path = writeSession(fixture.directory, 'claude-family-empty-tool-record.jsonl', [
      asstRec('a1', [{ type: 'text', text: '看一下目录' }]),
      {
        type: 'tool',
        uuid: 't1',
        parentUuid: null,
        sessionId: 's1',
        timestamp: '2026-04-19T10:00:01.000Z',
        message: { role: 'tool', content: [{ type: 'something-new', id: 'x' }] },
      },
    ]);

    const [session] = loadTraceSessions(path);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 1);
  });

  it('keeps a Claude thinking block as plaintext model reasoning without leaking it into the reply', () => {
    const path = writeSession(fixture.directory, 'claude-thinking.jsonl', [
      asstRec('a1', [
        { type: 'thinking', thinking: '  先确认需求范围，再决定读哪个文件。  ', signature: 'EpAJCmMIDhgCKkDw' },
        { type: 'text', text: '我先看一下目录。' },
      ]),
    ]);

    const [session] = loadTraceSessions(path);
    const activity = session.events.find((event) => event.eventKind === 'model_activity');
    assert.ok(activity?.eventKind === 'model_activity');
    assert.equal(activity.activityKind, 'reasoning');
    assert.equal(activity.contentVisibility, 'plaintext');
    assert.equal(activity.text, '先确认需求范围，再决定读哪个文件。');
    assert.equal(activity.contentSource, 'text');
    const message = session.events.find((event) => event.eventKind === 'message');
    assert.ok(message?.eventKind === 'message');
    assert.equal(message.text, '我先看一下目录。');
  });

  it('records a redacted Claude thinking chain as opaque reasoning instead of inventing text', () => {
    const path = writeSession(fixture.directory, 'claude-thinking-signature-only.jsonl', [
      asstRec('a1', [{ type: 'thinking', thinking: '', signature: 'EpAJCmMIDhgCKkDw' }]),
    ]);

    const [session] = loadTraceSessions(path);
    const [activity] = session.events.filter((event) => event.eventKind === 'model_activity');
    assert.ok(activity?.eventKind === 'model_activity');
    assert.equal(activity.contentVisibility, 'opaque');
    assert.equal(activity.text, undefined);
    assert.equal(session.events.filter((event) => event.eventKind === 'message').length, 0);
  });

  it('normalizes Claude MCP calls into the shared provider identity', () => {
    const path = writeSession(fixture.directory, 'claude-mcp-tool.jsonl', [
      asstRec('a1', [{
        type: 'tool_use',
        id: 'github-readme',
        name: 'mcp__github__fetch_file',
        input: { path: 'README.md' },
      }]),
      userRec('u1', [{
        type: 'tool_result',
        tool_use_id: 'github-readme',
        content: '# omk',
        is_error: false,
      }]),
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'github-readme',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'github.fetch_file');
    assert.equal(call.tool.sourceName, 'mcp__github__fetch_file');
    assert.equal(call.tool.namespace, 'mcp__github');
    assert.equal(call.tool.provider, 'github');
    const [toolCall] = segmentTraceBySkill(session)[0].toolCalls;
    assert.equal(toolCall.tool, 'github.fetch_file');
    assert.equal(toolCall.sourceTool, 'mcp__github__fetch_file');
    assert.equal(toolCall.toolProvider, 'github');
  });
});
