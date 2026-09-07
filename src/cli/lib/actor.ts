import { execFileSync } from 'node:child_process';

/** Resolve a decision actor from the flag, Git config, environment, then fallback. */
export function resolveActor(flagActor: string | undefined): string {
  if (flagActor && flagActor.trim()) return flagActor.trim();
  try {
    const name = execFileSync('git', ['config', 'user.name'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (name) return name;
  } catch { /* git 缺失 / 无配置 → 回退环境 */ }
  return process.env.USER || process.env.LOGNAME || 'unknown';
}
