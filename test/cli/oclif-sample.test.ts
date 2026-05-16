/**
 * oclif 路径 sample 命令验收(OMK_CLI_NEXT=1)。
 * 验证 sample 三模式入口都能正确分流到生产 execute():
 * - 缺 positional + 非 batch / fix → exit 1 + 中文 hint
 * - unknown flag → exit 2
 * - --batch 走不存在的 skill-dir → exit 1
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const CLI = join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}

const OCLIF_ENV = { ...process.env, OMK_CLI_NEXT: '1' };

describe('oclif sample (OMK_CLI_NEXT=1)', () => {
  it('--help 默认 zh', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'sample', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('为指定 skill 生成评测用例'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('--batch'), 'stdout missing --batch flag');
    assert.ok(stdout.includes('--fix'), 'stdout missing --fix flag');
  });

  it('--help --lang en 切英文', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'sample', '--help', '--lang', 'en'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('Generate eval samples'), 'stdout should contain en description');
  });

  it('缺 positional + 非 batch + 非 fix → exit 1 (生产 execute 透传)', async () => {
    try {
      await execFileAsync('node', [CLI, 'sample'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}:\n${e.stderr}`);
      assert.ok(
        e.stderr.includes('请指定 skill 文件路径'),
        `stderr missing zh hint:\n${e.stderr}`,
      );
    }
  });

  it('unknown flag → exit 2', async () => {
    try {
      await execFileAsync('node', [CLI, 'sample', '--bogus'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}`);
      assert.ok(e.stderr.includes('Nonexistent flag'));
    }
  });

  it('--batch + 不存在的 skill-dir → exit 1', async () => {
    try {
      await execFileAsync('node', [CLI, 'sample', '--batch', '--skill-dir', '/tmp/omk-nonexistent-skill-dir-xyz'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}:\n${e.stderr}`);
    }
  });
});
