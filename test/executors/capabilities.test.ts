import { afterEach, describe, it, vi } from 'vitest';
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
  afterEach(() => vi.unstubAllEnvs());

  it('redacts captured credentials and authorization diagnostics without changing raw evidence', async () => {
    const credential = 'fixture-private-api-credential';
    vi.stubEnv('OPENAI_API_KEY', credential);
    const original = { ...await okExecutor({ model: 'fixture', prompt: '' }), ok: false,
      error: `provider diagnostic: ${credential}; Authorization: Bearer opaque-private-token`, output: credential };
    const wrapped = enforceExecutorCapabilities('openai-api', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'different-credential-after-await');
      return original;
    });
    const result = await wrapped({ model: 'fixture', prompt: '' });
    assert.equal(result.output, credential);
    assert.match(original.error, new RegExp(credential));
    assert.doesNotMatch(result.error ?? '', /fixture-private-api-credential|opaque-private-token/);
    assert.match(result.error ?? '', /provider diagnostic: \[REDACTED\]; Authorization: Bearer \[REDACTED\]/);
    assert.equal(result.ok, false);
  });

  it('declares built-in support explicitly and delegates custom scripts', () => {
    assert.equal(getExecutorCapabilities('codex').sampleMocks, 'unsupported');
    assert.equal(getExecutorCapabilities('codex-sdk').sampleMocks, 'unsupported');
    assert.equal(getExecutorCapabilities('dsh-host').sampleMocks, 'unsupported');
    assert.equal(getExecutorCapabilities('openai-api').sampleMocks, 'unsupported');
    assert.equal(
      getExecutorCapabilities('./custom-executor.sh').sampleMocks,
      'delegated-script',
    );
    assert.deepEqual(getExecutorCapabilities('openai-api').outputFormats, ['json-schema', 'json-object', 'prompt-json']);
    assert.deepEqual(getExecutorCapabilities('codex').outputFormats, ['json-schema', 'prompt-json']);
    assert.equal(getExecutorCapabilities('openai-api').maxOutputTokens, true);
    assert.equal(getExecutorCapabilities('codex').maxOutputTokens, false);
  });

  it('rejects unsupported or invalid explicit output requests before dispatch', async () => {
    const execute = vi.fn(okExecutor);
    const schemaFormat = { mode: 'json-schema', name: 'fixture', schema: { type: 'object' } } as const;
    for (const executor of ['codex-sdk', 'dsh-host', './custom-executor.sh']) {
      const wrapped = enforceExecutorCapabilities(executor, execute);
      for (const outputFormat of [schemaFormat, { mode: 'json-object' }, { mode: 'prompt-json' }] as const) {
        await assert.rejects(() => wrapped({ model: '', prompt: '', outputFormat }), /不支持输出模式/);
      }
    }
    await assert.rejects(() => enforceExecutorCapabilities('codex', execute)({ model: '', prompt: '', outputFormat: { mode: 'json-object' } }), /不支持输出模式/);
    for (const executor of ['codex', 'codex-sdk', './custom-executor.sh']) {
      await assert.rejects(() => enforceExecutorCapabilities(executor, execute)({ model: '', prompt: '', maxOutputTokens: 1 }), /不支持 maxOutputTokens/);
    }
    for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => enforceExecutorCapabilities('openai-api', execute)({ model: '', prompt: '', maxOutputTokens }), /positive safe integer/);
    }
    await assert.rejects(() => enforceExecutorCapabilities('openai-api', execute)({ model: '', prompt: '', outputFormat: { ...schemaFormat, name: '../invalid' } }), /valid name/);
    assert.equal(execute.mock.calls.length, 0);
  });

  it('preflights production executor inputs before dispatch', () => {
    const input: ExecutorInput = {
      model: 'test',
      prompt: 'read a file',
      mocks: [{ tool: 'Read', return: 'fixture' }],
    };
    for (const executor of ['codex', 'codex-sdk', 'dsh-host', 'openai-api']) {
      assert.throws(
        () => assertExecutorInputCapabilities(executor, input),
        /不支持 Sample\.mocks.*伪证据.*<programmatic-input>/,
      );
      assert.doesNotThrow(() => assertExecutorInputCapabilities(executor, { ...input, mocks: [] }));
      assert.doesNotThrow(() => assertExecutorInputCapabilities(executor, { model: 'test', prompt: 'test' }));
    }
    for (const executor of ['./custom-executor.sh']) {
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
    const wrapped = enforceExecutorCapabilities('./custom-executor.sh', async (input) => {
      receivedMocks = input.mocks?.length ?? 0;
      return okExecutor(input);
    });

    await wrapped({
      model: 'test',
      prompt: 'test',
      mocks: [{ tool: 'Read', return: 'fixture' }],
    });
    assert.equal(receivedMocks, 1);
    assert.equal(executorSupportsSampleMocks('codex'), false);
  });
});
