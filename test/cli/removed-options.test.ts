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
const CUSTOM_EXECUTOR = join(
  PROJECT_ROOT,
  'test',
  'fixtures',
  'custom-executor',
  'core-fixture-executor.sh',
);

interface ExecError extends Error {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 锁住已经删除或改名的历史 flag，避免以后被静默重新接受。
 *
 * 注意: --skip-doctor 在 v0.30 重新作为 escape hatch 引入,合法 flag 见 RUN_OPTIONS。
 *
 * exit 2 = parser 失败 (区分 doctor / gate eval failure 用的 exit 1)。
 */
describe('removed CLI options', () => {
  it('omk eval --skip-preflight (renamed) exits 2 with Unknown option', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'eval', '--skip-preflight', '--dry-run']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(
          e.stderr.includes('Nonexistent flag') && e.stderr.includes('--skip-preflight'),
          `stderr should name unknown option: ${e.stderr.slice(0, 300)}`,
        );
        return true;
      },
    );
  });

  it('omk doctor --skip-smoke exits 2 with Unknown option', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'doctor', '--skip-smoke']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(
          e.stderr.includes('Nonexistent flag') && e.stderr.includes('--skip-smoke'),
          `stderr should name unknown option: ${e.stderr.slice(0, 300)}`,
        );
        return true;
      },
    );
  });

  it('omk evolve rejects removed legacy-report reuse during argument parsing', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'evolve', 'skill.md', '--reuse-latest-eval']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.includes('--reuse-latest-eval'));
        return true;
      },
    );
  });

  it('omk eval --skip-doctor parses as valid flag (escape hatch)', async () => {
    // --skip-doctor 是 v0.30 重新引入的 escape hatch (parse-run-config 注册);
    // strict:true 下必须能被识别,不报 Unknown option。
    const SAMPLES = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'eval-samples.json');
    const SKILLS = join(PROJECT_ROOT, 'test', 'fixtures', 'code-review', 'skills');
    const { stdout, stderr } = await execFileAsync('node', [
      CLI, 'eval',
      '--samples', SAMPLES,
      '--skill-dir', SKILLS,
      '--control', 'v1',
      '--treatment', 'v2',
      '--executor', CUSTOM_EXECUTOR,
      '--no-judge',
      '--dry-run',
      '--skip-connectivity',
      '--skip-doctor',
      '--lang', 'zh',
    ]);
    assert.equal(JSON.parse(stdout).projectionKind, 'core-cli-dry-run', 'dry-run reaches Core planning output');
    assert.ok(stderr.includes('--skip-doctor'), 'stderr emits the escape-hatch warning');
  });
});
