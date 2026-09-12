import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DIST_ROOT = resolve('dist');
const ENTRY = 'eval-workflows/hosts/reference-executors';

const PUBLIC_API = {
  values: [
    'CODEX_CLI_MIN_SUPPORTED_VERSION',
    'CODEX_CLI_REFERENCE_ADAPTER_VERSION',
    'DEFAULT_CODEX_CLI_REFERENCE_PROBE_TIMEOUT_MS',
    'createCodexCliReferenceExecutor',
  ],
  types: [
    'CodexCliContentIdentityFile',
    'CodexCliEnvironmentEntry',
    'CreateCodexCliReferenceExecutorInput',
  ],
} as const;

function declarationExports(): { values: string[]; types: string[] } {
  const file = resolve(`${DIST_ROOT}/${ENTRY}.d.ts`);
  if (!existsSync(file)) throw new Error(`缺少 ${file}；请先运行 yarn build。`);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const values: string[] = [];
  const types: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)
        || statement.exportClause === undefined
        || !ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

async function moduleGraph(): Promise<{ modules: string[]; externalImports: string[] }> {
  await init;
  const entry = resolve(DIST_ROOT, `${ENTRY}.js`);
  if (!existsSync(entry)) throw new Error(`缺少 ${entry}；请先运行 yarn build。`);
  const pending = [entry];
  const visited = new Set<string>();
  const externalImports = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const imported of parse(source)[0]) {
      const specifier = source.slice(imported.s, imported.e);
      if (!specifier.startsWith('.')) {
        externalImports.add(specifier);
        continue;
      }
      const target = resolve(dirname(file), specifier);
      if (existsSync(target) && !visited.has(target)) pending.push(target);
    }
  }
  return {
    modules: [...visited]
      .map((file) => relative(DIST_ROOT, file).replaceAll('\\', '/'))
      .sort(),
    externalImports: [...externalImports].sort(),
  };
}

describe('published reference Executor API allowlist', () => {
  it('locks the values and types of the eval-hosts entry', async () => {
    const published = await import(pathToFileURL(join(DIST_ROOT, `${ENTRY}.js`)).href);
    expect(Object.keys(published).sort()).toEqual([...PUBLIC_API.values].sort());
    expect(declarationExports()).toEqual({
      values: [...PUBLIC_API.values].sort(),
      types: [...PUBLIC_API.types].sort(),
    });
  });

  it('documents every allowlisted export in both API references', () => {
    const references = [
      readFileSync(resolve('docs/reference/eval-hosts-api.md'), 'utf8'),
      readFileSync(resolve('docs/zh/reference/eval-hosts-api.md'), 'utf8'),
    ];
    for (const exportName of [...PUBLIC_API.values, ...PUBLIC_API.types]) {
      for (const reference of references) {
        expect(reference).toContain(`\`${exportName}\``);
      }
    }
  });

  it('ships the adapter without the private host seam or a delivery surface', async () => {
    const { modules, externalImports } = await moduleGraph();
    expect(modules).toContain(`${ENTRY}.js`);
    expect(modules).toContain('eval-workflows/hosts/adapters/codex/reference-executor.js');
    expect(modules.filter((file) => (
      file.startsWith('eval-workflows/hosts/composition/')
      || file.startsWith('eval-workflows/hosts/evaluators/')
      || file.startsWith('eval-workflows/hosts/input-resolution/')
      || file.startsWith('eval-workflows/hosts/resource-leases/')
      || file === 'eval-workflows/hosts/application.js'
      || file === 'eval-workflows/hosts/types.js'
    ))).toEqual([]);
    expect(modules.filter((file) => /^(?:cli|studio|mcp|dsh-plugin|observability)\//.test(file)))
      .toEqual([]);
    expect(externalImports.filter((specifier) => !specifier.startsWith('node:')))
      .toEqual(['zod']);
  });
});
