import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withFileLock } from '../../shared/file-lock.js';
import { projectLayout } from '../../evidence/storage/layout.js';

interface ScaffoldFile {
  relativePath: string;
  content: string;
}

interface StagedFile {
  path: string;
  staging: string;
  original?: Buffer;
  content: Buffer;
  backedUp: boolean;
  committed: boolean;
}

function readRegularFile(path: string): Buffer | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Scaffold target is not a regular file: ${path}`);
  return readFileSync(path);
}

function sameBytes(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.equals(b);
}

/** Stage the entire scaffold before replacing files. Readers may see intermediate commits;
 * failed commits are restored, and failed restoration retains the original in its staging directory. */
export function writeProjectScaffold(root: string, files: readonly ScaffoldFile[], force: boolean): void {
  const targetRoot = resolve(root);
  const paths = files.map((file) => {
    const path = resolve(targetRoot, file.relativePath);
    const rel = relative(targetRoot, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw new Error(`Invalid scaffold path: ${file.relativePath}`);
    }
    return path;
  });
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate scaffold target');
  // Refuse redirected subdirectories before creating the lock or any scaffold file.
  for (const path of paths) {
    for (let parent = dirname(path); parent !== targetRoot; parent = dirname(parent)) {
      const stat = lstatSync(parent, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) throw new Error(`Scaffold parent is not a directory: ${parent}`);
    }
  }
  withFileLock(join(projectLayout(targetRoot).root, 'state', 'init.lock'), () => {
    const originals = paths.map(readRegularFile);
    if (!force && originals.some((value) => value !== undefined)) {
      throw new Error('Scaffold files already exist; use --force to replace them.');
    }
    const staged: StagedFile[] = [];
    let failure: unknown;
    let failed = false;
    const recovery: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const path = paths[index];
        mkdirSync(dirname(path), { recursive: true });
        const staging = mkdtempSync(join(dirname(path), '.omk-init-'));
        const item: StagedFile = {
          path, staging, original: originals[index], content: Buffer.from(file.content),
          backedUp: false, committed: false,
        };
        staged.push(item);
        const mode = lstatSync(path, { throwIfNoEntry: false })?.mode;
        writeFileSync(join(staging, 'next'), item.content, { mode });
      }
      for (const item of staged) {
        if (!sameBytes(readRegularFile(item.path), item.original)) {
          throw new Error(`Scaffold target changed during initialization: ${item.path}`);
        }
        if (item.original !== undefined) {
          renameSync(item.path, join(item.staging, 'previous'));
          item.backedUp = true;
        }
        renameSync(join(item.staging, 'next'), item.path);
        item.committed = true;
      }
    } catch (error) {
      failed = true;
      failure = error;
      for (const item of [...staged].reverse()) {
        if (!item.committed && !item.backedUp) continue;
        try {
          const current = readRegularFile(item.path);
          if (!sameBytes(current, item.committed ? item.content : undefined)) {
            throw new Error(`Scaffold target changed before restoration: ${item.path}`);
          }
          if (item.backedUp) renameSync(join(item.staging, 'previous'), item.path);
          else rmSync(item.path);
        } catch {
          recovery.push(item.staging);
        }
      }
    }
    for (const item of staged) {
      if (recovery.includes(item.staging)) continue;
      try { rmSync(item.staging, { recursive: true, force: true }); }
      catch { recovery.push(item.staging); }
    }
    if (recovery.length) {
      throw new AggregateError(failed ? [failure] : [], `Initialization ${failed ? 'failed' : 'completed'}; inspect retained recovery files: ${recovery.join(', ')}`);
    }
    if (failed) throw failure;
  });
}
