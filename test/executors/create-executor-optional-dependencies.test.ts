import { beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';

const dependencyGuard = vi.hoisted(() => vi.fn());

vi.mock('../../src/executors/core/optional-dependencies.js', () => ({
  assertOptionalExecutorDependency: dependencyGuard,
}));

import { createExecutor } from '../../src/executors/index.js';

describe('createExecutor optional dependency wiring', () => {
  beforeEach(() => {
    dependencyGuard.mockReset();
  });

  it('creates the Codex SDK executor when their optional dependencies are available', () => {
    assert.equal(typeof createExecutor('codex-sdk'), 'function');
    assert.deepEqual(dependencyGuard.mock.calls, [
      ['codex-sdk'],
    ]);
  });

  it('propagates the missing dependency error before returning an executor', () => {
    const missingDependency = new Error('optional SDK missing');
    dependencyGuard.mockImplementation((executorName: string) => {
      if (executorName === 'codex-sdk') {
        throw missingDependency;
      }
    });

    assert.throws(
      () => createExecutor('codex-sdk'),
      (error: unknown) => error === missingDependency,
    );
  });
});
