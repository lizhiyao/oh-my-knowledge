import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Studio HTTP lifecycle boundary', () => {
  it('keeps listener lifecycle independent from business routes and projections', () => {
    const listener = readFileSync('src/studio/http/report-server.ts', 'utf8');
    const relativeImports = [...listener.matchAll(/from ['"](\.[^'"]+)['"]/g)]
      .map((match) => match[1]);

    // 生命周期与地址投影只依赖 http 层，不依赖业务投影。
    expect([...new Set(relativeImports)].sort()).toEqual([
      './app-host.js',
      './contracts.js',
      './errors.js',
      './request-handler.js',
      './server-addresses.js',
    ]);
    expect(listener).not.toMatch(/studio\/(?:application|view-models|web)/);
    expect(listener).not.toMatch(/\.\.\/(?:\.\.\/)?(?:diagnosis|doctor|evidence|observability|shared)\//);
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
