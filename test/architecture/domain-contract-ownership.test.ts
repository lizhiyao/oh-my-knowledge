import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const PURE_DOMAIN_TYPE_FILES = [
  'src/observability/analysis/contracts.ts',
  'src/artifact-graph/contracts.ts',
  'src/diagnosis/contracts.ts',
  'src/doctor/contracts.ts',
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
  'src/shared/language.ts',
  'src/shared/contracts/trace-source.ts',
  'src/studio/view-models/index.ts',
  'src/studio/view-models/insight.ts',
  'src/studio/view-models/skill-index.ts',
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

describe('领域契约所有权', () => {
  it('保持遗留 src/types 目录已删除', () => {
    expect(existsSync(resolve('src/types'))).toBe(false);
  });

  it('保持已归位的 observe analysis 与 Studio 领域不回退到旧目录', () => {
    for (const legacyPath of [
      'src/analysis',
      'src/eval-workflows/studio-catalog',
      'src/server',
      'src/renderer',
    ]) {
      expect(existsSync(resolve(legacyPath)), legacyPath).toBe(false);
    }
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
            if (!PURE_DOMAIN_TYPE_FILE_SET.has(target)) {
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
