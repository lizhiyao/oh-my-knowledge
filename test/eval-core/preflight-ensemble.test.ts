import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { preflightAllJudges } from '../../src/eval-core/evaluation-execution.js';
import type { ExecResult, ExecutorFn, JudgeConfig } from '../../src/types/index.js';

const okResult: ExecResult = {
  ok: true,
  output: '5',
  durationMs: 1,
  durationApiMs: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0,
  stopReason: 'end_turn',
  numTurns: 1,
};

function trackingExecutor(name: string, calls: string[]): ExecutorFn {
  return async (opts) => {
    calls.push(`${name}:${opts.model}`);
    return okResult;
  };
}

function failingExecutor(name: string, calls: string[]): ExecutorFn {
  return async (opts) => {
    calls.push(`${name}:${opts.model}`);
    return { ...okResult, ok: false, output: null, error: 'auth failed' };
  };
}

describe('preflightAllJudges', () => {
  it('preflights every unique (executor, model) judge in an ensemble', async () => {
    const calls: string[] = [];
    const judgeExecutors = {
      'exec-a': trackingExecutor('exec-a', calls),
      'exec-b': trackingExecutor('exec-b', calls),
    };
    const judgeModels: JudgeConfig[] = [
      { executor: 'exec-a', model: 'm1' },
      { executor: 'exec-b', model: 'm2' },
      { executor: 'exec-a', model: 'm3' },
    ];

    await preflightAllJudges(judgeModels, judgeExecutors);

    // 之前的 bug:只 preflight 第一个 judge → calls.length === 1,m2/m3 漏检。
    // 修复后:每个 unique (executor, model) 都被 probe 一次。
    assert.deepEqual(calls.sort(), ['exec-a:m1', 'exec-a:m3', 'exec-b:m2']);
  });

  it('dedupes duplicate (executor, model) entries', async () => {
    const calls: string[] = [];
    const judgeExecutors = {
      'exec-a': trackingExecutor('exec-a', calls),
    };

    await preflightAllJudges(
      [
        { executor: 'exec-a', model: 'm1' },
        { executor: 'exec-a', model: 'm1' },
      ],
      judgeExecutors,
    );

    assert.equal(calls.length, 1, 'duplicate judge should probe once');
  });

  it('throws fail-fast when any judge fails preflight (does not silently continue)', async () => {
    const calls: string[] = [];
    const judgeExecutors = {
      'exec-a': trackingExecutor('exec-a', calls),
      'exec-bad': failingExecutor('exec-bad', calls),
    };

    await assert.rejects(
      () => preflightAllJudges(
        [
          { executor: 'exec-a', model: 'm-ok' },
          { executor: 'exec-bad', model: 'm-fail' },
          { executor: 'exec-a', model: 'm-after-fail' },
        ],
        judgeExecutors,
      ),
      /preflight failed/,
    );

    // m-ok 通过 → 然后 m-fail 抛错 → m-after-fail 不被探测(fail-fast)。
    assert.deepEqual(calls, ['exec-a:m-ok', 'exec-bad:m-fail']);
  });

  it('throws when judge entry references an executor missing from the map', async () => {
    await assert.rejects(
      () => preflightAllJudges(
        [{ executor: 'unmapped', model: 'm' }],
        {},
      ),
      /no executor registered for "unmapped"/,
    );
  });
});
