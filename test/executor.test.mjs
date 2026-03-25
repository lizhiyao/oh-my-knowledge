import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createExecutor } from '../lib/executor.mjs';

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

  it('throws on unknown executor', () => {
    assert.throws(
      () => createExecutor('unknown'),
      /Unknown executor.*Available: claude, openai, gemini/,
    );
  });
});
