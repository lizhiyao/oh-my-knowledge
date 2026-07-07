import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('resolves bare script file args before per-task cwd changes', async () => {
    const baseCwd = await mkdtemp(join(tmpdir(), 'omk-script-executor-base-'));
    const taskCwd = await mkdtemp(join(tmpdir(), 'omk-script-executor-task-'));
    const prevCwd = process.cwd();
    try {
      await writeFile(join(baseCwd, 'bare-executor.mjs'), [
        'import { readFileSync } from "node:fs";',
        'const req = JSON.parse(readFileSync(0, "utf8"));',
        'console.log(JSON.stringify({ output: `bare: ${req.prompt}` }));',
      ].join('\n'));
      process.chdir(baseCwd);
      const executor = createExecutor('node bare-executor.mjs');
      const result = await executor({
        model: 'test',
        system: '',
        prompt: 'hello',
        cwd: taskCwd,
      });
      assert.equal(result.ok, true);
      assert.equal(result.output, 'bare: hello');
    } finally {
      process.chdir(prevCwd);
      await rm(baseCwd, { recursive: true, force: true });
      await rm(taskCwd, { recursive: true, force: true });
    }
  });

  it('does not rewrite bare args for non-interpreter script commands', async () => {
    const baseCwd = await mkdtemp(join(tmpdir(), 'omk-script-executor-echo-'));
    const prevCwd = process.cwd();
    try {
      await writeFile(join(baseCwd, 'marker'), 'local file should not turn echo arg absolute');
      process.chdir(baseCwd);
      const executor = createExecutor('/bin/echo marker');
      const result = await executor({
        model: 'test',
        system: '',
        prompt: 'ignored',
      });
      assert.equal(result.ok, true);
      assert.equal(result.output, 'marker');
    } finally {
      process.chdir(prevCwd);
      await rm(baseCwd, { recursive: true, force: true });
    }
  });

  it('does not rewrite interpreter module names as local paths', async () => {
    const baseCwd = await mkdtemp(join(tmpdir(), 'omk-script-executor-module-'));
    const taskCwd = await mkdtemp(join(tmpdir(), 'omk-script-executor-module-task-'));
    const prevCwd = process.cwd();
    try {
      await mkdir(join(baseCwd, 'my_provider'));
      const fakePython = join(baseCwd, 'python');
      await writeFile(fakePython, [
        '#!/usr/bin/env node',
        'import { readFileSync } from "node:fs";',
        'readFileSync(0, "utf8");',
        'console.log(JSON.stringify({ output: process.argv.slice(2).join("|") }));',
      ].join('\n'));
      await chmod(fakePython, 0o755);
      process.chdir(baseCwd);
      const executor = createExecutor('./python -m my_provider');
      const result = await executor({
        model: 'test',
        system: '',
        prompt: 'hello',
        cwd: taskCwd,
      });
      assert.equal(result.ok, true);
      assert.equal(result.output, '-m|my_provider');
    } finally {
      process.chdir(prevCwd);
      await rm(baseCwd, { recursive: true, force: true });
      await rm(taskCwd, { recursive: true, force: true });
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

  it('script executor mock 命中 round-trip:hook 命中后 mockStats.hits 回填', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path_endswith: 'x.txt' }, return: 'mocked' }];
    const executor = createExecutor('node test/fixtures/script-executor-mock-roundtrip.mjs');
    const result = await executor({ model: 'test', system: '', prompt: 'hi', mocks });
    assert.equal(result.ok, true);
    assert.ok(result.mockStats);
    // 完整闭环:env 暴露 hook → fixture 喂事件触发命中 → hook 写 hits.json → readStats 回填
    assert.equal(result.mockStats!.hits, 1);
    assert.equal(result.mockStats!.misses, 0);
  });

  it('script executor 把 mocksStrict 透传到物化的 mocks.json', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path_endswith: 'x.txt' }, return: 'mocked' }];
    const executor = createExecutor('node test/fixtures/script-executor-mock-probe.mjs');
    const result = await executor({ model: 'test', system: '', prompt: 'hi', mocks, mocksStrict: true });
    const probe = JSON.parse(result.output as string) as { strict: boolean | null };
    assert.equal(probe.strict, true);
  });

  it('script executor 错误退出路径也回填 mockStats(对齐 claude-cli)', async () => {
    const mocks: Mock[] = [{ tool: 'Read', match: { file_path_endswith: 'x.txt' }, return: 'mocked' }];
    const executor = createExecutor('node test/fixtures/script-executor-fail.mjs');
    const result = await executor({ model: 'test', system: '', prompt: 'hi', mocks });
    assert.equal(result.ok, false);
    // 出错样本同样带 mockStats(此 fixture 没真调工具,hits=0 但字段在),与 claude-cli 口径一致
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
