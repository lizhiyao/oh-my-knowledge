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
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `--judge-models` 参数错误(空 / 缺 executor / 缺 model / 重复 entry)在 CLI
 * 层走和 `parseArgsStrict` 对 unknown option 一致的路径:`error: <msg>` to
 * stderr + exit 2(parser/参数错误,区别于 doctor / gate eval failure 的 exit 1)。
 *
 * 不应漏给未捕获 Error 的 stack trace;不应 exit 1。
 */
// bench run / gate 共享 parseRunConfig,需要 control/treatment 才能跑到 judgeModels 解析。
// 三个 standalone 子命令在自己的 handler 里直接调 parseJudgeModelsArgOrExit,无前置依赖。
const CASES: Array<{ name: string; argv: string[] }> = [
  {
    name: 'bench run',
    argv: ['bench', 'run', '--control', 'baseline', '--treatment', 'v1', '--skill-dir', 'examples/code-review/skills', '--dry-run'],
  },
  {
    name: 'bench evolve',
    argv: ['bench', 'evolve', 'examples/code-review/skills/v1.md', '--rounds', '1', '--skip-connectivity'],
  },
  {
    name: 'bench debias-validate',
    argv: ['bench', 'debias-validate', 'length', 'fake-report-id'],
  },
  {
    name: 'bench failures',
    argv: ['bench', 'failures', 'fake-report-id'],
  },
];

describe('--judge-models validation: CLI exits 2 with friendly error', () => {
  it.each(CASES)('omk $name --judge-models <duplicate> exits 2 with friendly error', async ({ argv }) => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, ...argv, '--judge-models', 'claude:haiku,claude:haiku']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2, `expected exit 2, got ${e.code}; stderr: ${e.stderr.slice(0, 300)}`);
        assert.ok(
          e.stderr.startsWith('error:'),
          `stderr should start with "error:", got: ${e.stderr.slice(0, 200)}`,
        );
        assert.ok(
          e.stderr.includes('duplicate') && e.stderr.includes('claude:haiku'),
          `stderr should mention duplicate entry: ${e.stderr.slice(0, 200)}`,
        );
        // 关键不变量:不能 leak Error stack trace。
        assert.ok(
          !/^\s*at\s/m.test(e.stderr),
          `stderr should NOT include stack trace ("at " frame): ${e.stderr.slice(0, 400)}`,
        );
        return true;
      },
    );
  });

  it('omk bench run --judge-models <missing executor> exits 2 with friendly error', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'bench', 'run', '--control', 'baseline', '--treatment', 'v1', '--skill-dir', 'examples/code-review/skills', '--dry-run', '--judge-models', ':haiku']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.startsWith('error:'));
        assert.ok(e.stderr.includes(`'executor:model'`));
        return true;
      },
    );
  });

  it('omk bench run --judge-models "" (empty) exits 2 with friendly error', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'bench', 'run', '--control', 'baseline', '--treatment', 'v1', '--skill-dir', 'examples/code-review/skills', '--dry-run', '--judge-models', '']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.startsWith('error:'));
        assert.ok(e.stderr.includes('cannot be empty'));
        return true;
      },
    );
  });
});
