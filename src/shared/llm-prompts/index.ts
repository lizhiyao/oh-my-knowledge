import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LlmPromptDocument {
  id: string;
  version: string;
  body: string;
  hash: string;
}

export function hashPromptText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// dir 由 caller 用 sibling-relative 解析(参考 src/eval-core/mocks-runtime.ts 的 mock-hook 加载),
// 这样 dev(src/)和 npm 安装(dist/src/)都能从相对自己的位置找到 prompt 文件,无需 walk-up package.json。
// build script 把 src/<module>/prompts/*.md 复制到 dist/<module>/prompts/ 让 sibling 路径在 dist 下也通。
export function readPromptDocument(options: {
  dir: string;
  fileName: string;
  id: string;
  version: string;
}): LlmPromptDocument {
  const path = join(options.dir, options.fileName);
  if (!existsSync(path)) throw new Error(`missing prompt document: ${path}`);
  const body = readFileSync(path, 'utf-8');
  return {
    id: options.id,
    version: options.version,
    body,
    hash: hashPromptText(body),
  };
}
