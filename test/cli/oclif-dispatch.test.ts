/**
 * oclif dispatcher 验收。验证所有命令都走 oclif:
 * - 未知命令 → exit 1(oclif.exitCodes.default = 1)
 * - 已知命令 --help 有 oclif 风格的 USAGE block
 * - colon-syntax(omk eval:gold:init)跟 space-syntax 一致,flag 不丢
 */
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

  it('未知命令 → exit 1', async () => {
    await runCliFailing(['nope-command'], 1);
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
