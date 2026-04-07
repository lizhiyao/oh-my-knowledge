import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createExecutor } from '../src/executors/index.js';

describe('createExecutor', () => {
  it('returns a function for claude', () => {
    const exec = createExecutor('claude');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for openai', () => {
    const exec = createExecutor('openai');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for gemini', () => {
    const exec = createExecutor('gemini');
    assert.equal(typeof exec, 'function');
  });

  it('defaults to claude', () => {
    const exec = createExecutor();
    assert.equal(typeof exec, 'function');
  });

  it('falls back to script executor for unknown name', () => {
    const executor = createExecutor('echo hello');
    assert.equal(typeof executor, 'function');
  });
});
