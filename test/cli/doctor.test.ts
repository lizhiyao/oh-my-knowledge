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
const EXAMPLE_SKILL = join(PROJECT_ROOT, 'examples', 'code-review', 'skills', 'v1.md');
const EXAMPLE_SKILLS_DIR = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');

interface ExecError extends Error {
  code: number;
  stdout: string;
  stderr: string;
}

describe('omk doctor CLI', () => {
  it('--help shows usage with key flags and check items', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help']);
    assert.ok(stdout.includes('omk doctor'));
    assert.ok(stdout.includes('健康检查'));
    assert.ok(stdout.includes('--json'));
    assert.ok(stdout.includes('--gate'));
  });

  it('--help --lang en shows English usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'doctor', '--help', '--lang', 'en']);
    assert.ok(stdout.includes('omk doctor'));
    assert.ok(stdout.includes('health check'));
    assert.ok(!stdout.includes('健康检查'));
  });

  it('--json on example skill outputs valid DoctorReport with kind=doctor', async () => {
    const { stdout } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
      '--json',
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'doctor');
    assert.ok(Array.isArray(parsed.skills));
    assert.ok(parsed.skills.length >= 1);
    assert.equal(parsed.failed, false);
  });

  it('--json on directory batches all skills', async () => {
    const { stdout } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILLS_DIR,
      '--json',
    ]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.kind, 'doctor');
    assert.ok(parsed.skills.length >= 2, 'should batch multiple skills from the dir');
  });

  it('--gate exits 1 on non-existent target', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'doctor', '/tmp/__nonexistent_doctor_target__', '--gate']),
      (err: unknown) => {
        const e = err as ExecError;
        assert.equal(e.code, 1);
        return true;
      },
    );
  });

  it('--gate exits 0 on passing skill', async () => {
    const { stderr } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
      '--gate',
    ]);
    // Pass case: stdout silent, stderr should not contain "doctor failed:"
    assert.ok(!stderr.includes('doctor failed:'));
  });

  it('exits 1 when doctor reports failed (skill content too short)', async () => {
    // Use a tiny one-line file that would fail skill_readable rule
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmp = mkdtempSync(join(tmpdir(), 'doctor-cli-fail-'));
    try {
      const tinyPath = join(tmp, 'tiny.md');
      writeFileSync(tinyPath, 'hi');
      await assert.rejects(
        () => execFileAsync('node', [CLI, 'doctor', tinyPath, '--gate']),
        (err: unknown) => {
          const e = err as ExecError;
          assert.equal(e.code, 1);
          assert.ok(e.stderr.includes('doctor failed:'));
          return true;
        },
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('default (no flags) renders human-readable text to stderr', async () => {
    const { stderr } = await execFileAsync('node', [
      CLI,
      'doctor',
      EXAMPLE_SKILL,
    ]);
    assert.ok(stderr.includes('健康检查'));
    assert.ok(stderr.includes('总览:'));
  });

  it('domain dispatch: omk doctor is treated as a top-level domain like analyze', async () => {
    // Verify --help mentions doctor as a domain
    const { stdout } = await execFileAsync('node', [CLI, '--help']);
    assert.ok(stdout.includes('omk doctor'));
  });
});
