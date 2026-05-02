import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runExecutorSmoke } from '../../src/doctor/smoke.js';
import type { Artifact, ExecResult, ExecutorFn } from '../../src/types/index.js';

function mockExecutor(result: Partial<ExecResult> & { ok: boolean }): ExecutorFn {
  return async () => ({
    ok: result.ok,
    output: result.output ?? null,
    durationMs: result.durationMs ?? 50,
    durationApiMs: result.durationApiMs ?? 50,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0,
    stopReason: result.stopReason ?? 'end_turn',
    numTurns: 1,
    error: result.error,
  });
}

function throwingExecutor(message: string): ExecutorFn {
  return async () => {
    throw new Error(message);
  };
}

const artifact: Artifact = {
  name: 'test-skill',
  kind: 'skill',
  source: 'file-path',
  content: '你是一个测试助手,简短回答。',
};

describe('runExecutorSmoke', () => {
  it('returns ok=true when executor responds with non-empty output', async () => {
    const exec = mockExecutor({ ok: true, output: 'OK acknowledged.' });
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, true);
    assert.equal(r.output, 'OK acknowledged.');
    assert.equal(r.failureKind, undefined);
    assert.ok(r.durationMs >= 0);
  });

  it('classifies empty output as failureKind=empty', async () => {
    const exec = mockExecutor({ ok: true, output: '   ' });
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'empty');
  });

  it('classifies timeout error as failureKind=timeout', async () => {
    const exec = mockExecutor({ ok: false, output: null, error: 'request timed out after 8000ms' });
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'timeout');
  });

  it('classifies API key error as failureKind=auth', async () => {
    const exec = mockExecutor({ ok: false, output: null, error: 'missing API key in environment' });
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'auth');
  });

  it('classifies 401 unauthorized as failureKind=auth', async () => {
    const exec = mockExecutor({ ok: false, output: null, error: 'HTTP 401 Unauthorized' });
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'auth');
  });

  it('classifies generic error as failureKind=error', async () => {
    const exec = mockExecutor({ ok: false, output: null, error: 'something went wrong' });
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'error');
  });

  it('catches thrown exception and classifies as error', async () => {
    const exec = throwingExecutor('executor crashed');
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'error');
    assert.ok(r.error?.includes('executor crashed'));
  });

  it('catches timeout-shaped thrown exception as failureKind=timeout', async () => {
    const exec = throwingExecutor('request timed out');
    const r = await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(r.ok, false);
    assert.equal(r.failureKind, 'timeout');
  });

  it('passes artifact.content as system prompt', async () => {
    let capturedSystem: string | null | undefined;
    const exec: ExecutorFn = async (input) => {
      capturedSystem = input.system;
      return {
        ok: true,
        output: 'ack',
        durationMs: 10,
        durationApiMs: 10,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };
    await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.equal(capturedSystem, artifact.content);
  });

  it('isolates allowedSkills to [] by default to avoid SDK auto-discovery contamination', async () => {
    let capturedAllowed: string[] | undefined;
    const exec: ExecutorFn = async (input) => {
      capturedAllowed = input.allowedSkills;
      return {
        ok: true,
        output: 'ack',
        durationMs: 10,
        durationApiMs: 10,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUSD: 0,
        stopReason: 'end_turn',
        numTurns: 1,
      };
    };
    await runExecutorSmoke(artifact, exec, 'sonnet', '/tmp', 8000);
    assert.deepEqual(capturedAllowed, []);
  });
});
