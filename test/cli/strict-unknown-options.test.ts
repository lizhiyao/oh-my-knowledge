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
 * eval / doctor / observe / evolve / sample 用 parseArgs strict:true。
 * 任何未声明的 flag (含已删除的 --skip-doctor / --skip-preflight / --skip-smoke)
 * 都会 fail with Unknown option, 不静默吞掉。
 *
 * exit 2 = parser 失败 (区分 doctor / gate eval failure 用的 exit 1)。
 */
describe('strict unknown option rejection', () => {
  it('omk eval --skip-doctor exits 2 with Unknown option', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'eval', '--skip-doctor', '--dry-run']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2, 'unknown option should exit 2');
        assert.ok(
          e.stderr.includes('Unknown option') && e.stderr.includes('--skip-doctor'),
          `stderr should name unknown option: ${e.stderr.slice(0, 300)}`,
        );
        return true;
      },
    );
  });

  it('omk eval --skip-preflight (renamed) exits 2 with Unknown option', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'eval', '--skip-preflight', '--dry-run']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(
          e.stderr.includes('Unknown option') && e.stderr.includes('--skip-preflight'),
          `stderr should name unknown option: ${e.stderr.slice(0, 300)}`,
        );
        return true;
      },
    );
  });

  it('omk sample --bogus exits 2 before generation work', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'sample', 'skills/v1.md', '--bogus']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(
          e.stderr.includes('Unknown option') && e.stderr.includes('--bogus'),
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
          e.stderr.includes('Unknown option') && e.stderr.includes('--skip-smoke'),
          `stderr should name unknown option: ${e.stderr.slice(0, 300)}`,
        );
        return true;
      },
    );
  });

  it('arbitrary unknown flag also rejected (not just deprecated ones)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'eval', '--no-such-flag', '--dry-run']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.includes('Unknown option'), `stderr: ${e.stderr.slice(0, 300)}`);
        return true;
      },
    );
  });

  it('omk evolve --bogus-flag exits 2 (sanity: helper covers evolve handler)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'evolve', 'skills/v1.md', '--bogus-flag']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.includes('Unknown option') && e.stderr.includes('--bogus-flag'));
        return true;
      },
    );
  });

  it('omk observe --bogus-flag exits 2 (sanity: helper covers observe handler)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'observe', '/tmp/some-path', '--bogus-flag']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.includes('Unknown option'));
        return true;
      },
    );
  });

  it('omk init --bogus exits 2 (init goes through helper now)', async () => {
    // 之前 handleInit 直接 argv[0] 当目录名, --bogus 被当成 dir 名写文件 (静默 garbage)。
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'init', '--bogus']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 2);
        assert.ok(e.stderr.includes('Unknown option') && e.stderr.includes('--bogus'));
        return true;
      },
    );
  });

  it('omk eval with valid flags still works (regression)', async () => {
    // 健康路径不被 strict 误伤: --dry-run / --skip-connectivity 等合法 flag 必须通过。
    const SAMPLES = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
    const SKILLS = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');
    const { stdout } = await execFileAsync('node', [
      CLI, 'eval',
      '--samples', SAMPLES,
      '--skill-dir', SKILLS,
      '--control', 'v1',
      '--treatment', 'v2',
      '--dry-run',
      '--skip-connectivity',
      '--lang', 'zh',
    ]);
    assert.ok(stdout.includes('eval dry-run'));
  });
});
