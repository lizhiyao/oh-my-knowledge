import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  executorResultValidationError,
  normalizeExecResultToolIdentities,
} from '../../src/executors/result-validation.js';
import type { ExecResult } from '../../src/executors/contracts/result.js';
import type { ToolCallInfo } from '../../src/executors/contracts/trace.js';

function validResult(): ExecResult {
  return {
    ok: true,
    output: 'done',
    durationMs: 10,
    durationApiMs: 8,
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0.01,
    stopReason: 'end_turn',
    numTurns: 1,
  };
}

describe('executor result contract', () => {
  it('accepts a valid source-neutral result and trace', () => {
    const result: ExecResult = {
      ...validResult(),
      toolCalls: [{
        tool: 'github.fetch_file',
        input: { path: 'README.md' },
        output: 'ok',
        success: true,
        status: 'success',
        statusSource: 'runtime',
        sourceKind: 'codex',
        traceRole: 'main',
        timestamp: '2026-07-27T00:00:00.000Z',
      }],
      turns: [{ role: 'assistant', content: 'done' }],
      mockStats: { hits: 1, misses: 0, perMock: { 'Read:0': 1 } },
    };
    assert.equal(executorResultValidationError(result), undefined);
    assert.equal(normalizeExecResultToolIdentities(result).output, 'done');
  });

  it('normalizes provider-native tools at the shared result boundary', () => {
    const rawCall: ToolCallInfo = {
      tool: 'command_execution',
      input: 'pwd',
      output: '/repo',
      success: true,
      status: 'success',
      statusSource: 'runtime',
    };
    const result: ExecResult = {
      ...validResult(),
      toolCalls: [rawCall],
      turns: [{
        role: 'assistant',
        content: '',
        toolCalls: [rawCall],
      }],
    };
    assert.equal(executorResultValidationError(result), undefined);
    const parsed = normalizeExecResultToolIdentities(result);
    assert.ok(parsed);
    assert.equal(parsed.toolCalls?.[0].tool, 'Bash');
    assert.equal(parsed.toolCalls?.[0].sourceTool, 'command_execution');
    assert.equal(parsed.turns?.[0].toolCalls?.[0].tool, 'Bash');
    assert.equal(rawCall.tool, 'command_execution');
  });

  it('normalizes an already-qualified custom tool idempotently', () => {
    const result: ExecResult = {
      ...validResult(),
      toolCalls: [{
        tool: 'github.fetch_file',
        toolNamespace: 'github',
        input: {},
        output: 'done',
        success: true,
      }],
    };
    assert.equal(executorResultValidationError(result), undefined);
    const once = normalizeExecResultToolIdentities(result);
    assert.ok(once);
    assert.equal(executorResultValidationError(once), undefined);
    const twice = normalizeExecResultToolIdentities(once);
    assert.equal(twice?.toolCalls?.[0].tool, 'github.fetch_file');
    assert.equal(twice?.toolCalls?.[0].sourceTool, undefined);
  });

  it('rejects aggregate token overflow and inconsistent tool outcomes', () => {
    assert.match(
      executorResultValidationError({
        ...validResult(),
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 1,
      }) ?? '',
      /aggregate exceeds safe integer/,
    );
    assert.match(
      executorResultValidationError({
        ...validResult(),
        toolCalls: [{
          tool: 'Read',
          input: {},
          output: 'cancelled',
          success: true,
          status: 'cancelled',
        }],
      }) ?? '',
      /invalid trace entry/,
    );
  });

  it('rejects success without output and forged mock totals', () => {
    assert.match(
      executorResultValidationError({ ...validResult(), output: null }) ?? '',
      /must contain model output/,
    );
    assert.match(
      executorResultValidationError({
        ...validResult(),
        mockStats: { hits: 2, misses: 0, perMock: { 'Read:0': 1 } },
      }) ?? '',
      /invalid counters/,
    );
  });

  it('rejects tool payloads that cannot be persisted as JSON without coercion', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const hostileProxy = new Proxy({}, {
      ownKeys(): never {
        throw new Error('nope');
      },
    });
    for (const input of [
      1n,
      Number.NaN,
      undefined,
      cyclic,
      new Date('2026-07-27T00:00:00Z'),
      Array(1),
      hostileProxy,
    ]) {
      assert.match(
        executorResultValidationError({
          ...validResult(),
          toolCalls: [{
            tool: 'Read',
            input,
            output: 'done',
            success: true,
          }],
        }) ?? '',
        /invalid trace entry/,
      );
    }
  });
});
