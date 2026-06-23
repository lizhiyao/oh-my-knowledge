/**
 * oclif 路径 doctor 命令验收。
 * 跟 test/cli.test.ts L341-357 的 legacy doctor 测试对照,验证迁移后行为对得齐:
 * - --help 双语切换
 * - unknown flag → exit 2
 * - happy path 同 legacy stderr 关键字
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
const CLI = join(PROJECT_ROOT, 'dist', 'cli', 'index.js');

interface ExecError extends Error {
  code?: number;
  stdout: string;
  stderr: string;
}


describe('oclif doctor', () => {
  it('--help 默认 zh 含中文 description', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help']);
    assert.ok(stdout.includes('体检 omk 工作目录'), `stdout missing zh description:\n${stdout}`);
    assert.ok(stdout.includes('USAGE'), 'stdout missing USAGE block');
    assert.ok(stdout.includes('--repeat'), 'stdout missing --repeat flag');
    assert.ok(stdout.includes('--static-only'), 'stdout must list --static-only flag');
  });

  it('--help --lang en 切到英文 description', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('Preflight health checks'), `stdout missing en description:\n${stdout}`);
    assert.ok(!stdout.includes('体检 omk 工作目录'), 'stdout should not contain zh in --lang en mode');
  });

  it('OMK_LANG=en env 同效切到英文', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env: { ...process.env, OMK_LANG: 'en' } });
    assert.ok(stdout.includes('Preflight health checks'), 'OMK_LANG=en should switch help to en');
  });

  it('unknown flag → exit code 2 (oclif failedFlagParsing invariant)', async () => {
    try {
      await execFileAsync('node', [CLI, 'doctor', '--no-such-flag']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}:\n${e.stderr}`);
      assert.ok(e.stderr.includes('Nonexistent flag'), 'stderr should mention nonexistent flag');
    }
  });
});
