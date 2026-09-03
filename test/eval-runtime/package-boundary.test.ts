import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { describe, expect, it } from 'vitest';

const DIST_ROOT = resolve('dist');
const ENTRY = resolve(DIST_ROOT, 'eval-runtime/index.js');

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
  it('does not load product workflows, delivery surfaces, or provider implementations', async () => {
    if (!existsSync(ENTRY)) throw new Error('缺少 dist/eval-runtime/index.js；请先运行 yarn build。');
    const { modules, externalImports } = await moduleGraph(ENTRY);

    expect(modules).toContain('eval-runtime/index.js');
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
});
