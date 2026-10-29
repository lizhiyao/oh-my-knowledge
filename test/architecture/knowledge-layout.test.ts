import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_ROOT = resolve('src/knowledge');

describe('knowledge 领域布局', () => {
  it('知识域收拢纯核心、提取、关联、应用与载体生命周期', () => {
    const entries = readdirSync(DOMAIN_ROOT, { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(['adapters', 'application', 'artifacts', 'entities', 'entity-library', 'entity-linking', 'extraction', 'measurement', 'migration']);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['AGENTS.md', 'associations.ts', 'contracts.ts', 'history.ts', 'review-history.ts', 'reviews.ts', 'store.ts', 'tags.ts', 'validation.ts']);
  });

  it('载体按生命周期子域表达稳定所有权', () => {
    const entries = readdirSync(resolve(DOMAIN_ROOT, 'artifacts'), { withFileTypes: true });
    expect(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort())
      .toEqual(['authoring', 'doctor', 'skills', 'sources']);
    expect(entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort())
      .toEqual(['AGENTS.md', 'contracts.ts']);
  });
});
