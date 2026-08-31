import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#535 Core Studio catalog boundary', () => {
  it('does not import legacy report/storage types or switch Studio consumers', () => {
    const files = [
      'src/eval-workflows/studio-catalog/catalog.ts',
      'src/eval-workflows/studio-catalog/contracts.ts',
      'src/eval-workflows/studio-catalog/projection.ts',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toContain('types/report');
    expect(source).not.toContain('types/storage');
    expect(source).not.toMatch(/\bReportStore\b/);
    expect(source).not.toMatch(/\bVariantResult\b/);
    expect(source).not.toMatch(/\bResultEntry\b/);
    expect(source).not.toMatch(/\.llmScore\b/);
    expect(source).not.toMatch(/\.compositeScore\b/);

    const production = [
      'src/server/report-server.ts',
      'src/server/report-store.ts',
      'src/server/skill-index.ts',
      'src/cli/commands/studio.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(production).not.toContain('studio-catalog');
    expect(production).not.toContain('createCoreStudioCatalog');
    expect(production).not.toContain('projectCoreStudioRunDetail');
  });
});
