/**
 * oclif init hook 错误路径单语 dump 验收。
 *
 * #5 错误路径双语 dump:`omk <cmd> --bogus-flag` 错误时 oclif 内部硬编码
 *    `new Help(config)` 不走 LangAwareHelp,但 init hook 已经在 Command.Loadable
 *    上 in-place mutate 单语,所以 dump 出来的 FLAGS / USAGE 单语。
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

describe('oclif init hook 错误路径单语 dump(#5)', () => {
  it('#5: eval --bogus-flag 错误路径 FLAGS dump 单语(zh 默认)', async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', '--bogus-flag']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2, `expected exit 2, got ${e.code}`);
      const out = e.stdout + e.stderr;
      // 命中 zh 关键词 + 不命中 en 关键词(双语 dump 的特征:中英行紧挨)
      assert.ok(/batch 模式/.test(out), `dump 应含 zh flag description:\n${out.slice(0, 400)}`);
      assert.ok(!/Batch mode: baseline/.test(out), `dump 不应同时含 en flag description(双语并列):\n${out.slice(0, 400)}`);
    }
  });

  it('#5: eval --bogus-flag --lang en 错误路径 FLAGS dump 单语(en)', async () => {
    try {
      await execFileAsync('node', [CLI, 'eval', '--bogus-flag', '--lang', 'en']);
      assert.fail('expected non-zero exit');
    } catch (err) {
      const e = err as ExecError;
      assert.equal(e.code, 2);
      const out = e.stdout + e.stderr;
      assert.ok(/Batch mode/.test(out), `dump 应含 en flag description:\n${out.slice(0, 400)}`);
      assert.ok(!/batch 模式/.test(out), `dump 不应同时含 zh flag description:\n${out.slice(0, 400)}`);
    }
  });

  it('omk eval --lang en --help 子命令 --lang 走英文 help', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--lang', 'en', '--help']);
    assert.ok(/Run evaluation:/i.test(stdout), `应走 eval 英文 help,实际:\n${stdout.slice(0, 300)}`);
  });

  it('默认 zh: omk eval --help 仍打中文(回归)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help']);
    assert.ok(/跑评测/.test(stdout), `应走 eval 中文 help,实际:\n${stdout.slice(0, 300)}`);
  });
});
