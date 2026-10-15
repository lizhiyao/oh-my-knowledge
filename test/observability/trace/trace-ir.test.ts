import { loadClaudeTraceFixture } from '../../helpers/claude-trace.js';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { loadTraceSessions, segmentTraceBySkill, segmentsToAnalysisEntries } from '../../../src/observability/trace/index.js';
import { buildObservationExperienceReport, compactObservationExperienceReport, normalizeObservationExperienceReport, projectTraceSessionTimeline } from '../../../src/observability/experience.js';
import { countUnknownEventDispositions } from '../../../src/observability/trace/unknown-disposition.js';
import { asstRec, writeSession, traceFixture } from '../../helpers/trace-fixtures.js';

const fixture = traceFixture();

describe('source-neutral Trace IR', () => {
  it('preserves MCP identity and uses authoritative runtime failure status', () => {
    const path = writeSession(fixture.directory, 'codex-mcp.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call-1',
          name: 'mcp__codex_apps__github',
          arguments: JSON.stringify({ owner: 'openai', repo: 'codex' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'mcp-call-1',
          output: 'request completed',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-call-1',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: {
            Ok: {
              isError: true,
              content: [{ type: 'text', text: 'request denied' }],
            },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call-2',
          name: 'mcp__codex_apps__github',
          arguments: JSON.stringify({ query: 'issues' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-call-2',
          invocation: { server: 'github', tool: 'search_issues' },
          result: {
            Ok: {
              isError: false,
              content: [{ type: 'text', text: '2 issues' }],
            },
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) => event.eventKind === 'tool_call' && event.callId === 'mcp-call-1');
    const result = session.events.find((event) => event.eventKind === 'tool_result' && event.callId === 'mcp-call-1');
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'github.fetch_file');
    assert.equal(call.tool.namespace, 'mcp__codex_apps');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    const synthesized = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-call-2',
    );
    assert.ok(synthesized?.eventKind === 'tool_result');
    assert.equal(synthesized.status, 'success');
    assert.equal(synthesized.output, '2 issues');

    const [segment] = segmentTraceBySkill(session);
    const failedCall = segment.toolCalls.find((toolCall) => toolCall.toolUseId === 'mcp-call-1');
    assert.equal(failedCall?.tool, 'github.fetch_file');
    assert.equal(failedCall?.success, false);
    assert.equal(segment.metrics.numToolFailures, 1);
  });

  it('pairs reused Codex MCP call ids by occurrence', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-reused-call-id.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-reused', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'reused-call',
          name: 'mcp__server__placeholder',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'reused-call',
          invocation: { server: 'server', tool: 'first' },
          result: { Ok: { content: [{ type: 'text', text: 'first output' }] } },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'reused-call' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'reused-call',
          name: 'mcp__server__placeholder',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'reused-call',
          invocation: { server: 'server', tool: 'second' },
          result: { Err: 'second output' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'reused-call' },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const [segment] = segmentTraceBySkill(session);
    const calls = session.events.filter((event) => event.eventKind === 'tool_call');
    const results = session.events.filter((event) => event.eventKind === 'tool_result');
    assert.equal(new Set(calls.map((event) => event.callInstanceId)).size, 2);
    assert.deepEqual(
      results.map((event) => event.callInstanceId),
      calls.map((event) => event.callInstanceId),
    );
    assert.deepEqual(
      segment.toolCalls.map((call) => [call.tool, call.output, call.status]),
      [
        ['server.first', 'first output', 'success'],
        ['server.second', 'second output', 'failure'],
      ],
    );
  });

  it('maps Codex MCP result.Err to an authoritative failure', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-err.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-err', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-call-err',
          name: 'mcp__codex_apps__github',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-call-err',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: { Err: { message: 'connector unavailable' } },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-call-err',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    assert.match(result.output, /connector unavailable/);
  });

  it('falls back to function output status when MCP end has no outcome field', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-output-status.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-output-status', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'mcp-output-status',
          name: 'mcp__codex_apps__github',
          arguments: '{}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'mcp-output-status',
          status: 'completed',
          output: 'done',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-output-status',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: { Ok: { content: [{ type: 'text', text: 'done' }] } },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-output-status',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
  });

  it('pairs standalone Codex MCP end events with a source-neutral tool call', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-standalone.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-standalone', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          id: 'mcp-end-record-1',
          call_id: 'exec-runtime-call',
          invocation: {
            server: 'node_repl',
            tool: 'js',
            arguments: { code: 'return 1' },
          },
          result: {
            Ok: {
              isError: false,
              content: [{ type: 'text', text: 'done' }],
            },
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'exec-runtime-call',
    );
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'exec-runtime-call',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'node_repl.js');
    assert.equal(call.tool.provider, 'node_repl');
    assert.deepEqual(call.input, { code: 'return 1' });
    assert.equal(call.sourceEventId, 'mcp-end-record-1');
    assert.equal(call.sourceType, 'event_msg:mcp_tool_call_end');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'success');
    assert.equal(result.sourceEventId, 'mcp-end-record-1');

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.toolCalls[0].tool, 'node_repl.js');
    assert.equal(segment.toolCalls[0].status, 'success');
  });

  it('treats a standalone Codex MCP Ok result as authoritative success without an isError flag', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-ok-without-flag.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-ok-without-flag', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-ok-call',
          invocation: { server: 'github', tool: 'fetch_file' },
          result: {
            Ok: {
              content: [{ type: 'text', text: 'done' }],
            },
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-ok-call',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
  });

  it('keeps an explicit Codex MCP cancellation even when is_error is false', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-cancelled.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-cancelled', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'mcp_tool_call_end',
          call_id: 'mcp-cancelled-call',
          status: 'cancelled',
          is_error: false,
          invocation: {
            server: 'github',
            tool: 'fetch_file',
            arguments: { path: 'README.md' },
          },
          output: 'cancelled by user',
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'mcp-cancelled-call'
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'cancelled');
    assert.equal(result.statusSource, 'runtime');
  });

  it('maps a Codex item_completed MCP tool call into a correlated call/result pair', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-mcp.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-mcp', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'McpToolCall',
            id: 'exec-runtime-1',
            server: 'node_repl',
            tool: 'js',
            arguments: { code: 'return 1' },
            status: 'completed',
            result: { content: [{ type: 'text', text: 'done' }] },
            duration: 0.42,
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'exec-runtime-1',
    );
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'exec-runtime-1',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'node_repl.js');
    assert.equal(call.tool.provider, 'node_repl');
    assert.deepEqual(call.input, { code: 'return 1' });
    assert.equal(call.sourceType, 'event_msg:item_completed');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.output, 'done');
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'runtime');
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('counts a Codex MCP call once when item_completed repeats the response item view', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-mcp-duplicate.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-mcp-duplicate', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-dup',
          call_id: 'call-dup',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({ code: 'return 2' }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          id: 'fco-dup',
          call_id: 'call-dup',
          output: 'tool returned an error',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'McpToolCall',
            id: 'call-dup',
            server: 'node_repl',
            tool: 'js',
            arguments: { code: 'return 2' },
            status: 'failed',
            result: { content: [{ type: 'text', text: 'tool returned an error' }] },
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    assert.equal(session.events.filter((event) =>
      event.eventKind === 'tool_call' && event.callId === 'call-dup',
    ).length, 1);
    const results = session.events.filter((event) =>
      event.eventKind === 'tool_result' && event.callId === 'call-dup',
    );
    assert.equal(results.length, 1);
    // 同一调用只留一份证据，但事件视图的权威状态仍要生效。
    const [result] = results;
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('reads an item_completed MCP failure as a runtime tool failure', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-mcp-failed.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-mcp-failed', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'McpToolCall',
            id: 'exec-runtime-2',
            server: 'node_repl',
            tool: 'js',
            arguments: { code: 'throw new Error("boom")' },
            status: 'failed',
            result: { content: [{ type: 'text', text: 'boom' }] },
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'failure');
    assert.equal(result.statusSource, 'runtime');
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.numToolCalls, 1);
    assert.equal(segment.metrics.numToolFailures, 1);
  });

  it('maps a sole-carrier item_completed WebSearch into a tool pair', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-web-search.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-web-search', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'WebSearch',
            id: 'exec-search-1',
            query: 'degit subdirectory syntax',
            action: { type: 'search', query: 'degit subdirectory syntax', queries: ['degit subdirectory syntax'] },
            results: [{ type: 'text_result', title: 'degit - npm', url: 'https://npmjs.com/package/degit' }],
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'exec-search-1',
    );
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'exec-search-1',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.tool.name, 'WebSearch');
    assert.deepEqual(call.input, {
      type: 'search',
      query: 'degit subdirectory syntax',
      queries: ['degit subdirectory syntax'],
    });
    assert.equal(call.sourceType, 'event_msg:item_completed');
    assert.ok(result?.eventKind === 'tool_result');
    // 没有显式成败字段：带结果的完成记录只能推断成功，不能冒充运行时结论。
    assert.match(result.output, /https:\/\/npmjs\.com\/package\/degit/);
    assert.equal(result.status, 'success');
    assert.equal(result.statusSource, 'inferred');
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('counts each item_completed WebSearch duplicate view once', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-web-search-duplicates.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-web-search-duplicates', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          id: 'ws-exact',
          status: 'failed',
          action: { type: 'search', query: 'exact id twin' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'WebSearch',
            id: 'ws-exact',
            query: 'exact id twin',
            action: { type: 'search', query: 'exact id twin' },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          id: 'ws-adjacent',
          status: 'completed',
          action: { type: 'search', query: 'adjacent query twin' },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'WebSearch',
            id: 'ws-renamed',
            query: 'adjacent query twin',
            action: { type: 'search', query: 'adjacent query twin' },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-search',
          namespace: 'web',
          name: 'run',
          arguments: '{"search_query":[{"q":"tool call twin"}]}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-search', output: 'No results.' },
      },
      {
        timestamp: '2026-07-25T00:00:07.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'WebSearch',
            id: 'call-search',
            query: 'a query only the item view carries',
            action: { type: 'search', query: 'a query only the item view carries' },
            results: [{ type: 'text_result', title: 'No results', url: 'https://example.com' }],
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const calls = session.events.filter((event) => event.eventKind === 'tool_call');
    assert.deepEqual(calls.map((event) => event.callId), ['ws-exact', 'ws-adjacent', 'call-search']);
    assert.equal(calls.length, new Set(calls.map((event) => event.callId)).size);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
    const exactResult = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'ws-exact',
    );
    assert.ok(exactResult?.eventKind === 'tool_result');
    // 重复视图不产出第二组事件，但原视图的运行时状态仍然有效。
    assert.equal(exactResult.status, 'failure');
    assert.equal(exactResult.statusSource, 'runtime');
  });

  it('keeps a sole-carrier WebSearch without results statusless', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-web-search-empty.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-web-search-empty', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'WebSearch',
            id: 'ws-no-results',
            query: 'pruned history search',
            action: { type: 'search', query: 'pruned history search' },
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.output, '');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'unknown');
  });

  it('按族映射已定论的 Codex item 视图，口径未定的继续留证据', () => {
    const path = writeSession(fixture.directory, 'codex-item-completed-family-mapping.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-item-completed-family-mapping', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          started_at_ms: 1_700_000_000_000,
          completed_at_ms: 1_700_000_002_500,
          item: {
            type: 'FileChange',
            id: 'exec-runtime-3',
            status: 'completed',
            changes: {
              '/repo/a.ts': { type: 'update', unified_diff: '--- a/a.ts\n+++ b/a.ts\n+x\n+y\n-z' },
              '/repo/nested/b.ts': { type: 'add', unified_diff: '--- /dev/null\n+++ b/nested/b.ts\n+w' },
              '/outside/c.ts': { type: 'delete', unified_diff: '--- a/c.ts\n+++ /dev/null\n-c' },
            },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'SubAgentActivity',
            id: 'exec-runtime-4',
            kind: 'started',
            agent_thread_id: 'thread-child',
            agent_path: 'main/researcher',
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'EnteredReviewMode',
            id: 'item-5',
            target: { type: 'base_branch', branch: 'main' },
            user_facing_hint: 'Reviewing the diff against main',
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'ExitedReviewMode',
            id: 'item-6',
            review_output: { findings: [{ title: 'Off-by-one', body: 'loop ends early', priority: 2 }] },
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:05.000Z',
        type: 'event_msg',
        payload: { type: 'item_completed', item: { type: 'ImageView', id: 'exec-runtime-7', path: '/repo/shot.png' } },
      },
      {
        timestamp: '2026-07-25T00:00:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'Extension',
            kind: 'web.search',
            id: 'exec-runtime-8',
            action: { type: 'search', query: 'vitest v4 migration' },
            results: [{ type: 'text_result', title: 'Migration Guide', url: 'https://example.test/guide' }],
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const effect = session.events.find((event) => event.eventKind === 'observed_effect');
    assert.ok(effect?.eventKind === 'observed_effect');
    assert.equal(effect.effectKind, 'file_change');
    assert.equal(effect.changeCount, 3, '一条记录覆盖三个文件，变更数按记录里的条目计');
    assert.deepEqual(effect.paths, ['a.ts', 'nested/b.ts'], '绝对路径只留在原始日志里，会话外的路径不投影');
    assert.equal(effect.addedLines, 3);
    assert.equal(effect.deletedLines, 2);
    assert.equal(effect.status, 'success');
    assert.equal(effect.statusSource, 'runtime');
    assert.equal(effect.durationMs, 2_500);
    assert.deepEqual(effect.sourceIds, ['exec-runtime-3']);

    const agent = session.events.find((event) => event.eventKind === 'agent_activity');
    assert.ok(agent?.eventKind === 'agent_activity');
    assert.equal(agent.activityKind, 'lifecycle');
    assert.equal(agent.agentId, 'thread-child');
    assert.equal(agent.agentPath, 'main/researcher');
    assert.equal(agent.activity, 'started');

    const review = session.events.find(
      (event) => event.eventKind === 'lifecycle' && event.phase === 'review_started',
    );
    assert.ok(review, '进入评审只是模式切换，映射成 lifecycle');

    const searchCall = session.events.find(
      (event) => event.eventKind === 'tool_call' && event.tool.name === 'WebSearch',
    );
    assert.ok(searchCall?.eventKind === 'tool_call', 'Extension 承载的搜索按 WebSearch 同一口径映射');
    assert.deepEqual(searchCall.input, { type: 'search', query: 'vitest v4 migration' });
    const searchResult = session.events.find(
      (event) => event.eventKind === 'tool_result' && event.callId === searchCall.callId,
    );
    assert.ok(searchResult?.eventKind === 'tool_result');
    assert.match(searchResult.output, /example\.test\/guide/);

    const unknownFamilies = session.events
      .filter((event) => event.eventKind === 'unknown')
      .map((event) => event.recordFamily)
      .sort();
    assert.deepEqual(
      unknownFamilies,
      ['ExitedReviewMode', 'ImageView'],
      '评审结论与图片查看的口径未定，保留原始证据而不是硬塞进现有档位',
    );
  });

  it('观测到的文件变更进时间线，并让既有行的 id 保持稳定', () => {
    const withoutEffect = [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-effect-row', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '先把入口改掉' },
      },
    ];
    const effectRecord = {
      timestamp: '2026-07-25T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        item: {
          type: 'FileChange',
          id: 'exec-eff-1',
          status: 'completed',
          changes: { '/repo/src/a.ts': { type: 'update', unified_diff: '--- a\n+++ b\n+x' } },
        },
      },
    };

    const session = loadTraceSessions(writeSession(fixture.directory, 'codex-effect-row.jsonl', [...withoutEffect, effectRecord]))[0];
    // 同一条 trace 上比较「有／无观测效果行」两条时间线：换文件会让 traceId 一起变，测不出漂移。
    const rows = projectTraceSessionTimeline(session);
    const baseRows = projectTraceSessionTimeline({
      ...session,
      events: session.events.filter((event) => event.eventKind !== 'observed_effect'),
    });

    const effect = rows.find((entry) => entry.kind === 'observed_effect');
    assert.ok(effect, '文件变更要出现在时间线里');
    assert.equal(effect.label, 'observed file change');
    assert.match(effect.snippet ?? '', /src\/a\.ts/, '路径按会话 cwd 相对化');
    assert.match(effect.fullText ?? '', /"changeCount":1/);

    const baseIds = baseRows.map((entry) => entry.id);
    const keptIds = rows.filter((entry) => entry.kind !== 'observed_effect').map((entry) => entry.id);
    assert.deepEqual(keptIds, baseIds, '新增一档不得让已有行的证据 id 漂移，否则已保存的评审会指向别处');

  });

  it('子代理状态变化以 lifecycle 呈现，不冒充代理间通信', () => {
    const path = writeSession(fixture.directory, 'codex-agent-lifecycle-label.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-agent-lifecycle-label', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'SubAgentActivity', id: 'exec-a', kind: 'finished', agent_thread_id: 't-1', agent_path: 'main/x' },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const timeline = projectTraceSessionTimeline(session);
    const row = timeline.find((entry) => entry.kind === 'agent_activity');
    assert.ok(row, '子代理状态要出现在时间线里');
    assert.equal(row.label, 'agent lifecycle');
    assert.match(row.fullText ?? '', /"activityKind":"lifecycle"/);
  });

  it('把 shell 结果视图的执行属性并回同一次调用的工具结果', () => {
    const path = writeSession(fixture.directory, 'codex-shell-result-view-merge.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-shell-result-view-merge', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-ls',
          id: 'ctc-ls',
          name: 'exec',
          input: 'const r = await tools.exec_command({"cmd": "ls -la"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call-ls', output: 'a.ts\nb.ts' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          started_at_ms: 1_700_000_000_000,
          completed_at_ms: 1_700_000_001_500,
          item: {
            type: 'CommandExecution',
            id: 'exec-shell-1',
            command: ['/bin/zsh', '-lc', 'ls -la'],
            parsed_cmd: [{ type: 'command', cmd: 'ls -la' }],
            exit_code: 2,
            status: 'completed',
            aggregated_output: 'a.ts\nb.ts',
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.exitCode, 2, '退出码来自运行时记录的结果视图，不再从输出文本正则猜');
    assert.equal(result.durationMs, 1_500);
    assert.deepEqual(result.sourceIds, ['call-ls', 'exec-shell-1'], '两侧原生 id 都登记，跨视图去重才有身份可用');
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('结果视图写在输出记录之前时也只归属一次，不重复产出未知事件', () => {
    const path = writeSession(fixture.directory, 'codex-shell-result-view-first.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-shell-result-view-first', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-early',
          id: 'ctc-early',
          name: 'exec',
          input: 'const r = await tools.exec_command({"cmd": "pwd"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          started_at_ms: 1_700_000_000_000,
          completed_at_ms: 1_700_000_000_400,
          item: {
            type: 'CommandExecution',
            id: 'exec-early-1',
            parsed_cmd: [{ type: 'command', cmd: 'pwd' }],
            exit_code: 0,
            status: 'completed',
          },
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call-early', output: '/repo' },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.exitCode, 0);
    assert.equal(result.durationMs, 400);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  function shellFanoutRecords(sessionId: string, calls: Array<{ callId: string; commands: string[] }>, views: Array<{ id: string; commands: string[]; exitCode?: number; durationMs?: number }>): unknown[] {
    let clock = 1_700_000_000_000;
    const next = (offset: number) => {
      clock += offset;
      return clock;
    };
    const records: unknown[] = [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo', model_provider: 'openai' },
      },
    ];
    for (const call of calls) {
      const started = next(1_000);
      records.push(
        {
          timestamp: new Date(started).toISOString(),
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: call.callId,
            id: `ctc-${call.callId}`,
            name: 'exec',
            input: call.commands.map((command) => `await tools.exec_command(${JSON.stringify({ cmd: command })});`).join('\n'),
          },
        },
        {
          timestamp: new Date(next(1_000)).toISOString(),
          type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: call.callId, output: 'ok' },
        },
      );
    }
    for (const view of views) {
      const started = next(1_000);
      records.push({
        timestamp: new Date(started).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          ...(view.durationMs === undefined ? {} : { started_at_ms: started, completed_at_ms: started + view.durationMs }),
          item: {
            type: 'CommandExecution',
            id: view.id,
            parsed_cmd: view.commands.map((command) => ({ type: 'command', cmd: command })),
            ...(view.exitCode === undefined ? {} : { exit_code: view.exitCode }),
            status: 'completed',
          },
        },
      });
    }
    return records;
  }

  it('同组里有条目没报告退出码时不填聚合值', () => {
    const path = writeSession(fixture.directory, 'codex-shell-fanout-partial-exit.jsonl', shellFanoutRecords(
      'codex-shell-fanout-partial-exit',
      [{ callId: 'call-partial-exit', commands: ['x', 'y'] }],
      [
        { id: 'exec-pe1', commands: ['x'], exitCode: 0, durationMs: 30 },
        { id: 'exec-pe2', commands: ['y'], durationMs: 40 },
      ],
    ));

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.exitCode, undefined, '缺一条就没资格说这次调用的退出码是多少');
    assert.equal(result.durationMs, 70);
  });

  it('一次桥接调用跑多条命令时，逐条结果视图归入那次调用', () => {
    const path = writeSession(fixture.directory, 'codex-shell-fanout.jsonl', shellFanoutRecords(
      'codex-shell-fanout',
      [{ callId: 'call-multi', commands: ['git status', 'git diff', 'ls'] }],
      [
        { id: 'exec-f1', commands: ['git status'], exitCode: 0, durationMs: 100 },
        { id: 'exec-f2', commands: ['git diff'], exitCode: 0, durationMs: 200 },
        { id: 'exec-f3', commands: ['ls'], exitCode: 0, durationMs: 50 },
      ],
    ));

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.exitCode, 0, '同组退出码取值唯一，才能当作这次调用的退出码');
    assert.equal(result.durationMs, 350, '时长可加：同组求和');
    assert.deepEqual(result.sourceIds, ['call-multi', 'exec-f1', 'exec-f2', 'exec-f3']);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('同组退出码不一致时不替整次调用编一个成败结论', () => {
    const path = writeSession(fixture.directory, 'codex-shell-fanout-mixed.jsonl', shellFanoutRecords(
      'codex-shell-fanout-mixed',
      [{ callId: 'call-mixed', commands: ['make', 'make test'] }],
      [
        { id: 'exec-m1', commands: ['make'], exitCode: 0, durationMs: 900 },
        { id: 'exec-m2', commands: ['make test'], exitCode: 2, durationMs: 100 },
      ],
    ));

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.exitCode, undefined, '两个不同的退出码不属于同一次调用能给出的结论');
    assert.equal(result.durationMs, 1_000);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('子集视图被两次以上调用包含时不归属，避免把结果安错调用', () => {
    const path = writeSession(fixture.directory, 'codex-shell-fanout-ambiguous.jsonl', shellFanoutRecords(
      'codex-shell-fanout-ambiguous',
      [
        { callId: 'call-a', commands: ['pwd', 'ls'] },
        { callId: 'call-b', commands: ['pwd', 'cat x'] },
      ],
      [{ id: 'exec-amb', commands: ['pwd'], exitCode: 0, durationMs: 10 }],
    ));

    const [session] = loadTraceSessions(path);
    const results = session.events.filter((event) => event.eventKind === 'tool_result');
    for (const result of results) {
      assert.equal(result.exitCode, undefined);
      assert.equal(result.durationMs, undefined);
    }
    const [unknown] = session.events.filter((event) => event.eventKind === 'unknown');
    assert.ok(unknown?.eventKind === 'unknown', '有歧义就留在待映射证据里，等更硬的证据');
    assert.equal(unknown.recordId, 'exec-amb');
  });

  it('同组缺任何一条时长时不求和，避免给出偏小的时长', () => {
    const path = writeSession(fixture.directory, 'codex-shell-fanout-partial.jsonl', shellFanoutRecords(
      'codex-shell-fanout-partial',
      [{ callId: 'call-partial', commands: ['a', 'b'] }],
      [
        { id: 'exec-p1', commands: ['a'], exitCode: 0, durationMs: 40 },
        { id: 'exec-p2', commands: ['b'], exitCode: 0 },
      ],
    ));

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.durationMs, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(session.events.filter((event) => event.eventKind === 'unknown').length, 0);
  });

  it('归属不到唯一调用的 shell 视图不猜执行属性，继续留作证据', () => {
    const path = writeSession(fixture.directory, 'codex-shell-result-view-unmatched.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-shell-result-view-unmatched', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-git',
          name: 'exec',
          input: 'const r = await tools.exec_command({"cmd": "git status"});',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'call-git', output: 'clean' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'exec-shell-9',
            parsed_cmd: [{ type: 'command', cmd: 'mystery --flag' }],
            exit_code: 7,
            status: 'completed',
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) => event.eventKind === 'tool_result');
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.exitCode, undefined, '命令集合对不上就不能把别的退出码安到这次调用上');
    const [unknown] = session.events.filter((event) => event.eventKind === 'unknown');
    assert.ok(unknown?.eventKind === 'unknown');
    assert.equal(unknown.recordFamily, 'CommandExecution');
    assert.equal(unknown.recordId, 'exec-shell-9');
  });

  it('超过上限的原始记录只留摘要与身份，整条记录仍可按族分桶', () => {
    const path = writeSession(fixture.directory, 'codex-unknown-raw-truncated.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-unknown-raw-truncated', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'Extension',
            kind: 'image_gen.generation',
            id: 'exec-image-1',
            status: 'completed',
            savedPath: '/repo/out.png',
            result: 'x'.repeat(20_000),
          },
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const [unknown] = session.events.filter((event) => event.eventKind === 'unknown');
    assert.ok(unknown?.eventKind === 'unknown');
    assert.equal(unknown.raw, undefined, 'MB 级 base64 不进派生层，回指位置由 sourceIndex 与 sourcePath 提供');
    assert.equal(unknown.rawTruncated, true);
    assert.ok((unknown.rawBytes ?? 0) > 8 * 1024);
    assert.match(String(unknown.rawDigest), /^[0-9a-f]{16}$/);
    assert.equal(unknown.recordFamily, 'Extension');
    assert.equal(unknown.recordId, 'exec-image-1');
    assert.deepEqual(
      countUnknownEventDispositions(session),
      { unsupported: 0, duplicateView: 0, unmappedEvidence: 1 },
      '被摘要掉的记录不能因此降级成未支持格式',
    );
  });

  it('uses Codex call namespace when an MCP end event is absent', () => {
    const path = writeSession(fixture.directory, 'codex-mcp-namespace-only.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-mcp-namespace-only', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          id: 'fc-node-read-skill',
          call_id: 'node-read-skill',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({
            code: 'await tools.exec_command({cmd: "cat /home/user/.codex/plugins/cache/openai-bundled/chrome/1/skills/control-chrome/SKILL.md"});',
          }),
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const call = session.events.find((event) =>
      event.eventKind === 'tool_call' && event.callId === 'node-read-skill',
    );
    assert.ok(call?.eventKind === 'tool_call');
    assert.equal(call.sourceEventId, 'fc-node-read-skill');
    assert.equal(call.tool.name, 'node_repl.js');
    assert.equal(call.tool.namespace, 'mcp__node_repl');
    assert.equal(call.tool.provider, 'node_repl');

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.skillName, 'control-chrome');
    assert.equal(segment.attribution?.source, 'read-skill-md');
  });

  it('attributes skill scripts executed through Codex node_repl code', () => {
    const path = writeSession(fixture.directory, 'codex-node-skill-script.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-node-skill-script', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'node-run-skill',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({
            code: 'await import("/home/user/.codex/plugins/cache/openai-bundled/chrome/1/skills/control-chrome/scripts/browser-client.mjs");',
          }),
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.skillName, 'control-chrome');
    assert.equal(segment.attribution?.source, 'skill-script');
  });

  it('does not treat repository fixture scripts as active skill evidence', () => {
    const path = writeSession(fixture.directory, 'codex-repository-skill-script.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-repository-skill-script', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'node-run-fixture',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({
            code: 'await import("/repo/examples/agent-eval/skills/fixture/scripts/run.mjs");',
          }),
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.skillName, 'general');
    assert.equal(segment.attribution?.source, 'general');
  });

  it('keeps Codex tool results unknown when the protocol provides no outcome evidence', () => {
    const path = writeSession(fixture.directory, 'codex-tool-unknown.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-tool-unknown', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'plain-call',
          name: 'custom_tool',
          arguments: '{"query":"status"}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plain-call',
          output: 'completed',
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'plain-call',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'unknown');

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.toolCalls[0].status, 'unknown');
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolUnknown, 1);
  });

  it('keeps an explicit Codex unknown status authoritative over output text', () => {
    const path = writeSession(fixture.directory, 'codex-tool-explicit-unknown.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-tool-explicit-unknown', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'plain-call',
          name: 'custom_tool',
          arguments: '{"query":"status"}',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'plain-call',
          status: 'unknown',
          output: 'Error: terminal status was not reported',
        },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const result = session.events.find((event) =>
      event.eventKind === 'tool_result' && event.callId === 'plain-call',
    );
    assert.ok(result?.eventKind === 'tool_result');
    assert.equal(result.status, 'unknown');
    assert.equal(result.statusSource, 'runtime');

    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.numToolFailures, 0);
    assert.equal(segment.metrics.numToolUnknown, 1);
  });

  it('classifies Codex instructions as runtime context instead of human turns', () => {
    const path = writeSession(fixture.directory, 'codex-runtime-context.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-runtime-context', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>...</INSTRUCTIONS>' },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '<environment_context><cwd>/repo</cwd></environment_context>' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: '请检查这个实现。' },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '检查完成。' },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const userOrigins = session.events.flatMap((event) =>
      event.eventKind === 'message' && event.role === 'user' ? [event.origin] : [],
    );
    assert.deepEqual(userOrigins, ['runtime', 'runtime', 'human']);
    const [segment] = segmentTraceBySkill(session);
    assert.equal(segment.metrics.numTurns, 1);
    assert.deepEqual(segment.turns.map((turn) => turn.role), ['user', 'assistant']);
  });

  it('recognizes Codex system skills from the installed .system layout', () => {
    const path = writeSession(fixture.directory, 'codex-system-skill.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-system-skill', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'read-system-skill',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'sed -n \'1,220p\' /home/user/.codex/skills/.system/skill-creator/SKILL.md',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'read-system-skill', output: '# Skill Creator' },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'run-system-skill',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: 'node /home/user/.codex/skills/.system/skill-creator/scripts/validate.js',
          }),
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'run-system-skill', output: 'valid' },
      },
    ]);

    const [session] = loadTraceSessions(path);
    const segments = segmentTraceBySkill(session);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].skillName, 'skill-creator');
    assert.equal(segments[0].toolCalls.length, 2);
  });

  it('keeps sample ids unique across a root run and child run', () => {
    const main = loadClaudeTraceFixture([
      asstRec('a-main', [{ type: 'text', text: 'main' }]),
    ], 'root');
    const child = {
      ...loadClaudeTraceFixture([asstRec('a-child', [{ type: 'text', text: 'child' }])], 'child'),
      rootRunId: 'root',
    };
    const entries = segmentsToAnalysisEntries([
      ...segmentTraceBySkill(main),
      ...segmentTraceBySkill(child),
    ]);
    assert.equal(new Set(entries.map((entry) => entry.sampleId)).size, 2);
  });

  it('keeps record ranges local to each physical trace in grouped timelines', () => {
    writeSession(fixture.directory, 'main.jsonl', [
      {
        timestamp: '2026-07-25T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'root-run', cwd: '/repo', model_provider: 'openai' },
      },
      {
        timestamp: '2026-07-25T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: '<command-name>/audit</command-name>\n检查主线。',
        },
      },
      {
        timestamp: '2026-07-25T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '主线完成。' },
      },
    ]);
    writeSession(fixture.directory, 'child.jsonl', [
      {
        timestamp: '2026-07-25T00:00:02.000Z',
        type: 'session_meta',
        payload: {
          id: 'child-run',
          parent_thread_id: 'root-run',
          thread_source: 'subagent',
          source: { subagent: 'review' },
          cwd: '/repo',
          model_provider: 'openai',
        },
      },
      {
        timestamp: '2026-07-25T00:00:02.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: '<command-name>/audit</command-name>\n检查子链路。',
        },
      },
      {
        timestamp: '2026-07-25T00:00:03.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: '子链路完成。' },
      },
    ]);

    const sessions = loadTraceSessions(fixture.directory);
    const segments = sessions.flatMap((session) => segmentTraceBySkill(session));
    const report = buildObservationExperienceReport({
      sessions,
      segments,
      items: [],
      generatedAt: '2026-07-25T00:05:00.000Z',
    });

    assert.equal(report.sessions.length, 1);
    const scope = report.sessions[0].timelineScope;
    assert.equal(scope.segmentRecordRanges.length, 2);
    assert.equal(scope.sessionRecordRanges.length, 2);
    assert.deepEqual(
      scope.sessionRecordRanges.map((range) => [range.traceId, range.startRecordIndex, range.endRecordIndex]),
      sessions
        .map((session) => [session.traceId, 0, 2] as const)
        .sort((a, b) => a[0].localeCompare(b[0])),
    );
    assert.equal(
      scope.segmentEventCount,
      new Set(report.invocations.flatMap((invocation) => invocation.timelineEventIds ?? [])).size,
    );
    assert.equal(scope.omittedBeforeCount, 0);
    assert.equal(scope.omittedAfterCount, 0);
    const dispatch = report.sessions[0].sessionStory?.subagentDispatches[0];
    assert.ok(dispatch);
    assert.equal(dispatch.childSessionId, 'child-run');
    assert.equal(dispatch.traceId, sessions.find((session) => session.runId === 'child-run')?.traceId);
    const childEdges = report.sessions[0].sessionStory?.episodes
      ?.flatMap((episode) => episode.orchestrationEdges)
      .filter((edge) => edge.childSessionId === 'child-run');
    assert.equal(childEdges?.length, 1);
    assert.equal(childEdges?.[0].edgeKind, 'external_child_session');
    const auditSegment = report.sessions[0].sessionStory?.episodes
      ?.flatMap((episode) => episode.skillSegments)
      .find((segment) => segment.skillName === 'audit');
    assert.ok(auditSegment);
    assert.equal(childEdges?.[0].parentSkillSegmentId, auditSegment.id);
    assert.equal(childEdges?.[0].executorSkillSegmentId, undefined);
    assert.ok(normalizeObservationExperienceReport(
      compactObservationExperienceReport(report),
    ));
  });

  it('uses the full invocation timeline for metrics beyond the 240-event preview', () => {
    const records: unknown[] = [{
      timestamp: '2026-07-25T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-long', cwd: '/repo', model_provider: 'openai' },
    }, {
      timestamp: '2026-07-25T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: '<command-name>/audit</command-name>\n<command-message>audit</command-message>\n请检查实现。',
      },
    }];
    for (let index = 0; index < 250; index += 1) {
      records.push({
        timestamp: `2026-07-25T00:${String(Math.floor((index + 2) / 60)).padStart(2, '0')}:${String((index + 2) % 60).padStart(2, '0')}.000Z`,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: `进度 ${index}` },
      });
    }
    records.push({
      timestamp: '2026-07-25T00:05:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: '不对，请重新检查最后的结论。' },
    });
    records.push({
      timestamp: '2026-07-25T00:05:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: '已修正并交付。' },
    });
    const path = writeSession(fixture.directory, 'codex-long.jsonl', records);
    const [session] = loadTraceSessions(path);
    const segments = segmentTraceBySkill(session);
    const experience = buildObservationExperienceReport({
      sessions: [session],
      segments,
      items: [],
      generatedAt: '2026-07-25T00:06:00.000Z',
    });
    const invocation = experience.invocations[0];
    assert.ok(invocation.timeline.length > 240);
    assert.equal(invocation.indicators.userMessageCount, 2);
    assert.ok(invocation.indicators.userCorrectionCount >= 1);

    const compact = compactObservationExperienceReport(experience);
    assert.equal(compact.schemaVersion, 4);
    assert.equal(compact.traceTimelines.length, 1);
    assert.equal(compact.storyContexts.length, 1);
    assert.equal(typeof compact.sessions[0].sourceSessionDurationMs, 'number');
    assert.equal('timeline' in compact.invocations[0], false);
    assert.equal('timelinePreview' in compact.sessions[0], false);
    assert.equal('fullSessionTimeline' in compact.sessions[0], false);
    assert.equal('timelineTree' in compact.sessions[0], false);
    assert.equal('goalSlices' in compact.sessions[0].sessionStory!, false);
    assert.equal('episodes' in compact.sessions[0].sessionStory!, false);
    assert.equal(compact.sessions[0].reviewerReport?.sessionStoryRef, 'session');
    assert.equal('sessionStory' in compact.sessions[0].reviewerReport!, false);
    const serialized = JSON.stringify(compact);
    assert.ok(serialized.length < JSON.stringify(experience).length);

    const hydrated = normalizeObservationExperienceReport(JSON.parse(serialized));
    assert.ok(hydrated);
    assert.deepEqual(
      hydrated.invocations[0].timeline.map((event) => event.id),
      invocation.timeline.map((event) => event.id),
    );
    assert.equal(
      hydrated.sessions[0].fullSessionTimeline.length,
      experience.sessions[0].fullSessionTimeline.length,
    );
    assert.equal(
      hydrated.sessions[0].sessionStory?.episodes?.length,
      experience.sessions[0].sessionStory?.episodes?.length,
    );
    assert.equal(
      hydrated.sessions[0].reviewerReport?.sessionStory,
      hydrated.sessions[0].sessionStory,
    );

    // normalizeObservationExperienceReport 的 fail-closed 校验覆盖五类代表性变异：
    // 结构缺失、悬空引用、数值不一致、非法时间戳、非法结构。
    // 完整逐字段遍历属内部校验实现细节,此处只保留各类代表,避免过度遍历。
    const mutations: ReadonlyArray<readonly [string, (draft: never) => void]> = [
      ['missing required section', (draft: { storyContexts?: unknown }) => {
        delete draft.storyContexts;
      }],
      ['dangling reference', (draft: { sessions: { invocationIds: string[] }[] }) => {
        draft.sessions[0].invocationIds = ['missing-invocation'];
      }],
      ['inconsistent numeric indicator', (draft: { sessions: { indicators: { toolUnknownCount: number } }[] }) => {
        draft.sessions[0].indicators.toolUnknownCount += 1;
      }],
      ['invalid timestamp', (draft: { generatedAt: string }) => {
        draft.generatedAt = 'not-a-timestamp';
      }],
      ['malformed structure', (draft: { traceTimelines: { tree: { branches: unknown } }[] }) => {
        draft.traceTimelines[0].tree.branches = [{ id: 'broken' }];
      }],
    ];
    for (const [name, mutate] of mutations) {
      const draft = JSON.parse(serialized);
      mutate(draft as never);
      assert.equal(normalizeObservationExperienceReport(draft), null, `expected null for ${name}`);
    }

    const additiveV3 = JSON.parse(serialized);
    for (const session of additiveV3.sessions) {
      delete session.threadId;
      delete session.sourceThreadId;
      delete session.turns;
    }
    const normalizedAdditiveV3 = normalizeObservationExperienceReport(additiveV3);
    assert.ok(normalizedAdditiveV3);
    assert.ok(normalizedAdditiveV3.sessions.every((session) => session.threadId.length > 0));
    assert.ok(normalizedAdditiveV3.sessions.every((session) => session.sourceThreadId.length > 0));
    assert.deepEqual(
      normalizedAdditiveV3.sessions.map((session) => session.turns.length),
      experience.sessions.map((session) => session.turns.length),
    );

    const legacy = JSON.parse(JSON.stringify(experience));
    legacy.schemaVersion = 2;
    delete legacy.traceTimelines;
    delete legacy.storyContexts;
    for (const goalSlice of legacy.goalSlices) {
      delete goalSlice.traceId;
      delete goalSlice.timestampObserved;
    }
    for (const legacyInvocation of legacy.invocations) {
      delete legacyInvocation.traceId;
      delete legacyInvocation.timestampObserved;
      delete legacyInvocation.timelineRef;
      delete legacyInvocation.timelineEventIds;
      delete legacyInvocation.metrics.numToolCancelled;
      delete legacyInvocation.metrics.numToolUnknown;
      delete legacyInvocation.indicators.toolCancelledCount;
      delete legacyInvocation.indicators.toolUnknownCount;
    }
    for (const legacySession of legacy.sessions) {
      const scope = legacySession.timelineScope;
      const firstRange = (ranges: Array<{ startRecordIndex: number }>) =>
        ranges.length > 0 ? ranges[0].startRecordIndex : undefined;
      const lastRange = (ranges: Array<{ endRecordIndex: number }>) =>
        ranges.length > 0 ? ranges[ranges.length - 1].endRecordIndex : undefined;
      legacySession.timelineScope = {
        mode: 'skill_segment_window',
        segmentStartRecordIndex: firstRange(scope.segmentRecordRanges),
        segmentEndRecordIndex: lastRange(scope.segmentRecordRanges),
        previewStartRecordIndex: firstRange(scope.previewRecordRanges),
        previewEndRecordIndex: lastRange(scope.previewRecordRanges),
        sessionStartRecordIndex: firstRange(scope.sessionRecordRanges) ?? 0,
        sessionEndRecordIndex: lastRange(scope.sessionRecordRanges) ?? 0,
        previewEventCount: scope.previewEventCount,
        fullSessionEventCount: scope.fullSessionEventCount,
        truncated: scope.truncated,
        omittedBeforeCount: scope.omittedBeforeCount,
        omittedAfterCount: scope.omittedAfterCount,
      };
      delete legacySession.timestampedInvocationCount;
      delete legacySession.timestampCoverage;
      delete legacySession.threadId;
      delete legacySession.sourceThreadId;
      delete legacySession.turns;
      delete legacySession.timelineRef;
      delete legacySession.timelinePreviewEventIds;
      delete legacySession.indicators.toolCancelledCount;
      delete legacySession.indicators.toolUnknownCount;
      if (legacySession.reviewerReport) {
        delete legacySession.reviewerReport.oneLookMetrics.toolCancelledCount;
        delete legacySession.reviewerReport.oneLookMetrics.toolUnknownCount;
      }
    }
    for (const legacySkill of legacy.skills) {
      delete legacySkill.timestampedInvocationCount;
      delete legacySkill.timestampCoverage;
      delete legacySkill.indicators.toolCancelledCount;
      delete legacySkill.indicators.toolUnknownCount;
    }
    assert.equal(normalizeObservationExperienceReport(legacy), null);
  });
});
