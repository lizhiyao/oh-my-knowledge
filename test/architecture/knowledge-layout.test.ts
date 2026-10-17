import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_ROOT = resolve('src/knowledge');

describe('knowledge 领域布局', () => {
  it('纯契约域保持稳定的顶层所有权划分', () => {
    const entries = readdirSync(DOMAIN_ROOT, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(['entities', 'library']);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['AGENTS.md', 'contracts.ts', 'history.ts', 'store.ts', 'tags.ts', 'validation.ts']);
  });

  it('entities 与 library 子域保持已登记的契约面', () => {
    const entities = readdirSync(resolve(DOMAIN_ROOT, 'entities'), { withFileTypes: true });
    expect(entities.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual([
        'contracts.ts', 'history.ts', 'identity.ts',
        'link-invocation-state.ts', 'link-invocation.ts', 'links.ts', 'validation.ts',
      ]);
    const library = readdirSync(resolve(DOMAIN_ROOT, 'library'), { withFileTypes: true });
    expect(library.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['contracts.ts', 'history.ts', 'write-errors.ts']);
  });
});
