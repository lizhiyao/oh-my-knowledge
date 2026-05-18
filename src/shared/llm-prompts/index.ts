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

export function readPromptDocument(options: {
  cwd?: string;
  fileName: string;
  id: string;
  version: string;
}): LlmPromptDocument {
  const path = join(options.cwd ?? process.cwd(), 'docs', 'prompts', options.fileName);
  if (!existsSync(path)) throw new Error(`missing prompt document: ${path}`);
  const body = readFileSync(path, 'utf-8');
  return {
    id: options.id,
    version: options.version,
    body,
    hash: hashPromptText(body),
  };
}
