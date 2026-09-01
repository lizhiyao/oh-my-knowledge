import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#537 migration boundary', () => {
  it('keeps the Core renderer and handler independent from legacy report models', () => {
    const surface = [
      'src/studio/core-runs/renderer.ts',
      'src/studio/core-runs/route-handler.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const forbidden of [
      "from '../types/report",
      'ReportStore',
      'ReportDocument',
      'VariantResult',
      'queryRunList',
      'renderRunList',
    ]) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface).toContain('CoreStudioCatalog');
    expect(surface).toContain('CoreStudioRunDetail');
  });

  it('wires the Core-only handler into the production report server', () => {
    const server = readFileSync('src/studio/http/report-server.ts', 'utf8');

    expect(server).toContain('createCoreStudioRouteHandler');
    expect(server).toContain("from '../core-runs/index.js'");
  });
});
