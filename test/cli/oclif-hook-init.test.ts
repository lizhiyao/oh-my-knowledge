/**
 * oclif init hook + 顶层 --lang scan 验收。
 *
 * 锁两个 #121 收口项:
 *   #5 错误路径双语 dump:`omk <cmd> --bogus-flag` 错误时 oclif 内部硬编码
 *      `new Help(config)` 不走 LangAwareHelp,但 init hook 已经在 Command.Loadable
 *      上 in-place mutate 单语,所以 dump 出来的 FLAGS / USAGE 单语。
 *   #6 顶层 --lang 跨子命令边界:`omk --lang en eval --help` 跟 `omk eval --lang en --help`
 *      行为等价,都走子命令的英文 help 而不是退化到 root help。
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

describe('oclif init hook + 顶层 --lang scan(#5 / #6)', () => {
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

  it('#6: omk --lang en eval --help 走子命令英文 help(不退化到 root)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--lang', 'en', 'eval', '--help']);
    // eval --help 英文 description 关键词
    assert.ok(/Run evaluation:/i.test(stdout), `应走 eval 英文 help,实际:\n${stdout.slice(0, 300)}`);
    // 退化到 root 时 description 会变成 "Evaluation framework for LLM..."
    assert.ok(
      !/Evaluation framework for LLM/.test(stdout),
      `不应退化到 root help:\n${stdout.slice(0, 300)}`,
    );
    // eval 子命令的 USAGE 行特征
    assert.ok(/\$ omk eval/.test(stdout), `USAGE 应是 \`$ omk eval ...\`,实际:\n${stdout.slice(0, 300)}`);
  });

  it('#6: omk --lang=en eval --help 等号形态也工作', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--lang=en', 'eval', '--help']);
    assert.ok(/Run evaluation:/i.test(stdout), `应走 eval 英文 help,实际:\n${stdout.slice(0, 300)}`);
  });

  it('#6: omk eval --lang en --help 已工作的形态保留', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--lang', 'en', '--help']);
    assert.ok(/Run evaluation:/i.test(stdout), `应走 eval 英文 help,实际:\n${stdout.slice(0, 300)}`);
  });

  it('默认 zh: omk eval --help 仍打中文(回归)', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'eval', '--help']);
    assert.ok(/跑评测/.test(stdout), `应走 eval 中文 help,实际:\n${stdout.slice(0, 300)}`);
  });
});
