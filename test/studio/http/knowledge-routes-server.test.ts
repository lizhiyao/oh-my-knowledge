import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

describe('Studio knowledge routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-knowledge-routes-'));
  const managedDir = join(root, 'managed');
  let managedResolutions = 0;
  let server: ReturnType<typeof createReportServer> | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    server = createReportServer({
      port: 0,
      analysesDir: join(root, 'analyses'),
      doctorsDir: join(root, 'doctors'),
      observationsDir: join(root, 'observations'),
      managedDir: () => {
        managedResolutions += 1;
        return managedDir;
      },
    });
    baseUrl = await server.start();
  });

  afterAll(async () => {
    await server?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps managed directory resolution lazy and scoped to managed requests', async () => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal(managedResolutions, 0);

    const api = await fetch(`${baseUrl}/api/managed`);
    assert.equal(api.status, 200);
    assert.deepEqual(await api.json(), { schemaVersion: 1, rows: [] });
    assert.equal(managedResolutions, 1);

    assert.equal((await fetch(`${baseUrl}/managed`)).status, 200);
    assert.equal(managedResolutions, 2);

    assert.equal((await fetch(`${baseUrl}/not-found`)).status, 404);
    assert.equal(managedResolutions, 2);
  });

  it('preserves observe-health redirects and the knowledge-owned chart asset', async () => {
    const pageRedirect = await fetch(`${baseUrl}/analyses?lang=en`, { redirect: 'manual' });
    assert.equal(pageRedirect.status, 302);
    assert.equal(pageRedirect.headers.get('location'), '/observe-health?lang=en');

    const apiRedirect = await fetch(`${baseUrl}/api/analyses/report-a?lang=en`, {
      redirect: 'manual',
    });
    assert.equal(apiRedirect.status, 307);
    assert.equal(
      apiRedirect.headers.get('location'),
      '/api/observe-health/report-a?lang=en',
    );

    const chart = await fetch(`${baseUrl}/static/chart.js`);
    assert.equal(chart.status, 200);
    assert.match(chart.headers.get('content-type') ?? '', /application\/javascript/);
    assert.ok((await chart.text()).length > 1000);
  });
});
