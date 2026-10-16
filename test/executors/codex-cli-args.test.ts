import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  buildCodexArgs,
  extractCodexFinalOutput,
  extractCodexProtocolError,
  extractCodexUsage,
  parseCodexJsonl,
  sumCodexElapsed,
} from '../../src/executors/openai/codex/cli.js';
import type { CodexEvent } from '../../src/executors/openai/codex/protocol.js';

// Args shape 回归测:codex CLI 0.125 起去掉 `--ask-for-approval` flag。
// 我们曾经用过这个 flag,会让 preflight 直接挂(unexpected argument)。
// 改用 -c approval_policy="never" config override 后,锁住别再退回去。

describe('buildCodexArgs flag schema', () => {
  it('preserves auxiliary isolation, explicit effort, cwd and a dash-leading prompt without enabling Trial policy', () => {
    const prompt = '---\nname: skill\n---\n正文';
    assert.deepEqual(buildCodexArgs({ model: 'm', cwd: '/tmp/a b', prompt, effort: 'high', outputSchemaPath: '/tmp/private schema/output.json' }), [
      'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="high"',
      '--model', 'm', '-C', '/tmp/a b', '--output-schema', '/tmp/private schema/output.json', '--', prompt,
    ]);
    for (const cwd of [null, undefined, '']) {
      assert.deepEqual(buildCodexArgs({ model: '', cwd, prompt: '' }), [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only',
        '-c', 'approval_policy="never"', '--', '',
      ]);
    }
  });
});

describe('parseCodexJsonl completeness', () => {
  it('reports malformed protocol lines instead of silently dropping them', () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: 'turn.started' }),
      'not-json',
      'null',
      '[]',
      '{}',
      JSON.stringify({ type: 'item.completed', item: { id: 'missing-type' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n'));
    assert.deepEqual(parsed.events.map((event) => event.type), [
      'turn.started',
      'turn.completed',
    ]);
    assert.equal(parsed.malformedLineCount, 5);
  });

  it('qualifies external file-change kinds at the protocol boundary', () => {
    const parsed = parseCodexJsonl(JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'patch',
        type: 'file_change',
        changes: [{ path: 'src/a.ts', kind: 'update' }],
      },
    }));

    assert.deepEqual(parsed.events[0]?.item?.changes, [
      { path: 'src/a.ts', changeKind: 'update' },
    ]);
  });

  it('preserves top-level protocol errors as execution failures', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'error', message: 'stream disconnected' },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexProtocolError(events), 'stream disconnected');
  });
});

describe('extractCodexFinalOutput', () => {
  it('uses the latest completed agent message, matching the official SDK finalResponse', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'first part' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'second part' } },
      { type: 'item.completed', item: { id: 'c', type: 'agent_message', text: 'final answer: yes' } },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexFinalOutput(events), 'final answer: yes');
  });

  it('skip agent_message with empty text', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'real content' } },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexFinalOutput(events), 'real content');
  });

  it('skip non-agent_message items', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'a', type: 'command_execution', command: 'ls', aggregated_output: 'x' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'response' } },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexFinalOutput(events), 'response');
  });

  it('skip item.started (in-progress placeholder)', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'a', type: 'agent_message', text: 'partial...' } },
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'final' } },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexFinalOutput(events), 'final');
  });

  it('no agent_message → empty string', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexFinalOutput(events), '');
  });

  it('does not fall back to an earlier answer when the final message is empty', () => {
    const events: CodexEvent[] = [
      { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'stale answer' } },
      { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: '' } },
      { type: 'turn.completed' },
    ];
    assert.equal(extractCodexFinalOutput(events), '');
  });
});

describe('extractCodexUsage token buckets', () => {
  it('does not count cached input in both input and cache buckets', () => {
    const usage = extractCodexUsage([
      {
        type: 'turn.completed',
        usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 15 },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 80, cached_input_tokens: 20, output_tokens: 10 },
      },
    ]);
    assert.deepEqual(usage, { input: 140, cached: 60, output: 25 });
  });

  it('does not let malformed counters create negative or inflated totals', () => {
    const usage = extractCodexUsage([
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 40, output_tokens: -5 },
      },
    ]);
    assert.deepEqual(usage, { input: 0, cached: 10, output: 0 });
  });
});

// bug_014:durationMs 在 multi-turn 必须累加每个 turn.completed 的 elapsed_ms,
// 跟 extractCodexUsage 累加 token 同语义。只取 last.elapsed_ms 会漏算前 N-1 turn。
describe('sumCodexElapsed multi-turn aggregation', () => {
  it('sums elapsed_ms across all result events', () => {
    const events: CodexEvent[] = [
      { type: 'turn.completed', elapsed_ms: 2000 },
      { type: 'turn.completed', elapsed_ms: 3500 },
      { type: 'turn.completed', elapsed_ms: 1500 },
    ];
    assert.equal(sumCodexElapsed(events, 8000), 7000);
  });

  it('全部 elapsed_ms === 0 → fallback wall-clock', () => {
    const events: CodexEvent[] = [
      { type: 'turn.completed', elapsed_ms: 0 },
    ];
    assert.equal(sumCodexElapsed(events, 5000), 5000);
  });

  it('全部 elapsed_ms 缺失 → fallback wall-clock', () => {
    const events: CodexEvent[] = [
      { type: 'turn.completed' },
      { type: 'turn.completed' },
    ];
    assert.equal(sumCodexElapsed(events, 3000), 3000);
  });

  it('单 turn 的传统 case 仍 OK', () => {
    const events: CodexEvent[] = [
      { type: 'turn.completed', elapsed_ms: 1234 },
    ];
    assert.equal(sumCodexElapsed(events, 1500), 1234);
  });
});
