import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractCodexTrace } from '../../src/executors/codex-cli-trace.js';
import type { CodexEvent } from '../../src/executors/shared.js';

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
    assert.equal(r.toolCalls[0].tool, 'command_execution');
    assert.equal(r.toolCalls[0].input, 'ls /tmp');
    assert.match(r.toolCalls[0].output as string, /file1/);
    assert.equal(r.toolCalls[0].success, true);
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
    assert.match(r.toolCalls[0].output as string, /No such file/);
  });

  it('item.started 是 in_progress 占位,跳过避免 double-count', () => {
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

  it('turn.failed 把最后一条 tool call 标 success=false', () => {
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
    assert.equal(r.toolCalls[0].success, false);
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

  it('numSubAgents 恒 0(codex 无 sub-agent 概念)', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'spawning agent' } },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.numSubAgents, 0);
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
    assert.equal(r.toolCalls[0].tool, 'file_read');
    assert.equal(r.toolCalls[0].input, '/etc/hosts');
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
    assert.equal(r.toolCalls[0].input, 'what is omk');
    assert.match(r.toolCalls[0].output as string, /t1/);
  });
});
