/**
 * oclif dispatcher 分流验收。
 * 验证 OMK_CLI_NEXT 这个 env switch 行为正确:
 * - 未设/为空 → 走 legacy dispatcher,行为跟现状一致
 * - =1 + 已迁命令(doctor / sample)→ 走 oclif
 * - =1 + 未迁命令 → 报「command not found」exit 1,跟 legacy unknown_domain 对得齐
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

// 不在 OCLIF_ENV 里 set OMK_CLI_NEXT,vs OMK_CLI_NEXT=1 set,vs OMK_CLI_NEXT=''(空)
const LEGACY_ENV = { ...process.env };
delete LEGACY_ENV.OMK_CLI_NEXT;
const OCLIF_ENV = { ...process.env, OMK_CLI_NEXT: '1' };
const EMPTY_ENV = { ...process.env, OMK_CLI_NEXT: '' };

describe('OMK_CLI_NEXT dispatcher 分流', () => {
  it('未设 env 走 legacy(doctor --help 含 cli.help.doctor_usage 的 prose)', async () => {
    // legacy doctor --help 走 i18n-dict.cli.help.doctor_usage,一段手写完整 prose
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env: LEGACY_ENV });
    // legacy prose 是手写完整段(多行,含 omk doctor 这种用法举例 + flag 说明)
    // oclif --help 输出风格是 USAGE / FLAGS / DESCRIPTION 这种结构化 block
    // 通过判断有没有 oclif 的 USAGE 关键字区分(legacy 没有 USAGE 顶头大写)
    assert.ok(!stdout.includes('\nUSAGE\n'), 'legacy --help should not have oclif USAGE block');
  });

  it('env=\'\'(空)也走 legacy(只有 ===\'1\' 才切 oclif)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env: EMPTY_ENV });
    assert.ok(!stdout.includes('\nUSAGE\n'), 'empty env should fall through to legacy');
  });

  it('env=1 doctor --help 走 oclif(有 USAGE block)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help'], { env: OCLIF_ENV });
    assert.ok(stdout.includes('\nUSAGE\n'), `oclif --help should have USAGE block:\n${stdout.slice(0, 200)}`);
  });

  it('env=1 + 未迁命令 → exit 1(跟 legacy unknown_domain 对得齐)', async () => {
    try {
      await execFileAsync('node', [CLI, 'nope-command'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1 for unknown command, got ${e.code}`);
    }
  });

  it('env=1 + eval (legacy 才支持,oclif 路径未迁) → command not found exit 1', async () => {
    // PR-B 只迁 doctor + sample,eval 还在 legacy 里。
    // OMK_CLI_NEXT=1 + eval → oclif 找不到 eval command,exit 1。
    try {
      await execFileAsync('node', [CLI, 'eval'], { env: OCLIF_ENV });
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 1, `expected exit 1, got ${e.code}`);
    }
  });
});
