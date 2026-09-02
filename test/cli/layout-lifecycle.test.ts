import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'vitest';
import CleanCommand from '../../src/cli/commands/clean.js';
import { projectLayout } from '../../src/omk-layout/index.js';
import { runCommand, type CommandRunError } from '../helpers/run-command.js';

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'data');
}

describe('layout lifecycle CLI', () => {
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

  it('composes an explicit governance selection with --all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'omk-cli-clean-all-governance-'));
    const layout = projectLayout(cwd);
    touch(join(layout.tmpDir, 'scratch'));
    touch(join(layout.managedDir, 'record.json'));

    await assert.rejects(
      () => runCommand(CleanCommand, ['--all', '--governance'], { cwd }),
      (error: CommandRunError) => error.code === 2 && /--force/.test(error.stderr),
    );
    assert.equal(existsSync(layout.managedDir), true);

    await runCommand(CleanCommand, ['--all', '--governance', '--force'], { cwd });
    assert.equal(existsSync(layout.stateDir), false);
    assert.equal(existsSync(layout.managedDir), false);
  });
});
