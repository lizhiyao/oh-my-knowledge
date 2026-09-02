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
