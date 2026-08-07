import { existsSync, readFileSync } from 'node:fs';
import {
  buildCodexRolloutIndex,
  extendCodexRolloutIndex,
  isReusableCodexRolloutIndex,
  type CodexRolloutIndex,
} from './codex-conversation-index.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';

const [sourcePath, sourceThreadId, cachePath] = process.argv.slice(2);

if (!sourcePath || !sourceThreadId || !cachePath) {
  console.error('Codex 对话索引进程缺少必要参数');
  process.exitCode = 1;
} else {
  try {
    const cached = readCachedIndex(cachePath);
    const index = cached && isReusableCodexRolloutIndex(cached, sourcePath)
      ? extendCodexRolloutIndex(sourcePath, sourceThreadId, cached)
      : buildCodexRolloutIndex(sourcePath, sourceThreadId);
    writeJsonFileAtomic(cachePath, index);
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}

function readCachedIndex(cachePath: string): CodexRolloutIndex | undefined {
  if (!existsSync(cachePath)) return undefined;
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as CodexRolloutIndex;
  } catch {
    return undefined;
  }
}
