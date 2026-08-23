import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getExecutorCapabilities } from '../../src/executors/capabilities.js';
import { createExecutor } from '../../src/executors/index.js';
import {
  executorDescriptors,
  executorFamily,
  executorNamesForFamily,
  executorVendor,
  getExecutorDescriptor,
  isRegisteredExecutorName,
} from '../../src/executors/registry.js';

describe('executor registry', () => {
  it('freezes the complete registered executor identity set', () => {
    const descriptors = executorDescriptors();
    assert.deepEqual(descriptors.map(({ name }) => name), [
      'claude',
      'claude-sdk',
      'codex',
      'codex-sdk',
      'dsh-host',
      'gemini',
      'anthropic-api',
      'openai-api',
    ]);
    assert.equal(new Set(descriptors.map(({ name }) => name)).size, descriptors.length);
  });

  it('binds every executable descriptor to a factory and reserves host-only entries', () => {
    for (const descriptor of executorDescriptors()) {
      assert.equal(getExecutorDescriptor(descriptor.name), descriptor);
      assert.equal(isRegisteredExecutorName(descriptor.name), true);
      assert.equal(
        getExecutorCapabilities(descriptor.name).sampleMocks,
        descriptor.sampleMocks,
      );
      if (descriptor.execution === 'builtin') {
        assert.equal(typeof createExecutor(descriptor.name), 'function');
      } else {
        assert.throws(() => createExecutor(descriptor.name), /宿主插件内部使用/);
      }
    }
  });

  it('derives family and vendor classifications without fallback-list drift', () => {
    assert.deepEqual([...executorNamesForFamily('claude')], ['claude', 'claude-sdk']);
    assert.deepEqual([...executorNamesForFamily('codex')], ['codex', 'codex-sdk']);
    assert.equal(executorFamily('openai-api'), 'openai-api');
    assert.equal(executorVendor('anthropic-api'), 'anthropic');
    assert.equal(executorVendor('codex-sdk'), 'openai');
    assert.equal(executorVendor('dsh-host'), 'unknown');
    assert.equal(executorFamily('./custom-executor.sh'), 'custom');
    assert.equal(isRegisteredExecutorName('./custom-executor.sh'), false);
  });
});
