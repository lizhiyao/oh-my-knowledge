import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CLI = join(PROJECT_ROOT, 'dist', 'src', 'cli', 'index.js');

describe('CLI', () => {
  it('--help shows usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, '--help']);
    assert.ok(stdout.includes('oh-my-knowledge'));
    assert.ok(stdout.includes('omk bench run'));
    assert.ok(stdout.includes('omk bench report'));
    assert.ok(stdout.includes('omk bench init'));
  });

  it('bench --help shows usage', async () => {
    const { stdout } = await execFileAsync('node', [CLI, 'bench', '--help']);
    assert.ok(stdout.includes('oh-my-knowledge'));
  });

  it('unknown domain exits with error (--lang en)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'unknown', '--lang', 'en']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('Unknown domain'));
        return true;
      },
    );
  });

  it('unknown domain in zh (default) prints 中文', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'unknown']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('未知顶层命令'));
        return true;
      },
    );
  });

  it('unknown bench command exits with error (--lang en)', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'bench', 'unknown', '--lang', 'en']),
      (err: unknown) => {
        assert.ok((err as { stderr: string }).stderr.includes('Unknown bench command'));
        return true;
      },
    );
  });

  it('bench run --dry-run produces valid JSON', async () => {
    const samplesPath = join(PROJECT_ROOT, 'examples', 'code-review', 'eval-samples.json');
    const skillDir = join(PROJECT_ROOT, 'examples', 'code-review', 'skills');
    const { stdout } = await execFileAsync('node', [
      CLI, 'bench', 'run',
      '--dry-run',
      '--samples', samplesPath,
      '--skill-dir', skillDir,
      '--control', 'v1',
      '--treatment', 'v2',
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.totalTasks, 6);
  });
});
