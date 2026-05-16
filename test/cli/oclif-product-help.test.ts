/**
 * `omk`(无子命令)入口 — 打 cli.help.product_main 双语 prose。
 *
 * PR-C 删 legacy dispatcher 后,bare `omk` 退化成 oclif 默认 VERSION/USAGE/
 * TOPICS/COMMANDS 表格,中文用户和新用户都受影响。本 PR 在 src/cli/index.ts
 * 增加 isBareInvocation 检测,把 product_main prose(legacy 留下的双语
 * i18n key)接回这条入口。oclif --help / sub-command --help / unknown sub 等
 * 其它路径行为不变,仍由 oclif 自己处理。
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

describe('omk bare invocation prints product_main prose', () => {
  it('bare `omk` prints zh prose (default lang)', async () => {
    const { stdout } = await execFileAsync('node', [CLI]);
    assert.ok(stdout.includes('知识载体工作台'), `expected zh title: ${stdout.slice(0, 200)}`);
    assert.ok(stdout.includes('用法'), 'must include 用法 section');
    assert.ok(stdout.includes('主路径'), 'must include 主路径 section');
    assert.ok(stdout.includes('omk init'), 'must list omk init');
    assert.ok(stdout.includes('omk eval'), 'must list omk eval');
    assert.ok(stdout.includes('omk evolve'), 'must list omk evolve');
    assert.ok(!stdout.includes('VERSION'), 'should not show oclif VERSION block (legacy prose only)');
  });

  it('`omk --lang en` prints English prose', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--lang', 'en']);
    assert.ok(
      stdout.includes('Knowledge Artifact Workbench'),
      `expected en title: ${stdout.slice(0, 200)}`,
    );
    assert.ok(stdout.includes('Usage:'), 'must include Usage section');
    assert.ok(stdout.includes('Main workflow:'), 'must include Main workflow section');
    assert.ok(!stdout.includes('知识载体工作台'), 'zh title should not appear');
  });

  it('`omk --lang=en` (= form) also picks en', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--lang=en']);
    assert.ok(stdout.includes('Knowledge Artifact Workbench'), `expected en: ${stdout.slice(0, 200)}`);
  });

  it('OMK_LANG=en env var picks en', async () => {
    const { stdout } = await execFileAsync('node', [CLI], {
      env: { ...process.env, OMK_LANG: 'en' },
    });
    assert.ok(stdout.includes('Knowledge Artifact Workbench'), `expected en from env: ${stdout.slice(0, 200)}`);
  });

  it('bare omk exits 0', async () => {
    const { stdout } = await execFileAsync('node', [CLI]);
    assert.ok(stdout.length > 0);
    // execFileAsync 不 reject = exit 0
  });

  it('`omk --help` still goes through oclif (USAGE/COMMANDS block,非 product_main prose)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--help']);
    assert.ok(stdout.includes('USAGE'), 'must include oclif USAGE block');
    assert.ok(stdout.includes('COMMANDS'), 'must include oclif COMMANDS block');
    // 不应包含 product_main 的「主路径」关键字 — --help 是 oclif 路径
    assert.ok(!stdout.includes('主路径'), '--help should NOT print product_main prose');
  });

  it('`omk doctor` still routes to oclif Doctor Command (regression)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help']);
    assert.ok(stdout.includes('USAGE'), 'doctor --help should still work');
    assert.ok(stdout.includes('--gate') || stdout.includes('gate'), 'doctor --help should list --gate flag');
  });

  it('unknown command still exits non-zero via oclif (regression)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'nope-command-xyz']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1, `expected exit 1 for unknown command, got ${e.code}`);
        return true;
      },
    );
  });
});
