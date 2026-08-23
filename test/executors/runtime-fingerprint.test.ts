import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

vi.unmock('node:child_process');

function writeFakeBinary(dir: string, name: string, output: string): void {
  const fileName = process.platform === 'win32' ? `${name}.cmd` : name;
  const filePath = join(dir, fileName);
  const content = process.platform === 'win32'
    ? `@echo off\r\necho ${output}\r\n`
    : `#!/bin/sh\necho ${output}\n`;
  writeFileSync(filePath, content);
  if (process.platform !== 'win32') chmodSync(filePath, 0o755);
}

describe('runtime fingerprint', () => {
  it('probes PATH from the same env shape executors use', async () => {
    vi.resetModules();
    const { getExecutorRuntimeFingerprint } = await import('../../src/executors/runtime-fingerprint.js');
    const dirA = mkdtempSync(join(tmpdir(), 'omk-runtime-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'omk-runtime-b-'));
    try {
      writeFakeBinary(dirA, 'codex', 'codex-a');
      writeFakeBinary(dirB, 'codex', 'codex-b');
      const basePath = process.env.PATH || '';
      const a = getExecutorRuntimeFingerprint('codex', 'gpt-5', {
        env: { ...process.env, PATH: `${dirA}${delimiter}${basePath}` },
      });
      const b = getExecutorRuntimeFingerprint('codex', 'gpt-5', {
        env: { ...process.env, PATH: `${dirB}${delimiter}${basePath}` },
      });

      assert.equal(a.binary?.version, 'codex-a');
      assert.equal(b.binary?.version, 'codex-b');
      assert.ok(a.binary?.path?.startsWith(dirA));
      assert.ok(b.binary?.path?.startsWith(dirB));
      assert.notEqual(a.fingerprint, b.fingerprint);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it('binds a custom script runtime to referenced file contents', async () => {
    vi.resetModules();
    const { getExecutorRuntimeFingerprint } = await import('../../src/executors/runtime-fingerprint.js');
    const dir = mkdtempSync(join(tmpdir(), 'omk-runtime-script-'));
    const script = join(dir, 'executor.mjs');
    try {
      writeFileSync(script, 'console.log("v1");\n');
      const first = getExecutorRuntimeFingerprint(`node ${script}`, 'test-model');

      writeFileSync(script, 'console.log("v2");\n');
      const second = getExecutorRuntimeFingerprint(`node ${script}`, 'test-model');

      assert.equal(first.runtimeKind, 'script');
      assert.equal(first.capabilities.trace, 'best-effort');
      assert.match(first.binary?.contentHash || '', /^[a-f0-9]{64}$/);
      assert.notEqual(first.binary?.contentHash, second.binary?.contentHash);
      assert.notEqual(first.fingerprint, second.fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not expose mutable references owned by the runtime cache', async () => {
    vi.resetModules();
    const { getExecutorRuntimeFingerprint } = await import('../../src/executors/runtime-fingerprint.js');
    const first = getExecutorRuntimeFingerprint('openai-api', 'gpt-test');
    const expected = first.fingerprint;
    first.fingerprint = 'caller-mutated';
    if (first.binary) first.binary.name = 'caller-mutated';

    const second = getExecutorRuntimeFingerprint('openai-api', 'gpt-test');
    assert.equal(second.fingerprint, expected);
    assert.equal(second.binary?.name, 'openai-api');
    assert.notEqual(first, second);
  });

  it('fingerprints dsh-host from the actual invoking DSH CLI package', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'omk-runtime-dsh-host-'));
    const entrypoint = join(dir, 'lib', 'bin.js');
    const previousEntrypoint = process.argv[1];
    try {
      mkdirSync(join(dir, 'lib'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: '@deepseek-ai/dsh',
        version: '9.8.7-test',
      }));
      writeFileSync(entrypoint, '');
      process.argv[1] = entrypoint;
      const { getExecutorRuntimeFingerprint } = await import('../../src/executors/runtime-fingerprint.js');

      const fingerprint = getExecutorRuntimeFingerprint('dsh-host', 'deepseek-chat');

      assert.equal(fingerprint.binary?.name, '@deepseek-ai/dsh');
      assert.equal(fingerprint.binary?.version, '9.8.7-test');
      assert.equal(fingerprint.binary?.path, entrypoint);
      assert.equal(fingerprint.binary?.package?.name, '@deepseek-ai/dsh');
      assert.equal(fingerprint.binary?.package?.version, '9.8.7-test');
    } finally {
      process.argv[1] = previousEntrypoint;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
