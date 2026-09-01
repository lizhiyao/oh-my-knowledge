import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DOMAIN_CONTRACT_FILES = [
  'src/analysis/contracts.ts',
  'src/artifact-graph/contracts.ts',
  'src/preflight/contracts.ts',
  'src/managed/contracts.ts',
] as const;

const ALLOWED_LEGACY_TYPE_FILES = new Set([
  'diagnosis.ts',
  'doctor.ts',
  'eval.ts',
  'executor.ts',
  'index.ts',
  'judge.ts',
  'observability.ts',
  'shared.ts',
  'skill-index.ts',
  'trace.ts',
]);

function listTypeFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listTypeFiles(resolve(directory, entry.name), relativePath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [relativePath] : [];
  });
}

describe('领域契约所有权', () => {
  it('禁止向遗留 src/types 增加新的领域类型文件', () => {
    const unexpected = listTypeFiles(resolve('src/types'))
      .filter((file) => !ALLOWED_LEGACY_TYPE_FILES.has(file));
    expect(unexpected).toEqual([]);
  });

  it('领域 contracts 保持为无运行时实现的纯契约', () => {
    const violations: string[] = [];
    for (const file of DOMAIN_CONTRACT_FILES) {
      const source = ts.createSourceFile(
        file,
        readFileSync(resolve(file), 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          if (statement.importClause?.isTypeOnly !== true) {
            violations.push(`${file}：只允许 import type`);
          }
          continue;
        }
        if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
          violations.push(`${file}：包含运行时声明 ${ts.SyntaxKind[statement.kind]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
