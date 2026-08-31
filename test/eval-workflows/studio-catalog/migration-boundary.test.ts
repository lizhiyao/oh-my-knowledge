import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('#537 migration boundary', () => {
  it('keeps the Core renderer and handler independent from legacy report models', () => {
    const surface = [
      'src/renderer/core-run-renderer.ts',
      'src/server/core-studio-route-handler.ts',
    ].map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const forbidden of [
      "from '../eval-core/",
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

  it('does not wire the new handler into the production report server yet', () => {
    const server = readFileSync('src/server/report-server.ts', 'utf8');
    const legacyRenderer = readFileSync('src/renderer/html-renderer.ts', 'utf8');

    expect(server).not.toContain('createCoreStudioRouteHandler');
    expect(server).not.toContain('core-studio-route-handler');
    expect(legacyRenderer).not.toContain('core-run-renderer');
  });
});
