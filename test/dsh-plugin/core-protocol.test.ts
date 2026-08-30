import { describe, expect, it } from 'vitest';
import { parseDshHostCoreResult } from '../../src/dsh-plugin/core-protocol.js';
import type { DshHostRunResult } from '../../src/dsh-plugin/protocol.js';

type UnknownRecord = Record<string, unknown>;

function run(events: readonly UnknownRecord[]): DshHostRunResult {
  return {
    rootSessionId: 'root',
    finalResponse: 'answer',
    childSessionIds: [],
    events: events.map((event) => ({ sessionId: 'root', event, traceRole: 'main' })),
  };
}

function event(type: string, data: UnknownRecord, sequence: number): UnknownRecord {
  return { type, data, seq: sequence, time: 1_800_000_000_000 + sequence };
}

function assistant(usage: unknown, sequence: number): UnknownRecord {
  return event('assistant/message', {
    message: { content: [{ type: 'text', text: 'answer' }] },
    ...(usage === undefined ? {} : { usage }),
  }, sequence);
}

function completed(...middle: UnknownRecord[]): DshHostRunResult {
  return run([
    event('user/message', { content: [{ type: 'text', text: 'question' }] }, 0),
    ...middle,
    event('turn/end', { reason: { kind: 'completed' } }, middle.length + 1),
  ]);
}

describe('DSH Host Core protocol projection', () => {
  it('keeps partially reported usage unknown instead of persisting zero or a partial total', () => {
    const parsed = parseDshHostCoreResult(completed(
      assistant({ inputTokens: 3, outputTokens: 2 }, 1),
      assistant(undefined, 2),
    ), { model: 'dsh-model' });

    expect(parsed.usage).toEqual({
      details: {
        provider: 'dsh-host',
        model: 'dsh-model',
        stopReason: 'completed',
        tokenAccounting: 'exclusive-cache-input-buckets',
      },
    });
    expect(parsed.usage).not.toHaveProperty('inputTokens');
    expect(parsed.usage).not.toHaveProperty('providerCost');
  });

  it('normalizes disjoint cache buckets and omits incomplete reasoning details', () => {
    const parsed = parseDshHostCoreResult(completed(
      assistant({
        inputTokens: 5,
        outputTokens: 3,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 1,
      }, 1),
      assistant({ inputTokens: 4, outputTokens: 2 }, 2),
    ), { model: 'dsh-model', provider: 'route-a' });

    expect(parsed.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      details: {
        uncachedInputTokens: 9,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        providerRoute: 'route-a',
      },
    });
    expect(parsed.usage.details).not.toHaveProperty('reasoningOutputTokens');
  });

  it('rejects reasoning subsets larger than output and aggregate overflow', () => {
    expect(() => parseDshHostCoreResult(completed(
      assistant({ inputTokens: 1, outputTokens: 1, reasoningTokens: 2 }, 1),
    ), { model: 'dsh-model' })).toThrow('DSH Host reported invalid reasoning token usage.');

    expect(() => parseDshHostCoreResult(completed(
      assistant({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }, 1),
      assistant({ inputTokens: 1, outputTokens: 0 }, 2),
    ), { model: 'dsh-model' })).toThrow('DSH Host reported overflowing usage.');
  });

  it('accepts ignorable protocol extensions but rejects required and non-JSON events', () => {
    const ignorable = event('future/telemetry', { note: 'ignored' }, 1);
    ignorable.ignorable = true;
    expect(parseDshHostCoreResult(completed(
      ignorable,
      assistant({ inputTokens: 1, outputTokens: 1 }, 2),
    ), { model: 'dsh-model' }).terminalStatus).toBe('completed');

    expect(() => parseDshHostCoreResult(completed(
      event('future/required', {}, 1),
    ), { model: 'dsh-model' })).toThrow(
      'DSH Host returned an unsupported required session event.',
    );
    expect(() => parseDshHostCoreResult(completed(
      event('assistant/message', { invalid: 1n }, 1),
    ), { model: 'dsh-model' })).toThrow('DSH Host returned an invalid session event.');
  });

  it('rejects non-contiguous envelopes and inconsistent session lineage', () => {
    expect(() => parseDshHostCoreResult(run([
      event('user/message', { content: [] }, 0),
      event('turn/end', { reason: { kind: 'completed' } }, 2),
    ]), { model: 'dsh-model' })).toThrow('DSH Host returned an invalid session event.');

    const invalidLineage = completed(
      assistant({ inputTokens: 1, outputTokens: 1 }, 1),
    );
    invalidLineage.childSessionIds.push('root');
    expect(() => parseDshHostCoreResult(invalidLineage, { model: 'dsh-model' })).toThrow(
      'DSH Host returned invalid session lineage.',
    );
  });
});
