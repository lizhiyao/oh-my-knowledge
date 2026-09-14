import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Studio HTTP lifecycle boundary', () => {
  it('keeps listener lifecycle independent from business routes and projections', () => {
    const listener = readFileSync('src/studio/http/report-server.ts', 'utf8');
    const relativeImports = [...listener.matchAll(/from ['"](\.[^'"]+)['"]/g)]
      .map((match) => match[1]);

    // 边界是「只依赖 http 层内这四个模块」，不是每条 import 的书写顺序与条数。
    expect([...new Set(relativeImports)].sort()).toEqual([
      './app-host.js',
      './contracts.js',
      './errors.js',
      './request-handler.js',
    ]);
    expect(listener).not.toMatch(/studio\/(?:application|view-models|web)/);
    expect(listener).not.toMatch(/\.\.\/(?:\.\.\/)?(?:diagnosis|doctor|managed|evidence|observability|shared)\//);
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
