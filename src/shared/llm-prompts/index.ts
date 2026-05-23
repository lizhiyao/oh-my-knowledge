import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LlmPromptDocument {
  id: string;
  version: string;
  body: string;
  hash: string;
}

// 锁定 omk 包根目录,不走 process.cwd()。
// 走 cwd 会让 npm 全局安装的 omk 在用户项目目录里找不到 prompt 文件。
// 编译后位置 dist/src/shared/llm-prompts/index.js 跟源码位置 src/shared/llm-prompts/index.ts
// 跟包根的层级不同(4 vs 3),所以用 walk-up 找最近一层有 package.json 的目录,
// 两种位置都能正确解析。
function findPackageRoot(startDir: string): string {
  let current = startDir;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    current = dirname(current);
  }
  throw new Error(`package.json not found walking up from ${startDir}`);
}

const PACKAGE_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

export function hashPromptText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function readPromptDocument(options: {
  rootDir?: string;
  fileName: string;
  id: string;
  version: string;
}): LlmPromptDocument {
  const path = join(options.rootDir ?? PACKAGE_ROOT, 'src', 'observability', 'prompts', options.fileName);
  if (!existsSync(path)) throw new Error(`missing prompt document: ${path}`);
  const body = readFileSync(path, 'utf-8');
  return {
    id: options.id,
    version: options.version,
    body,
    hash: hashPromptText(body),
  };
}
