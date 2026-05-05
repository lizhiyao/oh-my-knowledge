import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../src/executors/index.js';

describe('createExecutor', () => {
  it('returns a function for claude', () => {
    const exec = createExecutor('claude');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for openai-api', () => {
    const exec = createExecutor('openai-api');
    assert.equal(typeof exec, 'function');
  });

  it('returns a function for codex-sdk', () => {
    const exec = createExecutor('codex-sdk');
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

  it('resolves relative script executor paths before per-task cwd changes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omk-script-executor-cwd-'));
    try {
      const executor = createExecutor('node test/fixtures/script-executor.mjs');
      const result = await executor({
        model: 'test',
        system: '',
        prompt: 'hello',
        cwd,
      });
      assert.equal(result.ok, true);
      assert.equal(result.output, 'fixture: hello');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
