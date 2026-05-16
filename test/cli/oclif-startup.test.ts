/**
 * --help / --version 短路径不被 checkUpdate fetch 拖慢的回归测试。
 * 用 OMK_DISABLE_UPDATE_CHECK / 离线 NPM_CONFIG_REGISTRY 模拟最坏情况,
 * 确认 short-circuit 把 update fetch 跳掉,event loop 不被 unawaited fetch 拖住。
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

/**
 * 用一个保证不可达的 registry 让 fetch 走满 timeout。如果短路径生效,
 * --help 会在网络 I/O 之前 resolve;反之会被拖到 ~3s timeout。
 * 阈值给得宽松(800ms),既能挡住 1100ms 回归又不被偶发 GC / IO 抖动误判。
 */
const HOSTILE_ENV = {
  ...process.env,
  npm_config_registry: 'http://127.0.0.1:1/',
};
const STARTUP_BUDGET_MS = 800;

async function timed(args: string[]): Promise<number> {
  const t0 = Date.now();
  await execFileAsync('node', [CLI, ...args], { env: HOSTILE_ENV });
  return Date.now() - t0;
}

describe('oclif startup short-circuit (skip checkUpdate on --help/--version)', () => {
  it(`--help 在 ${STARTUP_BUDGET_MS}ms 内完成(不被 checkUpdate fetch 拖)`, async () => {
    const ms = await timed(['--help']);
    assert.ok(
      ms < STARTUP_BUDGET_MS,
      `--help took ${ms}ms, expected < ${STARTUP_BUDGET_MS}ms (regression: checkUpdate fetch should be skipped on short path)`,
    );
  });

  it(`--version 在 ${STARTUP_BUDGET_MS}ms 内完成`, async () => {
    const ms = await timed(['--version']);
    assert.ok(
      ms < STARTUP_BUDGET_MS,
      `--version took ${ms}ms, expected < ${STARTUP_BUDGET_MS}ms`,
    );
  });

  it(`doctor --help 在 ${STARTUP_BUDGET_MS}ms 内完成(子命令 --help 同样走短路径)`, async () => {
    const ms = await timed(['doctor', '--help']);
    assert.ok(
      ms < STARTUP_BUDGET_MS,
      `doctor --help took ${ms}ms, expected < ${STARTUP_BUDGET_MS}ms`,
    );
  });

  it(`-h 短开关跟 --help 等价(走 oclif additionalHelpFlags)`, async () => {
    const { stdout } = await execFileAsync('node', [CLI, '-h']);
    assert.ok(stdout.includes('\nUSAGE\n'), `expected oclif USAGE block on -h, got:\n${stdout.slice(0, 200)}`);
  });

  it(`-v 短开关跟 --version 等价`, async () => {
    const { stdout } = await execFileAsync('node', [CLI, '-v']);
    assert.ok(/\d+\.\d+\.\d+/.test(stdout), `expected version string on -v, got: ${stdout}`);
  });

  it(`eval -h 走 oclif help(不再报 -h not found)`, async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '-h']);
    assert.ok(stdout.includes('\nUSAGE\n'), 'eval -h should print oclif USAGE');
    assert.ok(stdout.includes('--control'), 'eval -h should list --control flag');
  });

  it(`OMK_LANG=en_US ambient 不让 oclif parse exit 2(走 legacy fallback)`, async () => {
    // legacy getCliLang 对不支持的 OMK_LANG 值 fallback to zh,oclif lang flag
    // 不应该把 env 当 enum 校验。回归 PR #120 引入的 env: 'OMK_LANG' 写法。
    const env = { ...process.env, OMK_LANG: 'en_US' };
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env });
    assert.ok(stdout.includes('\nUSAGE\n'), 'doctor --help should succeed under OMK_LANG=en_US, got: ' + stdout.slice(0, 200));
  });

  it(`omk eval gold --lang en 打英文 usage(显式 lang flag 生效)`, async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', 'gold', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}`);
      const out = e.stdout + e.stderr;
      assert.ok(/manage human-gold/i.test(out), `expected en usage, got:\n${out.slice(0, 200)}`);
      assert.ok(!out.includes('管理 human-gold'), 'en mode should not leak zh usage');
    }
  });
});
