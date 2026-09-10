import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeProjectScaffold } from '../../../src/knowledge-artifacts/authoring/scaffold.js';

const fault = vi.hoisted(() => ({ commit: '', restore: false, stage: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fault.stage && String(args[0]).endsWith('/next')) throw new Error('stage EIO');
      return fs.writeFileSync(...args);
    },
    renameSync: (source: string, target: string) => {
      if (source.endsWith('/next') && target.endsWith(fault.commit) && fault.commit) throw new Error('commit EIO');
      if (fault.restore && source.endsWith('/previous')) throw new Error('restore EIO');
      return fs.renameSync(source, target);
    },
  };
});
const roots: string[] = [];
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'omk-init-transaction-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  fault.commit = ''; fault.restore = false; fault.stage = false;
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const files = [{ relativePath: 'a.txt', content: 'new-a' }, { relativePath: 'b.txt', content: 'new-b' }];

describe('project scaffold transaction', () => {
  it.each(['stage', 'commit'])('%s failure preserves existing files and removes replacement files', (phase) => {
    const path = root();
    writeFileSync(join(path, 'b.txt'), 'old-b');
    if (phase === 'stage') fault.stage = true;
    else fault.commit = 'b.txt';
    expect(() => writeProjectScaffold(path, files, true)).toThrow('EIO');
    expect(existsSync(join(path, 'a.txt'))).toBe(false);
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('old-b');
    expect(readdirSync(path).filter((name) => name.startsWith('.omk-init-'))).toEqual([]);
    expect(existsSync(join(path, '.omk/state/init.lock'))).toBe(false);
  });

  it('retains the old file and reports its recovery location when restoration fails', () => {
    const path = root();
    writeFileSync(join(path, 'b.txt'), 'old-b');
    fault.commit = 'b.txt'; fault.restore = true;
    expect(() => writeProjectScaffold(path, files, true)).toThrow('retained recovery files');
    const retained = readdirSync(path).filter((name) => name.startsWith('.omk-init-'));
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(path, retained[0], 'previous'), 'utf8')).toBe('old-b');
    expect(existsSync(join(path, 'a.txt'))).toBe(false);
  });

  it('checks all parents before writing and rejects symlink redirection', () => {
    const path = root();
    const other = root();
    symlinkSync(other, join(path, 'redirect'));
    expect(() => writeProjectScaffold(path, [files[0], { relativePath: 'redirect/b.txt', content: 'x' }], true)).toThrow('not a directory');
    expect(existsSync(join(path, 'a.txt'))).toBe(false);
    expect(readdirSync(other)).toEqual([]);
    rmSync(join(path, 'redirect'));
    mkdirSync(join(path, 'b.txt'));
    expect(() => writeProjectScaffold(path, files, true)).toThrow('not a regular file');
    expect(existsSync(join(path, 'a.txt'))).toBe(false);
  });

  it('refuses existing content without force and commits a complete replacement with force', () => {
    const path = root();
    writeProjectScaffold(path, files, false);
    expect(() => writeProjectScaffold(path, [{ relativePath: 'a.txt', content: 'changed' }], false)).toThrow('already exist');
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('new-a');
    writeProjectScaffold(path, [{ relativePath: 'a.txt', content: 'changed' }], true);
    expect(readFileSync(join(path, 'a.txt'), 'utf8')).toBe('changed');
    expect(readFileSync(join(path, 'b.txt'), 'utf8')).toBe('new-b');
  });
});
