import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLock } from '../../shared/file-lock.js';
import { distributableCopyFilter } from './content-hash.js';

/** Build the replacement on the target filesystem before touching the installed version. */
export function replaceDeployedArtifact(source: string, target: string, isDirectorySkill: boolean, force = false): { cleanupWarning?: string } {
  return withFileLock(`${target}.omk-install.lock`, () => replaceUnderLock(source, target, isDirectorySkill, force));
}

function replaceUnderLock(source: string, target: string, isDirectorySkill: boolean, force: boolean): { cleanupWarning?: string } {
  mkdirSync(dirname(target), { recursive: true });
  const staging = mkdtempSync(join(dirname(target), '.omk-install-'));
  const next = join(staging, 'next');
  const previous = join(staging, 'previous');
  let preserveBackup = false;
  let failed = false;
  let failure: unknown;
  let cleanupWarning: string | undefined;
  try {
    if (isDirectorySkill) {
      cpSync(source, next, { recursive: true, filter: distributableCopyFilter(source) });
    } else {
      copyFileSync(source, next);
    }
    const hadPrevious = lstatSync(target, { throwIfNoEntry: false }) !== undefined;
    if (hadPrevious && !force) throw new Error(`Install target already exists; use --force to replace: ${target}`);
    if (hadPrevious) renameSync(target, previous);
    try {
      renameSync(next, target);
    } catch (error) {
      if (hadPrevious) {
        try {
          renameSync(previous, target);
        } catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError([error, restoreError], `Installation failed; restore the previous artifact from ${previous}`);
        }
      }
      throw error;
    }
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Cleanup failure after commit must not hide a successful deployment from registration.
  if (!preserveBackup) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch (error) {
      if (failed) failure = new AggregateError([failure, error], `Installation failed; cleanup required at ${staging}`);
      else cleanupWarning = staging;
    }
  }
  if (failed) throw failure;
  return { cleanupWarning };
}
