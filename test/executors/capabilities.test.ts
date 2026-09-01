import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  assertSamplesCompatibleWithExecutor,
  enforceExecutorCapabilities,
  executorSupportsSampleMocks,
  getExecutorCapabilities,
} from '../../src/executors/core/capabilities.js';
import { createExecutor } from '../../src/executors/index.js';
import type { ExecutorFn } from '../../src/executors/contracts/ports.js';
import type { Sample } from '../../src/inputs/contracts/sample.js';

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

  it('rejects incompatible samples before evaluation starts', () => {
    const samples: Sample[] = [{
      sample_id: 'codex-impossible',
      prompt: 'read a file',
      mocks: [{ tool: 'Read', return: 'fixture' }],
      assertions: [{ type: 'mock_hit', value: 'Read:1' }],
    }];

    assert.throws(
      () => assertSamplesCompatibleWithExecutor(samples, 'codex'),
      /不支持 Sample\.mocks.*伪证据.*codex-impossible/,
    );
    assert.doesNotThrow(
      () => assertSamplesCompatibleWithExecutor(samples, 'claude'),
    );
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
