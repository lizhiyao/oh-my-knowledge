import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'vitest';

const ROOT = process.cwd();
const SOURCE_ROOT = join(ROOT, 'src');
const ALLOWED = new Set([
  'src/omk-layout/index.ts',
  // Artifact-scoped authoring metadata is explicitly outside project-root layout v2.
  'src/inputs/sample-locator.ts',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('OMK layout path assembly guard', () => {
  it('keeps project/global root construction in the layout module', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const projectPath = relative(ROOT, path).split('\\').join('/');
      if (ALLOWED.has(projectPath)) return [];
      const lines = readFileSync(path, 'utf8').split('\n');
      return lines.flatMap((line, index) => (
        /\b(?:join|resolve)\([^\n]*(?:['"]\.omk['"]|['"]\.oh-my-knowledge['"])/u.test(line)
          ? [`${projectPath}:${index + 1}`]
          : []
      ));
    });
    assert.deepEqual(violations, []);
  });

  it('keeps eval materialization and lease directory names in the global layout', () => {
    const violations = sourceFiles(SOURCE_ROOT).flatMap((path) => {
      const projectPath = relative(ROOT, path).split('\\').join('/');
      if (projectPath === 'src/omk-layout/index.ts') return [];
      const lines = readFileSync(path, 'utf8').split('\n');
      return lines.flatMap((line, index) => (
        /['"](?:resolved-inputs|runtime-leases|resource-leases)['"]/u.test(line)
          ? [`${projectPath}:${index + 1}`]
          : []
      ));
    });
    assert.deepEqual(violations, []);
  });
});
