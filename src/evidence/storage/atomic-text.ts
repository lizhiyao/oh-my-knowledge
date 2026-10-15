import { randomUUID } from 'node:crypto';
import {
  accessSync, closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { projectLayout } from './layout.js';

/** Publish complete text while retaining an existing source's link target and permissions. */
export function writeTextFileAtomic(
  path: string,
  text: string,
  options: Readonly<{ expectedPreviousText?: string }> = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  let entry: Stats | undefined;
  try { entry = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Resolve outside the ENOENT handler: a dangling link must not be replaced.
  const target = entry?.isSymbolicLink() ? realpathSync(path) : path;
  const previous = entry?.isSymbolicLink() ? statSync(target) : entry;
  const assertUnchanged = (): void => {
    if (previous !== undefined) accessSync(target, constants.W_OK);
    if (options.expectedPreviousText !== undefined
        && readFileSync(target, 'utf8') !== options.expectedPreviousText) {
      throw new Error('Source file changed while preparing the update; write-back was refused.');
    }
  };
  assertUnchanged();
  // .omk is excluded from every carrier tree, including concurrent snapshots and hashes.
  const stagingDirectory = projectLayout(dirname(target)).root;
  const createdStaging = mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 }) !== undefined;
  const temporary = join(stagingDirectory, `${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let owned = false;
  try {
    descriptor = openSync(temporary, 'wx', previous === undefined ? 0o666 : previous.mode & 0o777);
    owned = true;
    writeFileSync(descriptor, text, 'utf8');
    if (previous !== undefined) {
      if (previous.uid !== (process.getuid?.() ?? 0) || previous.gid !== (process.getgid?.() ?? 0)) {
        fchownSync(descriptor, previous.uid, previous.gid);
      }
      fchmodSync(descriptor, previous.mode & 0o777);
    }
    fsyncSync(descriptor);
    const closing = descriptor;
    descriptor = undefined;
    closeSync(closing);
    assertUnchanged();
    renameSync(temporary, target);
  } finally {
    try { if (descriptor !== undefined) closeSync(descriptor); } finally {
      try { if (owned) rmSync(temporary, { force: true }); } finally {
        if (createdStaging) {
          try { rmdirSync(stagingDirectory); } catch { /* A private empty directory must not turn a committed publish into a failure. */ }
        }
      }
    }
  }
}
