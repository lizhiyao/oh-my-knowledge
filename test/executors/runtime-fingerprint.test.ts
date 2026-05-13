import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
});
