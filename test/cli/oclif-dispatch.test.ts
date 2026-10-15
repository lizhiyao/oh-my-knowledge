/**
 * oclif dispatcher 验收。验证所有命令都走 oclif:
 * - 未知命令 → exit 1(oclif.exitCodes.default = 1)
 * - 已知命令 --help 有 oclif 风格的 USAGE block
 * - colon-syntax(omk eval:gold:init)跟 space-syntax 一致,flag 不丢
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, runCliFailing } from '../helpers/cli-process.js';

describe('oclif dispatcher', () => {
  it('eval --help 走 oclif', async () => {
    const { stdout } = await runCli(['eval', '--help']);
    assert.ok(stdout.includes('\nUSAGE\n'), 'expected oclif USAGE block');
    assert.ok(stdout.includes('--control'), 'should list --control flag');
  });

  it('dispatcher 区分未知命令与枚举、缺参校验失败，且不输出堆栈', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-dispatch-errors-'));
    try {
      for (const [args, code] of [
        [['nope-command'], 1],
        [['agents', 'bogus-op'], 2],
        [['install', 'omk-agent-skill', '--kind', 'bogus'], 2],
        [['evolve', 'missing.md', '--improve-mode', 'bogus'], 2],
        [['init', '--samples', '5'], 2],
        [['observe'], 2],
        [['observe', 'knowledge', 'bogus'], 2],
      ] as const) {
        const { stderr } = await runCliFailing([...args], code, { cwd: dir, env: { ...process.env, OMK_SKIP_UPDATE_CHECK: '1', OMK_DEBUG: '' } });
        assert.ok(stderr.trim(), args.join(' '));
        assert.doesNotMatch(stderr, /\n\s+at /);
      }
      assert.equal(existsSync(join(dir, '.omk')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('业务失败只输出可读诊断，OMK_DEBUG 显式启用堆栈', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-dispatch-business-'));
    const env = { ...process.env, OMK_SKIP_UPDATE_CHECK: '1', OMK_DEBUG: '' };
    try {
      await mkdir(join(dir, 'dest', 'omk'), { recursive: true });
      await writeFile(join(dir, 'eval-samples.json'), 'preserve');
      for (const args of [
        ['install', 'does-not-exist-xyz'],
        ['install', 'omk-agent-skill', '--dest', join(dir, 'dest')],
        ['eval', '--config', join(dir, 'missing.yaml')],
        ['init', dir],
      ]) {
        const { stderr } = await runCliFailing(args, 1, { cwd: dir, env });
        assert.ok(stderr.trim(), args.join(' '));
        assert.doesNotMatch(stderr, /\n\s+at /);
      }
      assert.equal(await readFile(join(dir, 'eval-samples.json'), 'utf8'), 'preserve');
      const { stderr } = await runCliFailing(['install', 'does-not-exist-xyz'], 1, { cwd: dir, env: { ...env, OMK_DEBUG: '1' } });
      assert.match(stderr, /\n\s+at /);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('colon-syntax(omk eval:gold:init)跟 space-syntax 等价,flag 不丢', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omk-colon-syntax-'));
    try {
      const out = join(dir, 'gold-colon');
      // colon-syntax:argv = [..., 'eval:gold:init', '--out', out]
      // 关键回归点:this.argv 应当切到子命令后,等价于 ['--out', out]。
      // process.argv.slice(5) 会切错把 '--out' 切掉。
      await runCli(['eval:gold:init', '--out', out]);
      assert.ok(
        existsSync(join(out, 'metadata.yaml')),
        `--out should land at ${out}/metadata.yaml; if missing, flag was silently dropped`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
