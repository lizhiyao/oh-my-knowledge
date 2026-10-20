import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export const ENTITY_MEASUREMENT_RUNTIME_VERSION = 'omk-entity-measurement-runtime/v2';

/** All regular dist assets except the unrelated, nondeterministic Next.js web build. */
export function measurementRuntimeDigest(root: string): string {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name);
      const name = relative(root, path).split(sep).join('/');
      if (name === 'studio/web') continue;
      if (item.isDirectory()) walk(path);
      else if (item.isFile()) files.push(name);
      else throw new Error('Measurement runtime must contain regular files only.');
    }
  };
  walk(root);
  const hash = createHash('sha256').update(ENTITY_MEASUREMENT_RUNTIME_VERSION).update('\0');
  for (const file of files.sort()) {
    const bytes = readFileSync(resolve(root, file));
    // Raw assets may contain NUL: bind the exact length instead of using a byte delimiter.
    hash.update(JSON.stringify([file, bytes.length])).update('\0').update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Observational provenance only: never include these values in measurement identity. */
export function reviewSourceRevision(repository: string): { commit: string | null; dirty: boolean | null } {
  const unknown = { commit: null, dirty: null };
  try {
    const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repository, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    }).trim();
    // An installed package inside somebody else's repository must not inherit that repository's revision.
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(repository)) return unknown;
    const commit = git(['rev-parse', '--verify', 'HEAD']);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) return unknown;
    return { commit, dirty: git(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0 };
  } catch { return unknown; }
}
