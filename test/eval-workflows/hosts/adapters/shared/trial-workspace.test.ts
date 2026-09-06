import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeTrialWorkspace } from '../../../../../src/eval-workflows/hosts/adapters/shared/trial-workspace.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'omk-trial-workspace-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Node trial workspace ownership', () => {
  it('isolates concurrent trials, preserves executability, and never mutates the base', async () => {
    const baseSnapshotPath = join(root, 'base');
    await mkdir(baseSnapshotPath);
    await writeFile(join(baseSnapshotPath, 'run.sh'), 'original', { mode: 0o500 });
    await chmod(baseSnapshotPath, 0o500);
    const input = { parentRoot: root, baseSnapshotPath, signal: new AbortController().signal };
    const [first, second] = await Promise.all([
      openNodeTrialWorkspace(input), openNodeTrialWorkspace(input),
    ]);
    try {
      await writeFile(join(first.workingDirectory, 'run.sh'), 'changed');
      await writeFile(join(first.workingDirectory, 'marker'), 'trial one');
      expect(await readFile(join(second.workingDirectory, 'run.sh'), 'utf8')).toBe('original');
      expect(await readFile(join(baseSnapshotPath, 'run.sh'), 'utf8')).toBe('original');
      expect((await stat(join(second.workingDirectory, 'run.sh'))).mode & 0o100).toBe(0o100);
      expect(await readdir(second.workingDirectory)).toEqual(['run.sh']);
      await first.close();
      expect(await readdir(second.workingDirectory)).toEqual(['run.sh']);
    } finally {
      await Promise.all([first.close(), second.close()]);
      await chmod(baseSnapshotPath, 0o700);
    }
    expect(await readdir(root)).toEqual(['base']);
  });

  it('starts each unbound trial empty and releases it idempotently', async () => {
    const input = { parentRoot: root, signal: new AbortController().signal };
    const first = await openNodeTrialWorkspace(input);
    await writeFile(join(first.workingDirectory, 'marker'), 'written');
    await Promise.all([first.close(), first.close()]);
    const second = await openNodeTrialWorkspace(input);
    try {
      expect(second.workingDirectory).not.toBe(first.workingDirectory);
      expect(await readdir(second.workingDirectory)).toEqual([]);
    } finally {
      await second.close();
    }
    expect(await readdir(root)).toEqual([]);
  });

  it('cleans partial copies and rejects cancellation before allocating', async () => {
    const baseSnapshotPath = join(root, 'base');
    await mkdir(baseSnapshotPath);
    await writeFile(join(baseSnapshotPath, 'a-file'), 'data');
    await symlink(join(baseSnapshotPath, 'a-file'), join(baseSnapshotPath, 'z-link'));
    await expect(openNodeTrialWorkspace({
      parentRoot: root, baseSnapshotPath, signal: new AbortController().signal,
    })).rejects.toThrow('unsupported entry');
    const duringAllocation = new AbortController();
    const pending = openNodeTrialWorkspace({ parentRoot: root, signal: duringAllocation.signal });
    duringAllocation.abort(new Error('cancel during allocation'));
    await expect(pending).rejects.toThrow('cancel during allocation');
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    await expect(openNodeTrialWorkspace({ parentRoot: root, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(await readdir(root)).toEqual(['base']);
  });
});
