import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = resolve('src');
const FORBIDDEN_FILES = [
  'src/types/report.ts',
  'src/types/storage.ts',
  'src/types/eval.ts',
  'src/types/judge.ts',
  'src/eval-workflows/run-evaluation.ts',
  'src/eval-workflows/evaluation-pipeline.ts',
  'src/eval-workflows/batch-evaluation-workflow.ts',
  'src/server/report-store.ts',
  'src/server/indexed-report-store.ts',
  'src/server/job-store.ts',
  'src/renderer/html-renderer.ts',
  'src/renderer/test-view.ts',
  'src/artifact-graph/eval.ts',
  'src/managed/version-scores.ts',
] as const;

const FORBIDDEN_SPECIFIER_FRAGMENTS = [
  '/types/report',
  '/types/storage',
  '/types/eval',
  '/types/judge',
  '/eval-workflows/run-evaluation',
  '/eval-workflows/evaluation-pipeline',
  '/server/report-store',
  '/server/indexed-report-store',
  '/server/job-store',
  '/renderer/html-renderer',
  '/renderer/test-view',
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && ['.ts', '.tsx', '.mts', '.cts'].includes(extname(entry.name)) ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
}

describe('legacy evaluation implementation removal', () => {
  it('keeps deleted legacy implementation files absent', () => {
    expect(FORBIDDEN_FILES.filter((file) => existsSync(resolve(file)))).toEqual([]);
  });

  it('prevents production code from rebuilding dependencies on deleted modules', () => {
    const violations = sourceFiles(SRC_ROOT).flatMap((file) => (
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => FORBIDDEN_SPECIFIER_FRAGMENTS.some((fragment) => specifier.includes(fragment)))
        .map((specifier) => `${file}: ${specifier}`)
    ));
    expect(violations).toEqual([]);
  });

  it('keeps the public type barrel free of the legacy report and storage schemas', () => {
    const barrel = readFileSync(resolve('src/types/index.ts'), 'utf8');
    expect(barrel).not.toMatch(/['"]\.\/report\.js['"]/);
    expect(barrel).not.toMatch(/['"]\.\/storage\.js['"]/);
    const inputContracts = sourceFiles(resolve('src/inputs/contracts'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    expect(inputContracts).not.toContain('interface EvaluationJob');
    expect(inputContracts).not.toContain('interface EvaluationRequest');
  });

  it('does not retain legacy managed evidence compatibility', () => {
    const managed = readFileSync(resolve('src/managed/contracts.ts'), 'utf8');
    expect(managed).toContain("evidenceSource: 'evaluation-core'");
    expect(managed).not.toContain("evidenceSource?: 'evaluation-core'");
    expect(managed).not.toContain('comparability?:');
  });
});
