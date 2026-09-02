import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import CleanCommand from '../../src/cli/commands/clean.js';
import MigrateCommand from '../../src/cli/commands/migrate.js';
import { projectLayout } from '../../src/omk-layout/index.js';
import { runCommand, type CommandRunError } from '../helpers/run-command.js';

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'data');
}

describe('layout lifecycle CLI', () => {
  it('previews migration without writes, then applies it idempotently', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-cli-migrate-'));
    const source = join(cwd, '.omk', 'reports', 'legacy', 'manifest.json');
    touch(source);

    const preview = await runCommand(MigrateCommand, ['--dry-run', '--json'], { cwd });
    const previewJson = JSON.parse(preview.stdout) as { plan: { actions: unknown[] } };
    assert.equal(previewJson.plan.actions.length, 1);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(projectLayout(cwd).markerPath), false);

    const applied = await runCommand(MigrateCommand, ['--json'], { cwd });
    const appliedJson = JSON.parse(applied.stdout) as { result: { movedFiles: number } };
    assert.equal(appliedJson.result.movedFiles, 1);
    assert.equal(existsSync(join(projectLayout(cwd).evalDir, 'legacy', 'manifest.json')), true);

    const repeated = await runCommand(MigrateCommand, ['--json'], { cwd });
    const repeatedJson = JSON.parse(repeated.stdout) as { result: { movedFiles: number } };
    assert.equal(repeatedJson.result.movedFiles, 0);
  });

  it('cleans state by default and requires force for observations', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-cli-clean-'));
    const layout = projectLayout(cwd);
    touch(join(layout.tmpDir, 'scratch'));
    touch(join(layout.evalDir, 'kept', 'report.json'));
    touch(join(layout.observeInboxReportsDir, 'sensitive.report.json'));

    await runCommand(CleanCommand, ['--json'], { cwd });
    assert.equal(existsSync(layout.stateDir), false);
    assert.equal(existsSync(layout.evalDir), true);
    assert.equal(existsSync(layout.observeInboxDir), true);

    await assert.rejects(
      () => runCommand(CleanCommand, ['--observations'], { cwd }),
      (error: CommandRunError) => error.code === 2 && /--force/.test(error.stderr),
    );
    assert.equal(existsSync(layout.observeInboxDir), true);
    await runCommand(CleanCommand, ['--observations', '--force'], { cwd });
    assert.equal(existsSync(layout.observeInboxDir), false);
  });
});
