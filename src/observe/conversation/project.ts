import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ConversationProject } from '../view-models/conversation.js';

/** Group only by an observed directory or an explicit Git common-directory relationship. */
export function conversationProject(cwd?: string): ConversationProject | undefined {
  if (!cwd) return undefined;
  let root = resolve(cwd);
  try { root = realpathSync(root); } catch { /* Deleted directories retain their own identity. */ }
  let identity = root;
  let name = basename(root) || root;
  let directory = root;
  if (existsSync(root)) for (let cursor = root; ; cursor = dirname(cursor)) {
    const dotGit = join(cursor, '.git');
    try {
      const stat = statSync(dotGit);
      let git = dotGit;
      if (stat.isFile() && stat.size < 4096) {
        const match = readFileSync(dotGit, 'utf8').trim().match(/^gitdir: (.+)$/);
        if (!match) break;
        git = resolve(cursor, match[1]);
      } else if (!stat.isDirectory()) break;
      const common = join(git, 'commondir');
      if (existsSync(common) && statSync(common).size < 4096) git = resolve(git, readFileSync(common, 'utf8').trim());
      identity = realpathSync(git);
      directory = basename(identity) === '.git' ? dirname(identity) : cursor;
      name = basename(directory) || directory;
      break;
    } catch (error) {
      // Only an absent marker permits walking into a parent repository.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(dotGit)) break;
    }
    if (dirname(cursor) === cursor) break;
  }
  return { projectId: createHash('sha256').update(identity).digest('hex').slice(0, 24), name, directory };
}
