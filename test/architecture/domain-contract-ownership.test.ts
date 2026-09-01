import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PURE_DOMAIN_TYPE_FILES = [
  'src/analysis/contracts.ts',
  'src/artifact-graph/contracts.ts',
  'src/diagnosis/contracts.ts',
  'src/preflight/contracts.ts',
  'src/managed/contracts.ts',
  'src/skill-definition/contracts.ts',
  'src/artifacts/contracts.ts',
  'src/inputs/contracts/index.ts',
  'src/inputs/contracts/assertion.ts',
  'src/inputs/contracts/config.ts',
  'src/inputs/contracts/mock.ts',
  'src/inputs/contracts/sample.ts',
  'src/inputs/contracts/variant.ts',
  'src/grading/contracts/index.ts',
  'src/grading/contracts/config.ts',
  'src/grading/contracts/result.ts',
  'src/executors/contracts/index.ts',
  'src/executors/contracts/trace.ts',
  'src/executors/contracts/ports.ts',
  'src/executors/contracts/result.ts',
  'src/executors/contracts/mcp.ts',
  'src/executors/contracts/runtime.ts',
  'src/observability/contracts/index.ts',
  'src/observability/contracts/trace.ts',
  'src/observability/contracts/review.ts',
  'src/observability/contracts/problem-patterns.ts',
  'src/observability/contracts/skill-chain-advisories.ts',
  'src/observability/contracts/inbox.ts',
  'src/observability/contracts/experience.ts',
  'src/observability/contracts/skill-chain.ts',
  'src/observability/view-models/index.ts',
  'src/observability/view-models/conversation.ts',
  'src/observability/view-models/knowledge-debugger.ts',
] as const;

const PURE_DOMAIN_TYPE_FILE_SET = new Set<string>(PURE_DOMAIN_TYPE_FILES);
const ALLOWED_LEGACY_CONTRACT_IMPORTS = new Set<string>();

const ALLOWED_LEGACY_TYPE_FILES = new Set([
  'doctor.ts',
  'index.ts',
  'shared.ts',
  'skill-index.ts',
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

  it('领域 contracts 与 view-models 保持为无运行时实现的纯类型模块', () => {
    const violations: string[] = [];
    for (const file of PURE_DOMAIN_TYPE_FILES) {
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
          if (ts.isStringLiteral(statement.moduleSpecifier)) {
            const specifier = statement.moduleSpecifier.text;
            const target = relative(
              process.cwd(),
              resolve(dirname(resolve(file)), specifier.replace(/\.js$/, '.ts')),
            );
            const edge = `${file}::${specifier}`;
            if (!PURE_DOMAIN_TYPE_FILE_SET.has(target)
                && !ALLOWED_LEGACY_CONTRACT_IMPORTS.has(edge)) {
              violations.push(`${file}：依赖了非契约模块 ${specifier}`);
            }
          }
          continue;
        }
        if (ts.isExportDeclaration(statement)) {
          if (statement.isTypeOnly !== true) {
            violations.push(`${file}：只允许 export type`);
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
