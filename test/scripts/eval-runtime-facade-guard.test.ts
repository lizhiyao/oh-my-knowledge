import { readFileSync, readdirSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WORKFLOWS_ROOT = resolve('src/eval-workflows');
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && TYPESCRIPT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

function importsFrom(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'workflow.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier !== undefined
        && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1
        && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    } else if (ts.isImportTypeNode(node)
        && ts.isLiteralTypeNode(node.argument)
        && ts.isStringLiteralLike(node.argument.literal)) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isForbiddenWorkflowImport(specifier: string): boolean {
  const packageEntry = 'oh-my-knowledge/eval-runtime';
  if (specifier === packageEntry || specifier.startsWith(`${packageEntry}/`)) return true;
  return /(?:^|\/)eval-runtime(?:\/(?:index|advanced|evaluate)(?:\.[cm]?[jt]sx?)?)?$/.test(
    specifier,
  );
}

function publicDeclarationNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'public-api.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  const collectName = (node: ts.Node): void => {
    if ('name' in node) {
      const name = (node as ts.NamedDeclaration).name;
      if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) {
        names.push(name.text);
      }
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body !== undefined) {
      for (const parameter of node.parameters) collectName(parameter);
      return;
    }
    ts.forEachChild(node, collectName);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)
        && statement.exportClause !== undefined
        && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.push(element.name.text);
      continue;
    }
    const exported = ts.canHaveModifiers(statement)
      && ts.getModifiers(statement)?.some((modifier) => (
        modifier.kind === ts.SyntaxKind.ExportKeyword
      ));
    if (exported) collectName(statement);
  }
  return names;
}

function identifierTerms(name: string): string[] {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

describe('eval-runtime façade architecture guard', () => {
  it('keeps eval-workflows on Runtime foundation leaf modules', () => {
    const violations = sourceFiles(WORKFLOWS_ROOT).flatMap((file) => (
      importsFrom(readFileSync(file, 'utf8'))
        .filter(isForbiddenWorkflowImport)
        .map((specifier) => `${relative(WORKFLOWS_ROOT, file)}: ${specifier}`)
    ));

    expect(violations).toEqual([]);
  });

  it('recognizes package, directory, façade, and advanced entry imports', () => {
    const forbidden = [
      'oh-my-knowledge/eval-runtime',
      'oh-my-knowledge/eval-runtime/advanced',
      'oh-my-knowledge/eval-runtime/contracts',
      '../../eval-runtime',
      '../../eval-runtime/index.js',
      '../../eval-runtime/index.ts',
      '../../eval-runtime/evaluate.js',
      '../../eval-runtime/advanced.js',
    ];
    const allowed = [
      '../../eval-runtime/runtime.js',
      '../../eval-runtime/identity.js',
      '../../eval-runtime/contracts/index.js',
      '../../eval-core/contracts/index.js',
    ];

    expect(forbidden.filter((specifier) => !isForbiddenWorkflowImport(specifier))).toEqual([]);
    expect(allowed.filter(isForbiddenWorkflowImport)).toEqual([]);
    expect(importsFrom(`
      import 'oh-my-knowledge/eval-runtime';
      import type { EvaluateInput } from '../../eval-runtime/index.js';
      export { evaluate } from '../../eval-runtime/evaluate.js';
      type Lazy = import('../../eval-runtime/advanced.js').RunEvaluationInput;
      const load = () => import('../../eval-runtime');
    `)).toEqual(forbidden.filter((_specifier, index) => index < 1).concat([
      '../../eval-runtime/index.js',
      '../../eval-runtime/evaluate.js',
      '../../eval-runtime/advanced.js',
      '../../eval-runtime',
    ]));
  });

  it('does not expose competing evaluation vocabulary in public declarations', () => {
    const prohibited = new Set(['runner', 'suite', 'cases', 'candidate', 'scoring', 'target', 'targets']);
    const publicSources = [
      'src/eval-runtime/evaluate.ts',
      'src/eval-runtime/index.ts',
    ].map((file) => readFileSync(resolve(file), 'utf8'));
    const violations = publicSources
      .flatMap(publicDeclarationNames)
      .filter((name) => identifierTerms(name).some((term) => prohibited.has(term)));

    expect(violations).toEqual([]);
    expect(publicDeclarationNames(`
      export type Runner = { cases: string[] };
      export class ScoringEngine {}
      export function createCandidate(target: string): void;
      export { hidden as EvaluationSuite };
    `).filter((name) => identifierTerms(name).some((term) => prohibited.has(term)))).toEqual([
      'Runner',
      'cases',
      'ScoringEngine',
      'createCandidate',
      'target',
      'EvaluationSuite',
    ]);
  });

  it('keeps the shared evaluation vocabulary and Chinese user terms explicit', () => {
    const terminology = readFileSync(resolve('docs/specs/terminology-spec.md'), 'utf8');
    const glossary = readFileSync(resolve('docs/zh/reference/glossary.md'), 'utf8');
    const guide = readFileSync(resolve('docs/zh/guides/eval-runtime.md'), 'utf8');
    const quickstart = readFileSync(resolve('docs/zh/quickstart-skill-eval.md'), 'utf8');
    const cli = readFileSync(resolve('src/cli/commands/eval/index.ts'), 'utf8');
    const studio = readFileSync(resolve('src/studio/core-runs/renderer.ts'), 'utf8');
    const workflowJudge = readFileSync(
      resolve('src/eval-workflows/instruments/judge.ts'),
      'utf8',
    );
    const canonicalTerms = [
      'evaluation',
      'artifact',
      'variant',
      'control',
      'treatment',
      'runtime context',
      'dataset',
      'sample',
      'executor',
      'evaluator',
      'metric',
      'judge',
      'rubric',
      'experiment',
      'policy',
      'run',
      'comparison',
      'verdict',
      'evidence',
      'report',
    ];

    for (const term of canonicalTerms) expect(terminology.toLowerCase()).toContain(`\`${term}\``);
    expect(glossary).toContain('只有被选为 control 时才承担对照角色');
    expect(glossary).toContain('| judge | 评委 |');
    expect(guide).toContain('Executor 负责运行 artifact，Evaluator 负责评价结果。');
    expect(guide).not.toContain('判官');
    expect(quickstart).toContain('**verdict**（跨版本判定）');
    expect(cli).toContain('对照组（control）的 variant 表达式');
    expect(cli).toContain('实验组（treatment）的 variant 列表');
    expect(cli).toContain('单用例失败重试次数');
    expect(cli).toContain('跳过 LLM 评委');
    expect(cli).toContain('判定阈值');
    expect(studio).toContain("verdict: '判定'");
    expect(workflowJudge).not.toContain('判官');
  });
});
