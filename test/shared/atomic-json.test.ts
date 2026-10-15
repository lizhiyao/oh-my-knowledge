import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonFileAtomic } from '../../src/shared/atomic-json.js';
import { writeTextFileAtomic } from '../../src/evidence/storage/atomic-text.js';
import { hashArtifactSource } from '../../src/knowledge-artifacts/sources/content-hash.js';

const fault = vi.hoisted(() => ({
  beforePublish: undefined as ((path: string) => void) | undefined,
  beforeReplace: undefined as ((source: string, target: string) => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    linkSync: (source: string, target: string) => {
      fault.beforePublish?.(target);
      return fs.linkSync(source, target);
    },
    renameSync: (source: string, target: string) => {
      fault.beforeReplace?.(source, target);
      return fs.renameSync(source, target);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  fault.beforePublish = undefined;
  fault.beforeReplace = undefined;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('publishes text through its existing link and mode, retaining the source after stale or failed updates', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-atomic-text-'));
  roots.push(root);
  const target = join(root, 'source.md');
  const alias = join(root, 'alias.md');
  writeFileSync(target, '\noriginal\n');
  chmodSync(target, 0o640);
  symlinkSync('source.md', alias);
  writeTextFileAtomic(alias, '\nnew\n', { expectedPreviousText: '\noriginal\n' });
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('\nnew\n');
  expect(statSync(target).mode & 0o777).toBe(0o640);
  expect(() => writeTextFileAtomic(alias, 'stale', { expectedPreviousText: '\noriginal\n' })).toThrow(/changed/);
  const publishedHash = hashArtifactSource(root, true);
  fault.beforeReplace = (source, destination) => {
    expect(readFileSync(source, 'utf8')).toBe('candidate');
    expect(readFileSync(destination, 'utf8')).toBe('\nnew\n');
    expect(hashArtifactSource(root, true)).toBe(publishedHash);
    throw new Error('injected publish failure');
  };
  expect(() => writeTextFileAtomic(alias, 'candidate', { expectedPreviousText: '\nnew\n' }))
    .toThrow(/injected publish failure/);
  expect(readFileSync(target, 'utf8')).toBe('\nnew\n');
  expect(readdirSync(root).sort()).toEqual(['alias.md', 'source.md']);
  fault.beforeReplace = undefined;
  if (process.getuid?.() !== 0) {
    chmodSync(target, 0o440);
    expect(() => writeTextFileAtomic(alias, 'read-only replacement')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('\nnew\n');
  }
});
it('publishes complete JSON and refuses a concurrent file without leaving staging files', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-exclusive-json-'));
  roots.push(root);
  const path = join(root, 'document.json');
  createJsonFileAtomic(path, { first: true });
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ first: true });
  expect(() => createJsonFileAtomic(path, { replacement: true })).toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ first: true });
  rmSync(path);
  fault.beforePublish = (target) => writeFileSync(target, 'concurrent content');
  expect(() => createJsonFileAtomic(path, { replacement: true })).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('concurrent content');
  expect(readdirSync(root)).toEqual(['document.json']);
  fault.beforePublish = () => { throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' }); };
  expect(() => createJsonFileAtomic(path, { replacement: true })).toThrow(/hard links unsupported/);
  expect(readFileSync(path, 'utf8')).toBe('concurrent content');
  expect(readdirSync(root)).toEqual(['document.json']);
});
