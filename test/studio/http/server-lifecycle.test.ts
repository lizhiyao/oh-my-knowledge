import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it, vi } from 'vitest';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { projectServerAddresses } from '../../../src/studio/http/server-addresses.js';

const temporaryDirectories: string[] = [];
const runningServers: Array<ReturnType<typeof createReportServer>> = [];
const foreignServers: Server[] = [];
let projectedBoundHost: string | undefined;

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    createServer: (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      const server = actual.createServer(handler);
      const address = server.address.bind(server);
      const override = projectedBoundHost;
      // A controlled non-loopback bind result while retaining real local TCP/HTTP delivery.
      if (override) server.address = () => {
        const bound = address();
        return bound && typeof bound === 'object' ? { ...bound, address: override } : bound;
      };
      return server;
    },
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  projectedBoundHost = undefined;
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
  await Promise.all(foreignServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
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
  it('accepts the actual address projected from a hostname bind without accepting arbitrary DNS', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-bound-host-'));
    temporaryDirectories.push(observationsDir);
    projectedBoundHost = '192.0.2.8';
    const server = createReportServer({ port: 0, host: 'localhost', observationsDir });
    runningServers.push(server);
    const url = await server.start();
    assert.equal(new URL(url).hostname, '192.0.2.8');
    const send = (host: string) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: 'localhost', port: new URL(url).port, path: '/health', headers: { Host: host } }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode!));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(await send(new URL(url).host), 200, 'the startup URL must pass the HTTP Host guard');
    assert.equal(await send('localhost'), 200, 'the explicitly configured hostname remains usable');
    assert.equal(await send('evil.example'), 403, 'binding to a hostname must not allow arbitrary DNS authorities');
    assert.equal(await send('192.0.2.9'), 403, 'only the actual bound address is added');
  });

  it('requires explicit takeover before probing or stopping an occupied OMK listener', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-takeover-'));
    temporaryDirectories.push(observationsDir);
    const original = createReportServer({ port: 0, observationsDir });
    runningServers.push(original);
    const url = await original.start();
    const port = Number(new URL(url).port);
    const rejected = createReportServer({ port, observationsDir });
    runningServers.push(rejected);
    await assert.rejects(rejected.start(), /already in use[\s\S]*--takeover/);
    assert.equal(original.getUrl(), url);
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, service: 'omk' });

    const replacement = createReportServer({ port, observationsDir, takeover: true });
    runningServers.push(replacement);
    assert.equal(await replacement.start(), url);
    assert.equal(original.getUrl(), null, 'only the explicit takeover may stop the original service');
    assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true, service: 'omk' });
  });

  it('never sends shutdown by default and fails closed for unverifiable or redirecting listeners', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-no-takeover-'));
    temporaryDirectories.push(observationsDir);
    for (const mode of ['default', 'other', 'health-redirect', 'health-error', 'shutdown-redirect', 'shutdown-error'] as const) {
      const requests: string[] = [];
      const existing = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if ((mode === 'health-redirect' && req.url === '/health') || (mode === 'shutdown-redirect' && req.url === '/api/shutdown')) {
          res.writeHead(302, { Location: '/redirect-target' }); res.end(); return;
        }
        res.writeHead(mode === 'health-error' || mode === 'shutdown-error' && req.url === '/api/shutdown' ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(req.url === '/health' ? { ok: true, service: mode === 'other' ? 'other' : 'omk' } : { ok: true }));
      });
      foreignServers.push(existing);
      await new Promise<void>((resolve) => existing.listen(0, '127.0.0.1', resolve));
      const port = (existing.address() as AddressInfo).port;
      const incoming = createReportServer({ port, observationsDir, takeover: mode !== 'default' });
      runningServers.push(incoming);
      await assert.rejects(incoming.start(), mode.startsWith('shutdown-') ? /did not acknowledge shutdown/ : /already in use/);
      assert.equal(incoming.getUrl(), null);
      assert.deepEqual(requests, mode === 'default' ? [] : mode.startsWith('shutdown-')
        ? ['GET /health', 'POST /api/shutdown'] : ['GET /health'], mode);
      assert.equal(existing.listening, true, mode);
    }
  });

  it('projects the actual bound family/port and only usable same-family network candidates', () => {
    const interfaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', cidr: '127.0.0.1/8', mac: '00:00:00:00:00:00' } as const],
      en0: [
        { address: '192.0.2.8', family: 'IPv4', internal: false, netmask: '255.255.255.0', cidr: '192.0.2.8/24', mac: '00:00:00:00:00:00' } as const,
        { address: '2001:db8::8', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', cidr: '2001:db8::8/64', mac: '00:00:00:00:00:00', scopeid: 0 } as const,
        { address: 'fe80::8', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', cidr: 'fe80::8/64', mac: '00:00:00:00:00:00', scopeid: 4 } as const,
      ],
    };
    assert.deepEqual(projectServerAddresses({ address: '0.0.0.0', family: 'IPv4', port: 58123 }, interfaces), {
      bindAddress: '0.0.0.0:58123', url: 'http://127.0.0.1:58123', networkUrls: ['http://192.0.2.8:58123'],
    });
    assert.deepEqual(projectServerAddresses({ address: '::', family: 'IPv6', port: 58124 }, interfaces), {
      bindAddress: '[::]:58124', url: 'http://[::1]:58124', networkUrls: ['http://[2001:db8::8]:58124'],
    });
    assert.deepEqual(projectServerAddresses({ address: '127.0.0.1', family: 'IPv4', port: 58125 }, interfaces), {
      bindAddress: '127.0.0.1:58125', url: 'http://127.0.0.1:58125', networkUrls: [],
    });
  });

  it('rejects rebinding before pages or API handlers while preserving loopback and explicit LAN access', async () => {
    const observationsDir = mkdtempSync(join(tmpdir(), 'omk-studio-host-'));
    temporaryDirectories.push(observationsDir);
    for (const host of ['127.0.0.1', '0.0.0.0']) {
      let pageCalls = 0;
      const server = createReportServer({ port: 0, host, observationsDir }, {
        async prepare() {},
        async handle(req, res) {
          if (req.url !== '/observe') return false;
          pageCalls += 1;
          res.end('page');
          return true;
        },
        async close() {},
      });
      runningServers.push(server);
      const url = await server.start();
      const addresses = server.getAddresses();
      assert.equal(addresses?.url, url);
      assert.equal(addresses?.bindAddress, `${host}:${new URL(url).port}`);
      if (host === '127.0.0.1') assert.deepEqual(addresses.networkUrls, []);
      const send = (path: string, authority: string | string[], method = 'GET') => new Promise<number>((resolve, reject) => {
        const req = request(`${url}${path}`, {
          method, headers: [
            ...(Array.isArray(authority) ? authority : [authority]).flatMap(value => ['Host', value]),
            'Origin', 'http://evil.example', 'Sec-Fetch-Site', 'same-origin',
          ],
        }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
        req.on('error', reject);
        req.end();
      });
      for (const authority of ['evil.example', 'localhost.evil.example', 'evil.example@localhost', ['localhost', 'evil.example']]) {
        for (const [path, method] of [['/observe', 'GET'], ['/health', 'GET'], ['/api/shutdown', 'POST']]) {
          assert.equal(await send(path, authority, method), 403);
        }
      }
      assert.equal(pageCalls, 0, 'Host 校验必须先于 Next 页面宿主');
      for (const authority of ['localhost', '127.0.0.1:80', '[::1]:7799']) {
        assert.equal(await send('/health', authority), 200);
      }
      assert.equal(await send('/health', '192.0.2.10:7799'), host === '0.0.0.0' ? 200 : 403);
      assert.equal(await send('/observe', 'localhost'), 200);
      assert.equal(pageCalls, 1);
      await server.stop();
    }
  });

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
    const response = await fetch(`${await server.start()}/api/conversations/activity`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'studio_source_unavailable' });
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
    assert.equal(server.getAddresses()?.bindAddress, `[::1]:${new URL(url).port}`);
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
    assert.equal(server.getAddresses(), null);
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
