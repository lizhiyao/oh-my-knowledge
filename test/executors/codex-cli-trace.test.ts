import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractCodexTrace } from '../../src/executors/codex/cli-trace.js';
import type { CodexEvent } from '../../src/executors/codex/protocol.js';

// Fixture 锁住 codex 0.125 实测 schema 假设。
// schema 漂移时这些 test 会先红,提醒更新 parser。
// 实测样本(2026-04 抓):
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}
//   {"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"...","aggregated_output":"...","exit_code":0,"status":"completed"}}
//   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":...,"cached_input_tokens":...,"output_tokens":...}}

describe('extractCodexTrace', () => {
  it('空事件流返回 0 turn / 0 toolCall', () => {
    const r = extractCodexTrace([]);
    assert.equal(r.turns.length, 0);
    assert.equal(r.toolCalls.length, 0);
    assert.equal(r.fullNumTurns, 0);
    assert.equal(r.numSubAgents, 0);
  });

  it('单 turn agent_message → 1 turn 1 fullNumTurns', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started', ts: 1000 },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Hello world' } },
      { type: 'turn.completed', ts: 1500, usage: { input_tokens: 10, output_tokens: 5 } },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    assert.equal(r.turns[0].role, 'assistant');
    assert.equal(r.turns[0].content, 'Hello world');
    assert.equal(r.turns[0].durationMs, 500);
    assert.equal(r.fullNumTurns, 1);
    assert.equal(r.toolCalls.length, 0);
  });

  it('command_execution → ToolCallInfo with input/output/success', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started', ts: 1000 },
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'ls /tmp',
          aggregated_output: 'file1\nfile2\n',
          exit_code: 0,
          status: 'completed',
        },
      },
      { type: 'turn.completed', ts: 2000 },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].tool, 'Bash');
    assert.equal(r.toolCalls[0].sourceTool, 'command_execution');
    assert.deepEqual(r.toolCalls[0].input, { command: 'ls /tmp' });
    assert.match(r.toolCalls[0].output as string, /file1/);
    assert.equal(r.toolCalls[0].success, true);
    assert.equal(r.toolCalls[0].status, 'success');
    assert.equal(r.toolCalls[0].statusSource, 'runtime');
    // turn 也应该挂上这个 tool call
    assert.equal(r.turns[0].toolCalls?.length, 1);
  });

  it('command_execution exit_code != 0 → success=false', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: {
          id: 'x',
          type: 'command_execution',
          command: 'cat missing.txt',
          aggregated_output: 'cat: missing.txt: No such file',
          exit_code: 1,
          status: 'completed',
        },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].success, false);
    assert.equal(r.toolCalls[0].status, 'failure');
    assert.match(r.toolCalls[0].output as string, /No such file/);
  });

  it('item.status failed/cancelled overrides item.completed lifecycle', () => {
    const failed = extractCodexTrace([{
      type: 'item.completed',
      item: { id: 'failed', type: 'web_search', query: 'x', status: 'failed' },
    }]);
    assert.equal(failed.toolCalls[0].status, 'failure');
    assert.equal(failed.toolCalls[0].success, false);

    const cancelled = extractCodexTrace([{
      type: 'item.completed',
      item: { id: 'cancelled', type: 'web_search', query: 'x', status: 'cancelled' },
    }]);
    assert.equal(cancelled.toolCalls[0].status, 'cancelled');
    assert.equal(cancelled.toolCalls[0].success, false);
  });

  it('does not fabricate success when a terminal event still has a non-terminal status', () => {
    const trace = extractCodexTrace([{
      type: 'item.completed',
      item: {
        id: 'still-running',
        type: 'mcp_tool_call',
        server: 'github',
        tool: 'fetch_file',
        status: 'in_progress',
      },
    }]);
    assert.equal(trace.toolCalls[0].status, 'unknown');
    assert.equal(trace.toolCalls[0].success, false);

    const conflictingExitCode = extractCodexTrace([{
      type: 'item.completed',
      item: {
        id: 'still-running-with-exit',
        type: 'command_execution',
        command: 'long task',
        status: 'in_progress',
        exit_code: 0,
      },
    }]);
    assert.equal(conflictingExitCode.toolCalls[0].status, 'unknown');
  });

  it('does not count protocol-only items as tools and preserves MCP arguments and results', () => {
    const errorTrace = extractCodexTrace([{
      type: 'item.completed',
      item: { id: 'error', type: 'error', message: 'permission denied' },
    }]);
    const protocolOnlyTrace = extractCodexTrace([
      { type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { id: 'todo', type: 'todo_list' } },
    ]);
    assert.equal(errorTrace.toolCalls.length, 0);
    assert.equal(protocolOnlyTrace.toolCalls.length, 0);

    const mcpTrace = extractCodexTrace([{
      type: 'item.completed',
      item: {
        id: 'mcp',
        type: 'mcp_tool_call',
        server: 'github',
        tool: 'fetch_file',
        arguments: { path: 'README.md' },
        result: { structured_content: { text: 'ok' } },
        status: 'completed',
      },
    }]);
    assert.deepEqual(mcpTrace.toolCalls[0].input, { path: 'README.md' });
    assert.match(String(mcpTrace.toolCalls[0].output), /structured_content/);
    assert.equal(mcpTrace.toolCalls[0].tool, 'github.fetch_file');
    assert.equal(mcpTrace.toolCalls[0].sourceTool, 'mcp_tool_call');
    assert.equal(mcpTrace.toolCalls[0].toolProvider, 'github');
    assert.equal(mcpTrace.toolCalls[0].status, 'success');
  });

  it('preserves file_change paths and change kinds as source-neutral tool input', () => {
    const trace = extractCodexTrace([{
      type: 'item.completed',
      item: {
        id: 'patch',
        type: 'file_change',
        changes: [
          { path: 'src/a.ts', changeKind: 'update' },
          { path: 'src/b.ts', changeKind: 'add' },
        ],
        status: 'completed',
      },
    }]);

    assert.deepEqual(trace.toolCalls[0].input, [
      { path: 'src/a.ts', kind: 'update' },
      { path: 'src/b.ts', kind: 'add' },
    ]);
    assert.equal(trace.toolCalls[0].tool, 'Edit');
    assert.equal(trace.toolCalls[0].sourceTool, 'file_change');
    assert.equal(trace.toolCalls[0].output, 'completed');
    assert.equal(trace.toolCalls[0].status, 'success');
  });

  it('item.started is replaced by item.completed without double-counting', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'item_1', type: 'command_execution', command: 'ls', status: 'in_progress' },
      },
      {
        type: 'item.completed',
        item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: 'a\n', exit_code: 0, status: 'completed' },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].status, 'success');
  });

  it('merges sparse completed items with their started input', () => {
    const r = extractCodexTrace([
      {
        type: 'item.started',
        item: { id: 'sparse', type: 'command_execution', command: 'pwd', status: 'in_progress' },
      },
      {
        type: 'item.completed',
        item: { id: 'sparse', type: 'command_execution', aggregated_output: '/repo', exit_code: 0, status: 'completed' },
      },
    ]);
    assert.deepEqual(r.toolCalls[0].input, { command: 'pwd' });
    assert.equal(r.toolCalls[0].output, '/repo');
    assert.equal(r.toolCalls[0].toolUseId, 'sparse');
    assert.equal(r.toolCalls[0].status, 'success');
  });

  it('retains an updated-only item as unknown evidence when the stream is truncated', () => {
    const trace = extractCodexTrace([{
      type: 'item.updated',
      item: {
        id: 'updated-only',
        type: 'command_execution',
        command: 'long task',
        aggregated_output: 'partial',
        status: 'in_progress',
      },
    }]);
    assert.equal(trace.toolCalls.length, 1);
    assert.deepEqual(trace.toolCalls[0].input, { command: 'long task' });
    assert.equal(trace.toolCalls[0].output, 'partial');
    assert.equal(trace.toolCalls[0].status, 'unknown');
  });

  it('pairs reused item ids in FIFO order', () => {
    const r = extractCodexTrace([
      {
        type: 'item.started',
        item: { id: 'reused', type: 'command_execution', command: 'first', status: 'in_progress' },
      },
      {
        type: 'item.started',
        item: { id: 'reused', type: 'command_execution', command: 'second', status: 'in_progress' },
      },
      {
        type: 'item.completed',
        item: { id: 'reused', type: 'command_execution', aggregated_output: 'first output', exit_code: 0, status: 'completed' },
      },
      {
        type: 'item.completed',
        item: { id: 'reused', type: 'command_execution', aggregated_output: 'second output', exit_code: 1, status: 'failed' },
      },
    ]);
    assert.deepEqual(
      r.toolCalls.map((call) => [
        (call.input as { command: string }).command,
        call.output,
        call.status,
      ]),
      [
        ['first', 'first output', 'success'],
        ['second', 'second output', 'failure'],
      ],
    );
    assert.equal(new Set(r.toolCalls.map((call) => call.callInstanceId)).size, 2);
  });

  it('keeps started tools with no terminal item as unknown evidence', () => {
    const failedTurn = extractCodexTrace([
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'pending-failed-turn', type: 'command_execution', command: 'long task', status: 'in_progress' },
      },
      { type: 'turn.failed', error: { message: 'connection lost' } },
    ]);
    assert.equal(failedTurn.toolCalls.length, 1);
    assert.equal(failedTurn.toolCalls[0].status, 'unknown');
    assert.equal(failedTurn.toolCalls[0].statusSource, 'unknown');
    assert.equal(failedTurn.toolCalls[0].success, false);

    const truncatedStream = extractCodexTrace([
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'pending-truncated', type: 'web_search', query: 'omk', status: 'in_progress' },
      },
    ]);
    assert.equal(truncatedStream.toolCalls.length, 1);
    assert.equal(truncatedStream.toolCalls[0].status, 'unknown');
  });

  it('混合 command_execution + agent_message 同 turn → tool 挂当前 turn,内容是文本', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'i1', type: 'command_execution', command: 'pwd', aggregated_output: '/tmp\n', exit_code: 0, status: 'completed' },
      },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'cwd is /tmp' } },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    assert.equal(r.turns[0].content, 'cwd is /tmp');
    assert.equal(r.turns[0].toolCalls?.length, 1);
    assert.equal(r.toolCalls.length, 1);
  });

  it('多个 agent_message 同 turn → 文本拼接,fullNumTurns 仍是 1', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'first part' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'second part' } },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    assert.equal(r.turns[0].content, 'first part\nsecond part');
    assert.equal(r.fullNumTurns, 1);
  });

  it('turn.failed does not overwrite a completed tool outcome', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'partial' } },
      {
        type: 'item.completed',
        item: { id: 'i2', type: 'command_execution', command: 'risky', aggregated_output: 'ok', exit_code: 0, status: 'completed' },
      },
      { type: 'turn.failed', error: { message: 'rate limited' } },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    assert.equal(r.toolCalls[0].success, true);
    assert.equal(r.toolCalls[0].status, 'success');
    assert.equal(r.fullNumTurns, 1);
  });

  it('多 turn 流(turn.started → ... → turn.completed × 2)', () => {
    const events: CodexEvent[] = [
      { type: 'thread.started', ts: 100 },
      { type: 'turn.started', ts: 200 },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'first' } },
      { type: 'turn.completed', ts: 500 },
      { type: 'turn.started', ts: 600 },
      {
        type: 'item.completed',
        item: { id: 'i2', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' },
      },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'second' } },
      { type: 'turn.completed', ts: 1000 },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 2);
    assert.equal(r.fullNumTurns, 2);
    assert.equal(r.turns[0].content, 'first');
    assert.equal(r.turns[1].content, 'second');
    assert.equal(r.toolCalls.length, 1);
  });

  it('字段缺失静默 skip:无 item / 无 type / 无 text 不爆栈', () => {
    const events: CodexEvent[] = [
      {} as CodexEvent,
      { type: 'turn.started' },
      { type: 'item.completed' },                                        // 无 item
      { type: 'item.completed', item: { id: 'x' } },                     // 无 item.type
      { type: 'item.completed', item: { id: 'y', type: 'agent_message' } }, // 无 text
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    // 不应 throw,即便事件残缺
    assert.equal(r.turns.length, 0);  // 只有空 agent_message,没产生有效 content
    assert.equal(r.toolCalls.length, 0);
  });

  it('counts concrete agent spawn items without inferring from assistant prose', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'spawning agent' } },
      {
        type: 'item.started',
        item: {
          id: 'spawn-1',
          type: 'mcp_tool_call',
          server: 'multi_agent_v1',
          tool: 'spawn_agent',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'spawn-1',
          type: 'mcp_tool_call',
          server: 'multi_agent_v1',
          tool: 'spawn_agent',
          status: 'completed',
        },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.numSubAgents, 1);
    assert.equal(r.toolCalls.length, 1);
  });

  it('流末尾无 turn.completed 收尾也 flush(防 hang turn)', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'truncated' } },
      // 故意没 turn.completed
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    assert.equal(r.turns[0].content, 'truncated');
  });

  it('file_read 走 path 当 input,content 当 output', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'x', type: 'file_read', path: '/etc/hosts', content: '127.0.0.1 localhost' },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].tool, 'Read');
    assert.equal(r.toolCalls[0].sourceTool, 'file_read');
    assert.deepEqual(r.toolCalls[0].input, { file_path: '/etc/hosts' });
    assert.match(r.toolCalls[0].output as string, /localhost/);
  });

  it('web_search 走 query 当 input,results 当 output', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'x', type: 'web_search', query: 'what is omk', results: [{ title: 't1' }] },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls.length, 1);
    assert.deepEqual(r.toolCalls[0].input, { query: 'what is omk' });
    assert.match(r.toolCalls[0].output as string, /t1/);
  });

  // multi-turn elapsed_ms 累加(bug_014):codex events 的 elapsed_ms 是 per-turn delta,
  // 跟 extractCodexUsage 累加 token 同语义。fixture 里多 turn.completed 各带 elapsed_ms,
  // 这里只测 trace 不出错,duration sum 走 sumCodexElapsed(executor 内部,sum 在 codex-cli.ts)。
  it('multi-turn 流跨多 turn.completed 各自带 elapsed_ms 不爆栈', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started', ts: 0 },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 't1' } },
      { type: 'turn.completed', ts: 2000, elapsed_ms: 2000 },
      { type: 'turn.started', ts: 2100 },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 't2' } },
      { type: 'turn.completed', ts: 5500, elapsed_ms: 3500 },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 2);
    assert.equal(r.fullNumTurns, 2);
  });
});
