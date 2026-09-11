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

    const managed = await fetch(`${baseUrl}/knowledge/managed`);
    assert.equal(managed.status, 200);
    assert.match(await managed.text(), /<body class="studio-workspace">/);
    assert.equal(managedResolutions, 2);

    assert.equal((await fetch(`${baseUrl}/not-found`)).status, 404);
    assert.equal(managedResolutions, 2);
  });

  it('serves the health page without old page aliases and preserves the API and chart asset', async () => {
    assert.equal((await fetch(`${baseUrl}/observe/health?lang=en`)).status, 200);
    const pageRedirect = await fetch(`${baseUrl}/analyses?lang=en`, { redirect: 'manual' });
    assert.equal(pageRedirect.status, 404);
    assert.equal(pageRedirect.headers.get('location'), null);

    const apiLegacy = await fetch(`${baseUrl}/api/analyses/report-a?lang=en`, {
      redirect: 'manual',
    });
    assert.equal(apiLegacy.status, 404);
    assert.equal(apiLegacy.headers.get('location'), null);

    const chart = await fetch(`${baseUrl}/static/chart.js`);
    assert.equal(chart.status, 200);
    assert.match(chart.headers.get('content-type') ?? '', /application\/javascript/);
    assert.ok((await chart.text()).length > 1000);
  });

  it('answers analyses-diff without from/to as a stable 400 contract', async () => {
    const response = await fetch(`${baseUrl}/api/analyses-diff`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'missing_query_params' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});
