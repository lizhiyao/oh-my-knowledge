import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { globalLayout, projectLayout } from '../../omk-layout/index.js';
import { isReportFileName } from '../../measurement-artifacts/file-names.js';

export const DEFAULT_PROJECT_OBSERVATIONS_DIR = projectLayout().observeInboxDir;
export const DEFAULT_GLOBAL_OBSERVATIONS_DIR = globalLayout().observeInboxDir;
export const DEFAULT_OBSERVATIONS_DIR = DEFAULT_PROJECT_OBSERVATIONS_DIR;

function hasObservationData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (entry.isFile()) return entry.name === 'review-state.json';
      if (!entry.isDirectory()) return false;
      if (entry.name === 'captures') {
        try {
          return readdirSync(join(dir, entry.name)).some((file) => file.endsWith('.capture.json'));
        } catch {
          return false;
        }
      }
      if (entry.name !== 'reports') return false;
      try {
        return readdirSync(join(dir, entry.name)).some(isReportFileName);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isV2ObservationInboxDir(dir: string): boolean {
  const normalized = resolve(dir);
  return basename(normalized) === 'inbox' && basename(dirname(normalized)) === 'observe';
}

/** Inbox roots keep generated reports below `reports/`. */
export function observationReportsDir(observationsDir: string): string {
  return join(observationsDir, 'reports');
}

/** Canonical inbox roots place drafts in the sibling `observe/drafts/` domain. */
export function observationDraftsDir(observationsDir: string): string {
  if (isV2ObservationInboxDir(observationsDir)) return join(dirname(observationsDir), 'drafts');
  return join(observationsDir, 'drafts');
}

/** Canonical inbox roots place immutable source records in `observe/archive/`. */
export function observationArchiveDir(observationsDir: string): string {
  if (isV2ObservationInboxDir(observationsDir)) return join(dirname(observationsDir), 'archive');
  return join(observationsDir, 'archive');
}

export function resolveObservationsDir(dir: string = DEFAULT_PROJECT_OBSERVATIONS_DIR): string {
  if (resolve(dir) === resolve(DEFAULT_PROJECT_OBSERVATIONS_DIR)
      && !hasObservationData(dir)
      && hasObservationData(DEFAULT_GLOBAL_OBSERVATIONS_DIR)) return DEFAULT_GLOBAL_OBSERVATIONS_DIR;
  return dir;
}
