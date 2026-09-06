import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  assertExecutorInputCapabilities,
  enforceExecutorCapabilities,
  executorSupportsSampleMocks,
  getExecutorCapabilities,
} from '../../src/executors/core/capabilities.js';
import { createExecutor } from '../../src/executors/index.js';
import type { ExecutorFn, ExecutorInput } from '../../src/executors/contracts/ports.js';

const okExecutor: ExecutorFn = async () => ({
  ok: true,
  output: 'ok',
  durationMs: 1,
  durationApiMs: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0,
  stopReason: 'end_turn',
  numTurns: 1,
});

describe('executor sample-mock capabilities', () => {
  it('declares built-in support explicitly and delegates custom scripts', () => {
    assert.equal(getExecutorCapabilities('claude').sampleMocks, 'native-hooks');
    assert.equal(getExecutorCapabilities('claude-sdk').sampleMocks, 'native-hooks');
    assert.equal(getExecutorCapabilities('codex').sampleMocks, 'unsupported');
    assert.equal(getExecutorCapabilities('codex-sdk').sampleMocks, 'unsupported');
    assert.equal(getExecutorCapabilities('dsh-host').sampleMocks, 'unsupported');
    assert.equal(getExecutorCapabilities('openai-api').sampleMocks, 'unsupported');
    assert.equal(
      getExecutorCapabilities('./custom-executor.sh').sampleMocks,
      'delegated-script',
    );
  });

  it('preflights production executor inputs before dispatch', () => {
    const input: ExecutorInput = {
      model: 'test',
      prompt: 'read a file',
      mocks: [{ tool: 'Read', return: 'fixture' }],
    };
    for (const executor of ['codex', 'codex-sdk', 'dsh-host', 'openai-api', 'anthropic-api']) {
      assert.throws(
        () => assertExecutorInputCapabilities(executor, input),
        /不支持 Sample\.mocks.*伪证据.*<programmatic-input>/,
      );
      assert.doesNotThrow(() => assertExecutorInputCapabilities(executor, { ...input, mocks: [] }));
      assert.doesNotThrow(() => assertExecutorInputCapabilities(executor, { model: 'test', prompt: 'test' }));
    }
    for (const executor of ['claude', 'claude-sdk', './custom-executor.sh']) {
      assert.doesNotThrow(() => assertExecutorInputCapabilities(executor, input));
    }
  });

  it('guards direct executor calls instead of silently dropping mocks', async () => {
    const codex = createExecutor('codex');
    await assert.rejects(
      () => codex({
        model: 'test',
        prompt: 'test',
        mocks: [{ tool: 'Read', return: 'fixture' }],
      }),
      /不支持 Sample\.mocks/,
    );
  });

  it('lets a supported executor receive mocks unchanged', async () => {
    let receivedMocks = 0;
    const wrapped = enforceExecutorCapabilities('claude', async (input) => {
      receivedMocks = input.mocks?.length ?? 0;
      return okExecutor(input);
    });

    await wrapped({
      model: 'test',
      prompt: 'test',
      mocks: [{ tool: 'Read', return: 'fixture' }],
    });
    assert.equal(receivedMocks, 1);
    assert.equal(executorSupportsSampleMocks('claude'), true);
    assert.equal(executorSupportsSampleMocks('codex'), false);
  });
});
