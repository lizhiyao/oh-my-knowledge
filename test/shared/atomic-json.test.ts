import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJsonFileAtomic } from '../../src/shared/atomic-json.js';

const fault = vi.hoisted(() => ({ beforePublish: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, linkSync: (source: string, target: string) => {
    fault.beforePublish?.(target);
    return fs.linkSync(source, target);
  } };
});
const roots: string[] = [];
afterEach(() => {
  fault.beforePublish = undefined;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
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
});
