import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { replaceDeployedArtifact } from '../../../src/knowledge-artifacts/sources/deploy-artifact.js';

const faults = vi.hoisted(() => ({ copy: false, commit: false, restore: false, cleanup: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    rmSync: (...args: Parameters<typeof fs.rmSync>) => {
      if (faults.cleanup && String(args[0]).includes('.omk-install-')) throw new Error('cleanup failed');
      return fs.rmSync(...args);
    },
    cpSync: (...args: Parameters<typeof fs.cpSync>) => {
      if (faults.copy) throw new Error('copy failed');
      return fs.cpSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.commit && String(args[0]).endsWith('/next')) throw new Error('commit failed');
      if (faults.restore && String(args[0]).endsWith('/previous')) throw new Error('restore failed');
      return fs.renameSync(...args);
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  faults.copy = faults.commit = faults.restore = faults.cleanup = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-deploy-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'installed');
  for (const path of [source, target]) mkdirSync(path);
  writeFileSync(join(source, 'SKILL.md'), 'new');
  writeFileSync(join(target, 'SKILL.md'), 'old');
  return { root, source, target };
}

it.each(['copy', 'commit'] as const)('retains the previous installation after %s failure and cleans staging', (phase) => {
  const { root, source, target } = fixture();
  faults[phase] = true;
  expect(() => replaceDeployedArtifact(source, target, true, true)).toThrow(`${phase} failed`);
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
  expect(readdirSync(root).sort()).toEqual(['installed', 'source']);
});

it('preserves the backup and recovery location if rollback also fails', () => {
  const { root, source, target } = fixture();
  faults.commit = faults.restore = true;
  expect(() => replaceDeployedArtifact(source, target, true, true)).toThrow(/restore the previous artifact/);
  const staging = readdirSync(root).find((name) => name.startsWith('.omk-install-'))!;
  expect(readFileSync(join(root, staging, 'previous', 'SKILL.md'), 'utf8')).toBe('old');
});

it('publishes the full filtered replacement without keeping obsolete files', () => {
  const { root, source, target } = fixture();
  writeFileSync(join(target, 'obsolete.md'), 'old asset');
  mkdirSync(join(source, '.omk'));
  writeFileSync(join(source, '.omk', 'private.json'), '{}');
  replaceDeployedArtifact(source, target, true, true);
  expect(readdirSync(target)).toEqual(['SKILL.md']);
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
  expect(readdirSync(root).sort()).toEqual(['installed', 'source']);
});

it('reports cleanup failure separately after a successful deployment', () => {
  const { source, target } = fixture();
  faults.cleanup = true;
  const result = replaceDeployedArtifact(source, target, true, true);
  expect(result.cleanupWarning).toContain('.omk-install-');
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('new');
});


it('rechecks replacement permission at commit and preserves a target without --force', () => {
  const { root, source, target } = fixture();
  expect(() => replaceDeployedArtifact(source, target, true)).toThrow(/--force/);
  expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toBe('old');
  expect(readdirSync(root).sort()).toEqual(['installed', 'source']);
});
