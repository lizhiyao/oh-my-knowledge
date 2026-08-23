import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'vitest';
import {
  buildDshRuntimeEnv,
  dshSdkExecutor,
  resolveDshLaunchConfig,
} from '../../src/executors/dsh-sdk.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const runtime = join(fixtures, 'dsh-jsonrpc-runtime.mjs');
const config = join(fixtures, 'dsh-cordis.yml');
const tempDirs: string[] = [];
const originalEnv = { ...process.env };

function configureFixtureRuntime(): void {
  process.env.OMK_DSH_COMMAND = process.execPath;
  process.env.OMK_DSH_ARGS = JSON.stringify([runtime]);
  process.env.OMK_DSH_CONFIG = config;
  process.env.OMK_DSH_PROVIDER = 'fixture-provider';
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('dsh SDK executor', () => {
  it('runs the official SDK against an explicit JSON-RPC runtime and maps evidence', async () => {
    configureFixtureRuntime();
    const cwd = mkdtempSync(join(tmpdir(), 'omk-dsh-workspace-'));
    tempDirs.push(cwd);

    const result = await dshSdkExecutor({
      model: 'fixture-model',
      system: 'system contract',
      prompt: 'evaluate this',
      cwd,
      allowedSkills: [],
      timeoutMs: 5_000,
    });

    assert.equal(result.ok, true, result.error);
    assert.match(result.output ?? '', /^system contract\|evaluate this\|/);
    assert.equal(result.stopReason, 'completed');
    assert.equal(result.inputTokens, 13);
    assert.equal(result.outputTokens, 6);
    assert.equal(result.cacheReadTokens, 2);
    assert.equal(result.cacheCreationTokens, 1);
    assert.equal(result.tokenUsageReportedByExecutor, true);
    assert.equal(result.costReportedByExecutor, false);
    assert.equal(result.numTurns, 1);
    assert.equal(result.fullNumTurns, 2);
    assert.equal(result.numSubAgents, 1);
    assert.deepEqual(result.toolCalls?.map((tool) => ({
      tool: tool.tool,
      sourceTool: tool.sourceTool,
      input: tool.input,
      output: tool.output,
      status: tool.status,
      statusSource: tool.statusSource,
      success: tool.success,
      traceRole: tool.traceRole,
    })), [{
      tool: 'Read',
      sourceTool: 'read',
      input: { path: 'README.md' },
      output: 'fixture file',
      status: 'success',
      statusSource: 'runtime',
      success: true,
      traceRole: 'main',
    }]);

    const [, , isolatedHome, isolatedSessions, configPath] = (result.output ?? '').split('|');
    assert.equal(configPath, config);
    assert.equal(existsSync(isolatedHome), false);
    assert.equal(existsSync(isolatedSessions), false);
  });

  it('requires an explicit Cordis config instead of inheriting an ambient DSH profile', () => {
    assert.throws(
      () => resolveDshLaunchConfig({ PATH: process.env.PATH }, process.cwd()),
      /OMK_DSH_CONFIG.*关闭 DSH skill 自动发现/,
    );
  });

  it('passes the measured model to runtimes that consume DSH_MODEL', () => {
    const env = buildDshRuntimeEnv({
      model: 'fixture-model',
      cwd: '/workspace',
      system: 'system contract',
    }, {
      command: 'dsh-jsonrpc-agent',
      args: [],
      configPath: config,
      provider: 'fixture-provider',
    }, '/isolated');

    assert.equal(env.DSH_MODEL, 'fixture-model');
  });

  it('rejects malformed runtime args before launching a subprocess', () => {
    assert.throws(
      () => resolveDshLaunchConfig({
        OMK_DSH_CONFIG: config,
        OMK_DSH_ARGS: 'runtime.mjs',
      }),
      /OMK_DSH_ARGS 必须是 JSON 字符串数组/,
    );
  });

  it('closes a non-cancellable DSH runtime when the sample deadline expires', async () => {
    configureFixtureRuntime();
    const cwd = mkdtempSync(join(tmpdir(), 'omk-dsh-timeout-'));
    tempDirs.push(cwd);
    const result = await dshSdkExecutor({
      model: 'fixture-model',
      prompt: '__hang__',
      cwd,
      allowedSkills: [],
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.stopReason, 'timeout');
    assert.match(result.error ?? '', /timed out/);
  });
});
