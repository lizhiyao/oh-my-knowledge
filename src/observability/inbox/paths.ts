import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  globalLayout,
  legacyGlobalLayout,
  legacyProjectLayout,
  projectLayout,
} from '../../omk-layout/index.js';
import { isReportFileName } from '../../measurement-artifacts/file-names.js';

export const DEFAULT_PROJECT_OBSERVATIONS_DIR = projectLayout().observeInboxDir;
export const DEFAULT_GLOBAL_OBSERVATIONS_DIR = globalLayout().observeInboxDir;
export const DEFAULT_OBSERVATIONS_DIR = DEFAULT_PROJECT_OBSERVATIONS_DIR;
export const LEGACY_PROJECT_OBSERVATIONS_DIR = legacyProjectLayout().observeInboxDir;
export const LEGACY_GLOBAL_OBSERVATIONS_DIR = legacyGlobalLayout().observeInboxDir;

function hasObservationData(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (entry.isFile()) return isReportFileName(entry.name) || entry.name === 'review-state.json';
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

/** Canonical v2 inbox roots keep generated reports below `reports/`; custom and v1 roots stay flat. */
export function observationReportsDir(observationsDir: string): string {
  return observationsDir === DEFAULT_PROJECT_OBSERVATIONS_DIR
      || observationsDir === DEFAULT_GLOBAL_OBSERVATIONS_DIR
    ? join(observationsDir, 'reports')
    : observationsDir;
}

/** Canonical inbox roots place drafts in the sibling `observe/drafts/` domain. */
export function observationDraftsDir(observationsDir: string): string {
  if (observationsDir === DEFAULT_PROJECT_OBSERVATIONS_DIR) return projectLayout().observeDraftsDir;
  if (observationsDir === DEFAULT_GLOBAL_OBSERVATIONS_DIR) return globalLayout().observeDraftsDir;
  return join(observationsDir, 'drafts');
}

export function resolveObservationsDir(dir: string = DEFAULT_PROJECT_OBSERVATIONS_DIR): string {
  if (dir === DEFAULT_GLOBAL_OBSERVATIONS_DIR) {
    return [DEFAULT_GLOBAL_OBSERVATIONS_DIR, LEGACY_GLOBAL_OBSERVATIONS_DIR]
      .find(hasObservationData) ?? DEFAULT_GLOBAL_OBSERVATIONS_DIR;
  }
  if (dir !== DEFAULT_PROJECT_OBSERVATIONS_DIR) return dir;
  const project = [DEFAULT_PROJECT_OBSERVATIONS_DIR, LEGACY_PROJECT_OBSERVATIONS_DIR];
  const local = project.find(hasObservationData);
  if (local !== undefined) return local;
  const global = [DEFAULT_GLOBAL_OBSERVATIONS_DIR, LEGACY_GLOBAL_OBSERVATIONS_DIR];
  return global.find(hasObservationData) ?? DEFAULT_PROJECT_OBSERVATIONS_DIR;
}
