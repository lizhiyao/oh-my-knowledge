import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  buildClaudeResult,
  normalizeClaudeSdkMeasurements,
  parseClaudeStreamJson,
} from '../../src/executors/anthropic/protocol.js';
import type { ClaudeSdkResultMessage } from '../../src/executors/anthropic/protocol.js';

function result(overrides: Partial<ClaudeSdkResultMessage> = {}): ClaudeSdkResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    duration_ms: 100,
    duration_api_ms: 80,
    num_turns: 2,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 1,
    },
    ...overrides,
  };
}

describe('claude-sdk measurement protocol', () => {
  it('uses source-wide modelUsage without double-counting the fallback usage', () => {
    const normalized = normalizeClaudeSdkMeasurements(result({
      modelUsage: {
        sonnet: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 1,
        },
        haiku: {
          inputTokens: 4,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    }));

    assert.deepEqual(normalized, {
      durationMs: 100,
      durationApiMs: 80,
      inputTokens: 14,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
      costUSD: 0.01,
      numTurns: 2,
    });
  });

  it('rejects malformed or overflowing counters instead of reporting zero', () => {
    assert.match(
      (normalizeClaudeSdkMeasurements(result({
        usage: { input_tokens: 10, output_tokens: -1 },
      })) as { error: string }).error,
      /invalid token usage/,
    );
    assert.match(
      (normalizeClaudeSdkMeasurements(result({
        modelUsage: {
          one: {
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          two: {
            inputTokens: 1,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      })) as { error: string }).error,
      /aggregate exceeds safe integer/,
    );
  });

  it('shares strict terminal semantics across CLI and SDK transports', () => {
    const valid = result();
    const ok = buildClaudeResult({
      messages: [valid],
      wallClockDurationMs: 120,
      source: 'claude-sdk',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.output, 'done');
    assert.equal(ok.inputTokens, 10);

    const nonSuccess = buildClaudeResult({
      messages: [result({ subtype: 'error_max_turns', errors: [] })],
      wallClockDurationMs: 120,
      source: 'claude stream-json',
    });
    assert.equal(nonSuccess.ok, false);
    assert.match(nonSuccess.error ?? '', /error_max_turns/);

    const empty = buildClaudeResult({
      messages: [result({ result: '' })],
      wallClockDurationMs: 120,
      source: 'claude-sdk',
    });
    assert.equal(empty.ok, false);
    assert.match(empty.error ?? '', /without an assistant response/);

    const duplicate = buildClaudeResult({
      messages: [valid, valid],
      wallClockDurationMs: 120,
      source: 'claude-sdk',
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.error ?? '', /exactly one result message/);
  });

  it('does not discard malformed stream-json lines', () => {
    const parsed = parseClaudeStreamJson([
      JSON.stringify(result()),
      '{',
      '42',
    ].join('\n'));
    assert.equal(parsed.messages.length, 1);
    assert.equal(parsed.malformedLineCount, 2);

    const built = buildClaudeResult({
      messages: parsed.messages,
      malformedLineCount: parsed.malformedLineCount,
      wallClockDurationMs: 120,
      source: 'claude stream-json',
    });
    assert.equal(built.ok, false);
    assert.match(built.error ?? '', /2 malformed line/);
    assert.equal(built.output, 'done');
  });
});
