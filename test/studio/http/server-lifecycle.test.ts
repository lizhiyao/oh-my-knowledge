import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, vi } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';

const temporaryDirectories: string[] = [];
const runningServers: Array<ReturnType<typeof createReportServer>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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
  it('cleans up a failed presentation preparation before retrying', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-presentation-'));
    temporaryDirectories.push(observationsDir);
    let preparations = 0;
    let closes = 0;
    const server = createReportServer({ port: 0, observationsDir }, {
      async prepare() { preparations += 1; if (preparations === 1) throw new Error('prepare failed'); },
      async handle() { return false; },
      async close() { closes += 1; },
    });
    runningServers.push(server);
    await assert.rejects(server.start(), /prepare failed/);
    assert.equal(closes, 1);
    const url = await server.start();
    assert.equal((await fetch(`${url}/health`)).status, 200);
    await server.stop();
    assert.equal(closes, 2);
    assert.equal(server.getUrl(), null);
  });

  it('serializes concurrent starts and a stop submitted while starting', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-concurrent-'));
    temporaryDirectories.push(observationsDir);
    const server = createReportServer({ port: 0, observationsDir });
    runningServers.push(server);
    const first = server.start();
    const second = server.start();
    const stopped = server.stop();
    const urls = await Promise.all([first, second]);
    assert.equal(urls[0], urls[1]);
    await stopped;
    assert.equal(server.getUrl(), null);
    await waitUntilUnavailable(urls[0]);
    const restarted = await server.start();
    assert.equal((await fetch(`${restarted}/health`)).status, 200);
  });

  it('does not expose catalog exceptions to the browser', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-error-'));
    temporaryDirectories.push(observationsDir);
    const server = createReportServer({ port: 0, observationsDir, conversationCatalog: {
      async listConversations() { throw new Error('token=secret /private/user/catalog'); },
      async getConversation() { return undefined; },
      async loadTaskTrajectory() { return undefined; },
    } });
    runningServers.push(server);
    for (const path of ['/observe', '/api/conversations/activity']) {
      const response = await fetch(`${await server.start()}${path}`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'studio_source_unavailable' });
    }
  });

  it('can retry after a failed listen and formats a usable IPv6 URL', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-listen-retry-'));
    temporaryDirectories.push(observationsDir);
    const server = createReportServer({ observationsDir, host: '::1' });
    runningServers.push(server);
    vi.stubEnv('OMK_REPORT_PORT', '-1');
    await assert.rejects(server.start());
    assert.equal(server.getUrl(), null);
    vi.stubEnv('OMK_REPORT_PORT', '0');
    const url = await server.start();
    assert.match(url, /^http:\/\/\[::1\]:\d+$/);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  });

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
    assert.equal(server.getUrl(), null);
    const restarted = await server.start();
    assert.equal((await fetch(`${restarted}/health`)).status, 200);
  });

  it('answers 500 with a stable marker when the host pipeline itself crashes', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-internal-'));
    temporaryDirectories.push(observationsDir);
    const server = createReportServer({ port: 0, observationsDir }, {
      async prepare() {},
      async handle() { throw new Error('render pipeline crashed'); },
      async close() {},
    });
    runningServers.push(server);

    const response = await fetch(`${await server.start()}/observe`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'studio_internal_error');
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
  });
});
