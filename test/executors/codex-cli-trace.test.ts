import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { extractCodexTrace } from '../../src/executors/codex-cli-trace.js';
import type { CodexEvent } from '../../src/executors/shared.js';

// Fixture-based 单测,锁住 codex 0.125 事件 schema 假设。
// schema 漂移时这些 test 会先红,提醒更新 parser。

describe('extractCodexTrace', () => {
  it('空事件流返回 0 turn / 0 toolCall', () => {
    const r = extractCodexTrace([]);
    assert.equal(r.turns.length, 0);
    assert.equal(r.toolCalls.length, 0);
    assert.equal(r.fullNumTurns, 0);
    assert.equal(r.numSubAgents, 0);
  });

  it('单 turn 含 assistant_message → 1 turn 1 fullNumTurns', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started', ts: 1000 },
      { type: 'item.assistant_message', payload: { text: 'Hello world' } },
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

  it('item.command_execution → ToolCallInfo with input/output/success', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started', ts: 1000 },
      {
        type: 'item.command_execution',
        payload: { command: 'ls /tmp', exit_code: 0, stdout: 'file1\nfile2', stderr: '' },
        exit_code: 0,
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

  it('item.command_execution 含 stderr + exit_code != 0 → success=false', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.command_execution',
        payload: { command: 'cat missing.txt', exit_code: 1, stderr: 'No such file' },
        exit_code: 1,
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls[0].success, false);
    assert.match(r.toolCalls[0].output as string, /\[stderr\] No such file/);
  });

  it('item.file_read → tool=file_read, input=path', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.file_read',
        payload: { path: '/tmp/foo.ts', content: 'export const x = 1;' },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls[0].tool, 'file_read');
    assert.equal(r.toolCalls[0].input, '/tmp/foo.ts');
    assert.equal(r.toolCalls[0].output, 'export const x = 1;');
    assert.equal(r.toolCalls[0].success, true);
  });

  it('item.web_search → tool=web_search, input=query', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      {
        type: 'item.web_search',
        payload: { query: 'omk evaluation', results: [{ title: 'A' }, { title: 'B' }] },
      },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.toolCalls[0].tool, 'web_search');
    assert.equal(r.toolCalls[0].input, 'omk evaluation');
    assert.match(r.toolCalls[0].output as string, /title/);
  });

  it('turn.failed → 末尾 ToolCallInfo success=false,turn 仍 flush', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.assistant_message', payload: { text: 'partial' } },
      {
        type: 'item.command_execution',
        payload: { command: 'risky', exit_code: 0, stdout: 'ok' },
        exit_code: 0,
      },
      { type: 'turn.failed', error: { message: 'rate limited' } },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    // turn.failed 把最后一条 tool call 标 false
    assert.equal(r.toolCalls[0].success, false);
    // turn.failed 不算 fullNumTurns?当前实现:仍 flush + 计入 fullNumTurns(因为有 content)
    assert.equal(r.fullNumTurns, 1);
  });

  it('多 turn 流(turn.started → ... → turn.completed × 2)', () => {
    const events: CodexEvent[] = [
      { type: 'thread.started', ts: 100 },
      { type: 'turn.started', ts: 200 },
      { type: 'item.assistant_message', payload: { text: 'first' } },
      { type: 'turn.completed', ts: 500 },
      { type: 'turn.started', ts: 600 },
      { type: 'item.command_execution', payload: { command: 'ls', exit_code: 0, stdout: '' } },
      { type: 'item.assistant_message', payload: { text: 'second' } },
      { type: 'turn.completed', ts: 1000 },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 2);
    assert.equal(r.fullNumTurns, 2);
    assert.equal(r.turns[0].content, 'first');
    assert.equal(r.turns[1].content, 'second');
    assert.equal(r.toolCalls.length, 1);
  });

  it('字段缺失静默 skip:无 payload / 无 type / 无 item_type 不爆栈', () => {
    const events: CodexEvent[] = [
      {} as CodexEvent,
      { type: 'turn.started' },
      { type: 'item.unknown_thing' }, // payload missing
      { type: 'item.assistant_message' }, // text missing
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    // 不应 throw,即便事件残缺
    assert.equal(r.turns.length, 1);
    // assistant_message 无 text → currentTurnText='' → fullNumTurns 不增
    // unknown item 当 tool call → currentTurnHasContent=true → fullNumTurns=1
    assert.equal(r.fullNumTurns, 1);
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0].tool, 'unknown_thing');
  });

  it('numSubAgents 恒 0(codex 无 sub-agent 概念)', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.assistant_message', payload: { text: 'spawning agent' } },
      { type: 'turn.completed' },
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.numSubAgents, 0);
  });

  it('流末尾无 turn.completed 收尾也 flush(防 hang turn)', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.assistant_message', payload: { text: 'truncated' } },
      // 故意没 turn.completed
    ];
    const r = extractCodexTrace(events);
    assert.equal(r.turns.length, 1);
    assert.equal(r.turns[0].content, 'truncated');
  });
});
