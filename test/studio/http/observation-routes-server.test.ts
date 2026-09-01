import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? 'GET',
      headers: options.headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body,
      }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

describe('Studio observation routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-observation-routes-'));
  const observationsDir = join(root, 'observations');
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    server = createReportServer({
      port: 0,
      observationsDir,
      analysesDir: join(root, 'analyses'),
      doctorsDir: join(root, 'doctors'),
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the canonical inbox routes and preserves legacy redirect semantics', async () => {
    const page = await request(`${baseUrl}/observe-inbox?skill=audit`);
    assert.equal(page.status, 200);

    const items = await request(`${baseUrl}/api/observe-inbox?severity=high&limit=1`);
    assert.equal(items.status, 200);
    assert.deepEqual(JSON.parse(items.body), []);

    const pageRedirect = await request(`${baseUrl}/observations/inbox?skill=audit`);
    assert.equal(pageRedirect.status, 302);
    assert.equal(pageRedirect.headers.location, '/observe-inbox?skill=audit');

    const apiRedirect = await request(
      `${baseUrl}/api/observations/review-state?targetType=skill&targetId=audit`,
      { method: 'DELETE' },
    );
    assert.equal(apiRedirect.status, 307);
    assert.equal(
      apiRedirect.headers.location,
      '/api/observe-inbox/review-state?targetType=skill&targetId=audit',
    );
  });

  it('validates and persists review-state mutations through the shared request boundary', async () => {
    const endpoint = `${baseUrl}/api/observe-inbox/review-state`;
    const contentTypeRejected = await request(endpoint, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(contentTypeRejected.status, 415);

    const crossOriginRejected = await request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://untrusted.example',
      },
      body: '{}',
    });
    assert.equal(crossOriginRejected.status, 403);

    const malformed = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    assert.equal(malformed.status, 400);

    const saved = await request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetType: 'skill',
        targetId: 'audit',
        verdict: 'reviewed',
      }),
    });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).entries['skill:audit'].verdict, 'reviewed');

    const loaded = await request(endpoint);
    assert.equal(loaded.status, 200);
    assert.equal(JSON.parse(loaded.body).entries['skill:audit'].targetId, 'audit');

    const deleted = await request(`${endpoint}?targetType=skill&targetId=audit`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 200);
    assert.equal(JSON.parse(deleted.body).entries['skill:audit'], undefined);

    const unsupported = await request(endpoint, { method: 'PUT' });
    assert.equal(unsupported.status, 405);
  });

  it('uses one resolved directory snapshot per diagnostics request', async () => {
    let analysesResolutions = 0;
    let doctorResolutions = 0;
    const snapshotServer = createReportServer({
      port: 0,
      observationsDir,
      analysesDir: () => {
        analysesResolutions += 1;
        return join(root, 'analyses');
      },
      doctorsDir: () => {
        doctorResolutions += 1;
        return join(root, 'doctors');
      },
    });
    const snapshotUrl = await snapshotServer.start();
    try {
      const diagnostics = await request(`${snapshotUrl}/api/observe-inbox/diagnostics`);
      assert.equal(diagnostics.status, 200);
      assert.equal(analysesResolutions, 1);
      assert.equal(doctorResolutions, 1);
    } finally {
      await snapshotServer.stop();
    }
  });
});
