import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'cli.mjs');

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

  it('unknown domain exits with error', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'unknown']),
      (err) => {
        assert.ok(err.stderr.includes('Unknown domain'));
        return true;
      },
    );
  });

  it('unknown bench command exits with error', async () => {
    await assert.rejects(
      () => execFileAsync('node', [CLI, 'bench', 'unknown']),
      (err) => {
        assert.ok(err.stderr.includes('Unknown command'));
        return true;
      },
    );
  });

  it('bench run --dry-run produces valid JSON', async () => {
    const samplesPath = join(__dirname, '..', 'examples', 'code-review', 'eval-samples.json');
    const skillDir = join(__dirname, '..', 'examples', 'code-review', 'skills');
    const { stdout } = await execFileAsync('node', [
      CLI, 'bench', 'run',
      '--dry-run',
      '--samples', samplesPath,
      '--skill-dir', skillDir,
    ]);
    const report = JSON.parse(stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.totalTasks, 6);
  });
});
