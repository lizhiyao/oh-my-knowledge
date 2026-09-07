import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { getExecutorCapabilities } from '../../src/executors/core/capabilities.js';
import { getOptionalExecutorDependency } from '../../src/executors/core/optional-dependencies.js';
import { createExecutor } from '../../src/executors/index.js';
import {
  executorFamily,
  executorNamesForFamily,
  getExecutorDescriptor,
  type ExecutorFamily,
  type RegisteredExecutorDescriptor,
} from '../../src/executors/core/registry.js';

function registeredDescriptors(): RegisteredExecutorDescriptor[] {
  const families = {
    claude: 'claude',
    codex: 'codex',
    dsh: 'dsh',
    'anthropic-api': 'anthropic-api',
    'openai-api': 'openai-api',
  } as const satisfies {
    [Family in ExecutorFamily | RegisteredExecutorDescriptor['family']]: Family;
  };
  return Object.values(families)
    .flatMap((family) => [...executorNamesForFamily(family)])
    .map((name) => {
      const descriptor = getExecutorDescriptor(name);
      assert.ok(descriptor);
      return descriptor;
    });
}

describe('executor registry', () => {
  it('freezes the complete registered executor identity set', () => {
    const descriptors = registeredDescriptors();
    assert.deepEqual(descriptors.map(({ name }) => name), [
      'claude',
      'claude-sdk',
      'codex',
      'codex-sdk',
      'dsh-host',
      'anthropic-api',
      'openai-api',
    ]);
    assert.equal(new Set(descriptors.map(({ name }) => name)).size, descriptors.length);
    assert.deepEqual(
      descriptors
        .filter((descriptor) => (
          descriptor.execution === 'builtin'
          && getOptionalExecutorDependency(descriptor.name)
        ))
        .map(({ name }) => name),
      ['claude-sdk', 'codex-sdk'],
    );
  });

  it('binds core descriptors and reserves host-only entries', () => {
    for (const descriptor of registeredDescriptors()) {
      assert.equal(getExecutorDescriptor(descriptor.name), descriptor);
      assert.ok(getExecutorDescriptor(descriptor.name));
      assert.equal(
        getExecutorCapabilities(descriptor.name).sampleMocks,
        descriptor.sampleMocks,
      );
      if (descriptor.execution === 'builtin') {
        if (!getOptionalExecutorDependency(descriptor.name)) {
          assert.equal(typeof createExecutor(descriptor.name), 'function');
        }
      } else {
        assert.throws(() => createExecutor(descriptor.name), /宿主插件内部使用/);
      }
    }
  });

  it('derives family and vendor classifications without fallback-list drift', () => {
    assert.deepEqual([...executorNamesForFamily('claude')], ['claude', 'claude-sdk']);
    assert.deepEqual([...executorNamesForFamily('codex')], ['codex', 'codex-sdk']);
    assert.equal(executorFamily('openai-api'), 'openai-api');
    assert.equal(getExecutorDescriptor('anthropic-api')?.vendor, 'anthropic');
    assert.equal(getExecutorDescriptor('codex-sdk')?.vendor, 'openai');
    assert.equal(getExecutorDescriptor('dsh-host')?.vendor, 'unknown');
    assert.equal(executorFamily('./custom-executor.sh'), 'custom');
    assert.equal(getExecutorDescriptor('./custom-executor.sh'), undefined);
  });
});
