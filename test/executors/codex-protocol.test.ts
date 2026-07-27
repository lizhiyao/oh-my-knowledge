import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  buildCodexResult,
  extractCodexProtocolError,
  validateCodexProtocol,
} from '../../src/executors/codex-protocol.js';
import type { CodexEvent } from '../../src/executors/shared.js';

describe('Codex protocol normalization', () => {
  it('keeps an item-level error non-fatal when the turn still completes with an answer', () => {
    const events: CodexEvent[] = [
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'warning', type: 'error', message: 'search unavailable' } },
      { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'fallback answer' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } },
    ];

    assert.equal(extractCodexProtocolError(events), undefined);
    const result = buildCodexResult({
      events,
      wallClockDurationMs: 100,
      source: 'codex-sdk',
    });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'fallback answer');
  });

  it('fails closed when the runtime emits an unknown event or item schema', () => {
    assert.match(
      validateCodexProtocol([{ type: 'future.event' }]) ?? '',
      /unsupported codex event type/,
    );
    assert.match(
      validateCodexProtocol([{
        type: 'item.completed',
        item: { id: 'future', type: 'future_item' },
      }]) ?? '',
      /unsupported codex item type/,
    );
  });

  it('does not mark a completed turn without a final assistant response as successful', () => {
    const result = buildCodexResult({
      events: [
        { type: 'turn.started' },
        {
          type: 'item.completed',
          item: {
            id: 'command',
            type: 'command_execution',
            command: 'pwd',
            aggregated_output: '/tmp',
            exit_code: 0,
            status: 'completed',
          },
        },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } },
      ],
      wallClockDurationMs: 100,
      source: 'codex --json',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /without an assistant response/);
    assert.equal(result.toolCalls?.length, 1);
  });

  it('preserves partial trace and metrics while a process failure remains authoritative', () => {
    const result = buildCodexResult({
      events: [
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'partial' } },
        { type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 2 } },
      ],
      wallClockDurationMs: 100,
      source: 'codex --json',
      forcedError: 'process exited with code 2',
    });

    assert.equal(result.ok, false);
    assert.equal(result.output, 'partial');
    assert.equal(result.inputTokens, 8);
    assert.match(result.error ?? '', /exited with code 2/);
  });

  it('does not expose unsafe aggregated usage or elapsed counters', () => {
    const result = buildCodexResult({
      events: [
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } },
        {
          type: 'turn.completed',
          usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: Number.MAX_SAFE_INTEGER },
          elapsed_ms: Number.MAX_SAFE_INTEGER,
        },
        {
          type: 'turn.completed',
          usage: { input_tokens: 1, output_tokens: 1 },
          elapsed_ms: 1,
        },
      ],
      wallClockDurationMs: 100,
      source: 'codex-sdk',
    });

    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.durationMs, 100);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /aggregate exceeds safe integer/);
  });

  it('fails closed on malformed usage, unfinished turns, and incomplete items', () => {
    assert.match(
      validateCodexProtocol([
        { type: 'turn.started' },
        { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'done' } },
        { type: 'turn.completed', usage: { input_tokens: 10 } },
      ]) ?? '',
      /invalid codex usage/,
    );
    assert.match(
      validateCodexProtocol([{ type: 'turn.started' }]) ?? '',
      /before turn completion/,
    );
    assert.match(
      validateCodexProtocol([
        {
          type: 'item.started',
          item: { id: 'command', type: 'command_execution', command: 'pwd' },
        },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 1 } },
      ]) ?? '',
      /incomplete item/,
    );
    assert.match(
      validateCodexProtocol([
        { type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 6, output_tokens: 1 } },
      ]) ?? '',
      /cached_input_tokens exceeds input_tokens/,
    );
  });
});
