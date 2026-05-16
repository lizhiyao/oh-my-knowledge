/**
 * oclif dispatcher 验收(PR-C 后 oclif 已成默认入口,无 OMK_CLI_NEXT 开关)。
 * 验证所有命令默认都走 oclif:
 * - 未知命令 → exit 1(oclif.exitCodes.default = 1,对齐 legacy unknown_domain 语义)
 * - 已知命令 --help 有 oclif 风格的 USAGE block
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

describe('oclif dispatcher (PR-C 后默认 oclif)', () => {
  it('doctor --help 走 oclif(有 USAGE block)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help']);
    assert.ok(stdout.includes('\nUSAGE\n'), `expected oclif USAGE block, got:\n${stdout.slice(0, 200)}`);
  });

  it('eval --help 走 oclif', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help']);
    assert.ok(stdout.includes('\nUSAGE\n'), 'expected oclif USAGE block');
    assert.ok(stdout.includes('--control'), 'should list --control flag');
  });

  it('未知命令 → exit 1(对齐 legacy unknown_domain 语义)', async () => {
    try {
      await execFileAsync('node', [CLI, 'nope-command']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1 for unknown command, got ${e.code}`);
    }
  });

  it('OMK_CLI_NEXT=1 仍 work(向后兼容,曾经的 dogfood env 现已 noop)', async () => {
    const env = { ...process.env, OMK_CLI_NEXT: '1' };
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env });
    assert.ok(stdout.includes('\nUSAGE\n'), 'oclif USAGE block expected');
  });
});
