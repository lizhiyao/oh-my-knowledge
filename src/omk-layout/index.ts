import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';

export const OMK_LAYOUT_VERSION = 2 as const;
export const OMK_HOME: string = process.env.OMK_HOME || join(homedir(), '.oh-my-knowledge');

export interface OmkLayout {
  readonly root: string;
  readonly markerPath: string;
  readonly evalDir: string;
  readonly doctorDir: string;
  readonly observeDir: string;
  readonly observeHealthDir: string;
  readonly observeInboxDir: string;
  readonly observeInboxReportsDir: string;
  readonly observeInboxCapturesDir: string;
  readonly observeReviewStatePath: string;
  readonly observeDraftsDir: string;
  readonly observeArchiveDir: string;
  readonly governanceDir: string;
  readonly managedDir: string;
  readonly backupsDir: string;
  readonly doctorFixBackupsDir: string;
  readonly stateDir: string;
  readonly jobsDir: string;
  readonly locksDir: string;
  readonly tmpDir: string;
  readonly cacheDir: string;
  readonly toolsDir: string;
  readonly tunnelsDir: string;
  readonly treesDir: string;
  readonly isolatedCwdDir: string;
  readonly artifactIndexDir: string;
}

export interface OmkLayoutMarker {
  readonly layoutVersion: typeof OMK_LAYOUT_VERSION;
}

function layout(root: string): OmkLayout {
  const observeDir = join(root, 'observe');
  const governanceDir = join(root, 'governance');
  const backupsDir = join(root, 'backups');
  const stateDir = join(root, 'state');
  const observeInboxDir = join(observeDir, 'inbox');
  return Object.freeze({
    root,
    markerPath: join(root, 'layout.json'),
    evalDir: join(root, 'eval'),
    doctorDir: join(root, 'doctor'),
    observeDir,
    observeHealthDir: join(observeDir, 'health'),
    observeInboxDir,
    observeInboxReportsDir: join(observeInboxDir, 'reports'),
    observeInboxCapturesDir: join(observeInboxDir, 'captures'),
    observeReviewStatePath: join(observeInboxDir, 'review-state.json'),
    observeDraftsDir: join(observeDir, 'drafts'),
    observeArchiveDir: join(observeDir, 'archive'),
    governanceDir,
    managedDir: join(governanceDir, 'managed'),
    backupsDir,
    doctorFixBackupsDir: join(backupsDir, 'doctor-fix'),
    stateDir,
    jobsDir: join(stateDir, 'jobs'),
    locksDir: join(stateDir, 'locks'),
    tmpDir: join(stateDir, 'tmp'),
    cacheDir: join(stateDir, 'cache'),
    toolsDir: join(stateDir, 'tools'),
    tunnelsDir: join(stateDir, 'tunnels'),
    treesDir: join(stateDir, 'trees'),
    isolatedCwdDir: join(stateDir, 'isolated-cwd'),
    artifactIndexDir: join(stateDir, 'artifact-index'),
  });
}

export function projectLayout(cwd: string = process.cwd()): OmkLayout {
  return layout(join(cwd, '.omk'));
}

export function globalLayout(root: string = OMK_HOME): OmkLayout {
  return layout(root);
}

export function readLayoutMarker(root: string): OmkLayoutMarker | undefined {
  const markerPath = join(root, 'layout.json');
  if (!existsSync(markerPath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(markerPath, 'utf8')) as unknown;
  } catch {
    throw new TypeError(`Invalid OMK layout marker: ${markerPath}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid OMK layout marker: ${markerPath}`);
  }
  const keys = Object.keys(value);
  const version = (value as { layoutVersion?: unknown }).layoutVersion;
  if (keys.length !== 1 || keys[0] !== 'layoutVersion' || version !== OMK_LAYOUT_VERSION) {
    throw new TypeError(`Unsupported OMK layout version in ${markerPath}`);
  }
  return Object.freeze({ layoutVersion: OMK_LAYOUT_VERSION });
}

export function ensureLayoutMarker(root: string): OmkLayoutMarker {
  const existing = readLayoutMarker(root);
  if (existing !== undefined) return existing;
  const marker = Object.freeze({ layoutVersion: OMK_LAYOUT_VERSION });
  writeJsonFileAtomic(join(root, 'layout.json'), marker);
  return marker;
}

function contains(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Ensures a marker only for OMK-owned project/global paths; custom output directories stay untouched. */
export function ensureOwnedLayoutForPath(
  path: string,
  cwd: string = process.cwd(),
): OmkLayoutMarker | undefined {
  const project = projectLayout(cwd);
  if (contains(project.root, path)) return ensureLayoutMarker(project.root);
  const global = globalLayout();
  if (contains(global.root, path)) return ensureLayoutMarker(global.root);
  return undefined;
}
