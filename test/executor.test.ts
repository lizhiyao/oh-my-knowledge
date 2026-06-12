import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutor } from '../src/executors/index.js';
import type { Mock } from '../src/types/eval.js';

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

  it('script executor 物化 mocks 并通过 env 暴露临时 settings,跑完清理', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path_endswith: 'x.txt' }, return: 'mocked' }];
    const executor = createExecutor('node test/fixtures/script-executor-mock-probe.mjs');
    const result = await executor({ model: 'test', system: '', prompt: 'hi', mocks });
    assert.equal(result.ok, true);
    const probe = JSON.parse(result.output as string) as {
      hasSettingsEnv: boolean; hasMocksFile: boolean; settingsPath: string; settingsExists: boolean;
    };
    // env 暴露 + 临时 settings 在执行期间存在
    assert.equal(probe.hasSettingsEnv, true);
    assert.equal(probe.hasMocksFile, true);
    assert.equal(probe.settingsExists, true);
    // 跑完即清理:临时目录已删
    assert.equal(existsSync(probe.settingsPath), false);
    // mock 物化时 ExecResult.mockStats 应被回填(此 fixture 不真调工具,hits=0 但字段在)
    assert.ok(result.mockStats);
  });

  it('script executor 无 mocks 时不暴露 mock env(向后兼容)', async () => {
    const executor = createExecutor('node test/fixtures/script-executor-mock-probe.mjs');
    const result = await executor({ model: 'test', system: '', prompt: 'hi' });
    assert.equal(result.ok, true);
    const probe = JSON.parse(result.output as string) as { hasSettingsEnv: boolean; hasMocksFile: boolean };
    assert.equal(probe.hasSettingsEnv, false);
    assert.equal(probe.hasMocksFile, false);
    assert.equal(result.mockStats, undefined);
  });
});
