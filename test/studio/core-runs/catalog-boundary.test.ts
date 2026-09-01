import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#535 Core Studio catalog boundary', () => {
  it('does not import legacy report/storage types and is the production evaluation catalog', () => {
    const files = [
      'src/studio/core-runs/catalog.ts',
      'src/studio/core-runs/contracts.ts',
      'src/studio/core-runs/projection.ts',
    ];
    const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toContain('types/report');
    expect(source).not.toContain('types/storage');
    expect(source).not.toMatch(/\bReportStore\b/);
    expect(source).not.toMatch(/\bVariantResult\b/);
    expect(source).not.toMatch(/\bResultEntry\b/);
    expect(source).not.toMatch(/\.llmScore\b/);
    expect(source).not.toMatch(/\.compositeScore\b/);

    const studioCommand = readFileSync('src/cli/commands/studio.ts', 'utf8');
    const reportServer = readFileSync('src/server/report-server.ts', 'utf8');
    expect(studioCommand).toContain('createCoreStudioCatalog');
    expect(studioCommand).toContain('createOverlayCoreRunArtifactStore');
    expect(studioCommand).not.toContain('createOverlayReportStore');
    expect(reportServer).toContain('coreStudioCatalog');
    expect(reportServer).toContain('createCoreStudioRouteHandler');
  });
});
