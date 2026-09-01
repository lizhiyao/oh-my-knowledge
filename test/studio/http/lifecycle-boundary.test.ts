import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Studio HTTP lifecycle boundary', () => {
  it('keeps listener lifecycle independent from business routes and projections', () => {
    const listener = readFileSync('src/studio/http/report-server.ts', 'utf8');
    const relativeImports = [...listener.matchAll(/from ['"](\.[^'"]+)['"]/g)]
      .map((match) => match[1]);

    expect(relativeImports).toEqual([
      './contracts.js',
      './errors.js',
      './request-handler.js',
      './contracts.js',
    ]);
    expect(listener).not.toMatch(/studio\/(?:application|core-runs|presentation)/);
    expect(listener).not.toMatch(/\.\.\/(?:\.\.\/)?(?:diagnosis|doctor|managed|measurement-artifacts|observability|shared)\//);
  });

  it('keeps request composition independent from port binding and takeover', () => {
    const composition = readFileSync('src/studio/http/request-handler.ts', 'utf8');

    for (const forbidden of [
      'createServer',
      '.listen(',
      'AddressInfo',
      'EADDRINUSE',
      'OMK_REPORT_HOST',
      'lsof -i:',
    ]) {
      expect(composition).not.toContain(forbidden);
    }
  });
});
