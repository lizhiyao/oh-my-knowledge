import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const SKIPPED_DIRECTORIES = new Set(['.next', 'node_modules', 'dist', 'coverage']);

/** Source-only traversal for guards with the same scope; unreadable trees fail closed. */
export function typeScriptSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...typeScriptSources(path));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) files.push(path);
  }
  return files;
}

export function parseTypeScript(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}
