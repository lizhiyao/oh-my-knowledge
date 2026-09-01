import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

const temporaryDirectories: string[] = [];
const runningServers: Array<ReturnType<typeof createReportServer>> = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitUntilUnavailable(url: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await fetch(`${url}/health`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Studio server remained reachable after the shutdown grace period.');
}

describe('Studio server lifecycle', () => {
  it('starts idempotently and shuts down after acknowledging the request', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-lifecycle-'));
    temporaryDirectories.push(observationsDir);
    const server = createReportServer({ port: 0, observationsDir });
    runningServers.push(server);

    const url = await server.start();
    assert.equal(await server.start(), url);
    const health = await fetch(`${url}/health`);
    assert.deepEqual(await health.json(), { ok: true, service: 'omk' });

    const shutdown = await fetch(`${url}/api/shutdown`, { method: 'POST' });
    assert.equal(shutdown.status, 200);
    assert.deepEqual(await shutdown.json(), { ok: true });
    await waitUntilUnavailable(url);
  });
});
