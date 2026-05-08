import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseToolColonValue,
  toolCallSignature,
  indexToolCallsByTurn,
  findAssertionTurn,
  sampleVerdict,
} from '../../src/renderer/test-view.js';
import type { Assertion } from '../../src/types/eval.js';
import type { ToolCallInfo, TurnInfo } from '../../src/types/executor.js';
import type { AssertionDetail } from '../../src/types/judge.js';

const tc = (tool: string, input: unknown, output: unknown = '', success = true): ToolCallInfo =>
  ({ tool, input, output, success });

describe('parseToolColonValue', () => {
  it('splits Tool:needle at first colon', () => {
    assert.deepEqual(parseToolColonValue('Bash:tag-list'), { tool: 'Bash', needle: 'tag-list' });
  });
  it('preserves colons in needle', () => {
    assert.deepEqual(parseToolColonValue('Bash:cmd:flag'), { tool: 'Bash', needle: 'cmd:flag' });
  });
  it('returns empty tool when no colon', () => {
    assert.deepEqual(parseToolColonValue('plain-text'), { tool: '', needle: 'plain-text' });
  });
});

describe('indexToolCallsByTurn', () => {
  it('maps each tool call signature to its 1-based turn number', () => {
    const turns: TurnInfo[] = [
      { role: 'assistant', content: 'thinking', toolCalls: [tc('Bash', 'echo a')] },
      { role: 'tool', content: '', toolCalls: [tc('Read', { file_path: '/x' })] },
      { role: 'assistant', content: '', toolCalls: [tc('Bash', 'echo b')] },
    ];
    const idx = indexToolCallsByTurn(turns);
    assert.equal(idx.get(toolCallSignature(tc('Bash', 'echo a'))), 1);
    assert.equal(idx.get(toolCallSignature(tc('Read', { file_path: '/x' }))), 2);
    assert.equal(idx.get(toolCallSignature(tc('Bash', 'echo b'))), 3);
  });

  it('returns empty map for undefined turns', () => {
    assert.equal(indexToolCallsByTurn(undefined).size, 0);
  });
});

describe('findAssertionTurn', () => {
  const detail = (passed: boolean, type: string, value: AssertionDetail['value'] = ''): AssertionDetail =>
    ({ type, value, passed, weight: 1 });

  it('binds tool_input_contains to first matching turn', () => {
    const assertion: Assertion = { type: 'tool_input_contains', value: 'Bash:tag-list' };
    const toolCalls = [
      tc('Bash', 'echo hi'),
      tc('Bash', 'tag-list --workspace W001'),
      tc('Bash', 'tag-list --project P001'),
    ];
    const turns: TurnInfo[] = [
      { role: 'assistant', content: '', toolCalls: [toolCalls[0]] },
      { role: 'assistant', content: '', toolCalls: [toolCalls[1]] },
      { role: 'assistant', content: '', toolCalls: [toolCalls[2]] },
    ];
    const turnByCallSig = indexToolCallsByTurn(turns);
    const result = findAssertionTurn(assertion, detail(true, 'tool_input_contains', 'Bash:tag-list'), toolCalls, turnByCallSig);
    assert.equal(result.turn, 2, '"tag-list" first appears in turn 2');
  });

  it('binds tools_not_called to violation turn when violated', () => {
    const assertion: Assertion = { type: 'tools_not_called', values: ['cliclick'] };
    const toolCalls = [
      tc('Bash', 'navigator.py'),
      tc('cliclick', { x: 200, y: 400 }),
    ];
    const turns: TurnInfo[] = [
      { role: 'assistant', content: '', toolCalls: [toolCalls[0]] },
      { role: 'assistant', content: '', toolCalls: [toolCalls[1]] },
    ];
    const result = findAssertionTurn(assertion, detail(false, 'tools_not_called'), toolCalls, indexToolCallsByTurn(turns));
    assert.equal(result.turn, 2, 'violation in turn 2');
  });

  it('returns null turn for tools_not_called when never called (assertion passes)', () => {
    const assertion: Assertion = { type: 'tools_not_called', values: ['cliclick'] };
    const toolCalls = [tc('Bash', 'navigator.py')];
    const turns: TurnInfo[] = [{ role: 'assistant', content: '', toolCalls }];
    const result = findAssertionTurn(assertion, detail(true, 'tools_not_called'), toolCalls, indexToolCallsByTurn(turns));
    assert.equal(result.turn, null, 'never triggered → no turn binding');
  });

  it('binds mock_hit "Bash:2" to the 2nd Bash call', () => {
    const assertion: Assertion = { type: 'mock_hit', value: 'Bash:2' };
    const toolCalls = [
      tc('Bash', 'sim-lock acquire'),
      tc('Read', { file_path: '/etc/x' }),
      tc('Bash', 'app_launcher.py'),  // ← 2nd Bash → mock #2
      tc('Bash', 'navigator.py'),
    ];
    const turns: TurnInfo[] = toolCalls.map((c) => ({ role: 'assistant' as const, content: '', toolCalls: [c] }));
    const result = findAssertionTurn(assertion, detail(true, 'mock_hit', 'Bash:2'), toolCalls, indexToolCallsByTurn(turns));
    assert.equal(result.turn, 3, '2nd Bash call is in turn 3');
  });

  it('returns null for content-level assertions (contains / regex)', () => {
    const a1: Assertion = { type: 'contains', value: 'success' };
    const a2: Assertion = { type: 'regex', pattern: '^OK' };
    const toolCalls = [tc('Bash', 'x')];
    const turns: TurnInfo[] = [{ role: 'assistant', content: '', toolCalls }];
    const idx = indexToolCallsByTurn(turns);
    assert.equal(findAssertionTurn(a1, detail(true, 'contains', 'success'), toolCalls, idx).turn, null);
    assert.equal(findAssertionTurn(a2, detail(true, 'regex', '^OK'), toolCalls, idx).turn, null);
  });
});

describe('sampleVerdict', () => {
  it('returns pass when all assertions passed', () => {
    assert.equal(sampleVerdict([
      { type: 't1', value: '', weight: 1, passed: true },
      { type: 't2', value: '', weight: 1, passed: true },
    ]), 'pass');
  });
  it('returns fail when any assertion failed', () => {
    assert.equal(sampleVerdict([
      { type: 't1', value: '', weight: 1, passed: true },
      { type: 't2', value: '', weight: 1, passed: false },
    ]), 'fail');
  });
  it('returns pass for empty / undefined details (defensive)', () => {
    assert.equal(sampleVerdict([]), 'pass');
    assert.equal(sampleVerdict(undefined), 'pass');
  });
});
