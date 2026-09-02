import { homedir } from 'node:os';
import { join } from 'node:path';

export const OMK_HOME: string = process.env.OMK_HOME || join(homedir(), '.oh-my-knowledge');

export interface OmkLayout {
  readonly root: string;
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
}

export type ProjectOmkLayout = OmkLayout;

export interface GlobalOmkLayout extends OmkLayout {
  readonly cacheDir: string;
  readonly toolsDir: string;
  readonly tunnelsDir: string;
  readonly treesDir: string;
  readonly isolatedCwdDir: string;
  readonly artifactIndexDir: string;
}

function layout(root: string): OmkLayout {
  const observeDir = join(root, 'observe');
  const governanceDir = join(root, 'governance');
  const backupsDir = join(root, 'backups');
  const stateDir = join(root, 'state');
  const observeInboxDir = join(observeDir, 'inbox');
  return Object.freeze({
    root,
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
  });
}

export function projectLayout(cwd: string = process.cwd()): ProjectOmkLayout {
  return layout(join(cwd, '.omk'));
}

export function globalLayout(root: string = OMK_HOME): GlobalOmkLayout {
  const base = layout(root);
  return Object.freeze({
    ...base,
    cacheDir: join(base.stateDir, 'cache'),
    toolsDir: join(base.stateDir, 'tools'),
    tunnelsDir: join(base.stateDir, 'tunnels'),
    treesDir: join(base.stateDir, 'trees'),
    isolatedCwdDir: join(base.stateDir, 'isolated-cwd'),
    artifactIndexDir: join(base.stateDir, 'artifact-index'),
  });
}
