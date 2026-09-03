import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { describe, expect, it } from 'vitest';

const DIST_ROOT = resolve('dist');
const ENTRIES = [
  'eval-runtime/index.js',
  'eval-runtime/advanced.js',
  'eval-runtime/contracts.js',
] as const;

async function moduleGraph(entry: string): Promise<{
  modules: string[];
  externalImports: string[];
}> {
  await init;
  const pending = [entry];
  const visited = new Set<string>();
  const externalImports = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    const [imports] = parse(source);
    for (const imported of imports) {
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

describe('published eval-runtime dependency boundary', () => {
  for (const entry of ENTRIES) {
    it(`${entry} does not load products, delivery surfaces, or providers`, async () => {
      const resolvedEntry = resolve(DIST_ROOT, entry);
      if (!existsSync(resolvedEntry)) throw new Error(`缺少 ${entry}；请先运行 yarn build。`);
      const { modules, externalImports } = await moduleGraph(resolvedEntry);

      expect(modules).toContain(entry);
      expect(modules.some((file) => file.startsWith('eval-core/'))).toBe(true);
      expect(modules.filter((file) => /^(?:cli|studio|mcp|dsh-plugin|eval-workflows)\//.test(file)))
        .toEqual([]);
      expect(modules.filter((file) => /^executors\/(?!contracts\/)/.test(file))).toEqual([]);
      expect(externalImports.filter((specifier) => (
        specifier.startsWith('@anthropic-ai/')
        || specifier.startsWith('@openai/')
        || specifier.startsWith('@modelcontextprotocol/')
      ))).toEqual([]);
    });
  }

  it('keeps legacy and lifecycle SPI out of the canonical entry graph', async () => {
    const { modules } = await moduleGraph(resolve(DIST_ROOT, 'eval-runtime/index.js'));
    expect(modules).not.toContain('eval-runtime/advanced.js');
    expect(modules).not.toContain('eval-runtime/adapters/executor-fn.js');
  });

  it('keeps implementation modules out of the contracts entry graph', async () => {
    const { modules } = await moduleGraph(resolve(DIST_ROOT, 'eval-runtime/contracts.js'));
    expect(modules.filter((file) => (
      file.startsWith('eval-runtime/adapters/')
      || file === 'eval-runtime/runtime.js'
      || file === 'eval-runtime/runner.js'
      || file === 'eval-runtime/judges/rubric-judge.js'
    ))).toEqual([]);
  });
});
