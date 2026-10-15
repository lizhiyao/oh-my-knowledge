import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, it } from 'vitest';
import { FileObservationCaptureStore } from '../../src/mcp/capture-store.js';
import { FileObservationFeedbackStore } from '../../src/mcp/feedback-store.js';
import {
  startObservationMcpHttpServer,
} from '../../src/mcp/http.js';
import {
  OBSERVATION_CAPTURE_SCOPE,
  OBSERVATION_DRAFT_SCOPE,
  OBSERVATION_READ_SCOPE,
  OBSERVATION_REVIEW_SCOPE,
  ObservationPrincipalError,
  type ObservationPrincipal,
  type PrincipalResolver,
} from '../../src/mcp/principal.js';

const TOKEN_PRINCIPALS: Record<string, ObservationPrincipal> = {
  'token-a': {
    tenantId: 'tenant-a',
    principalId: 'principal-a',
    scopes: [
      OBSERVATION_CAPTURE_SCOPE,
      OBSERVATION_READ_SCOPE,
      OBSERVATION_REVIEW_SCOPE,
      OBSERVATION_DRAFT_SCOPE,
    ],
  },
  'token-b': {
    tenantId: 'tenant-a',
    principalId: 'principal-b',
    scopes: [
      OBSERVATION_CAPTURE_SCOPE,
      OBSERVATION_READ_SCOPE,
      OBSERVATION_REVIEW_SCOPE,
      OBSERVATION_DRAFT_SCOPE,
    ],
  },
  'token-no-scope': {
    tenantId: 'tenant-a',
    principalId: 'principal-c',
    scopes: [],
  },
};

const resolver: PrincipalResolver<IncomingMessage> = {
  async resolve(request) {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new ObservationPrincipalError('unauthenticated', 'Missing credential.');
    }
    const token = authorization.slice('Bearer '.length);
    if (token === 'wrong-tenant') {
      throw new ObservationPrincipalError('tenant_mismatch', 'Tenant mismatch.');
    }
    const principal = TOKEN_PRINCIPALS[token];
    if (!principal) {
      throw new ObservationPrincipalError('unauthenticated', 'Invalid credential.');
    }
    return principal;
  },
};

describe('OMK observation Streamable HTTP server', () => {
  it('contains malformed request targets and continues serving subsequent requests', async () => {
    let writes = 0;
    const started = await startObservationMcpHttpServer({ captureStore: {
      async create() { writes += 1; throw new Error('must not write'); },
    } });
    try {
      for (const target of ['//[', 'http://[::1', 'http://localhost:99999/mcp']) {
        assert.equal(await postRaw(started.url, { target }), 400);
      }
      assert.equal((await fetch(started.url)).status, 405);
      assert.equal(writes, 0);
    } finally { await started.close(); }
  });

  it.each([
    { failure: 'deadline', status: 408 },
    { failure: 'route', status: 404 },
    { failure: 'authentication', status: 401 },
    { failure: 'scope', status: 403 },
  ])('closes an incomplete request rejected by $failure', async ({ failure, status }) => {
    const started = await startObservationMcpHttpServer({
      captureStore: { async create() { throw new Error('must not write'); } },
      requestBodyTimeoutMs: 20,
      ...(['authentication', 'scope'].includes(failure) ? { principalResolver: { async resolve() {
        if (failure === 'authentication') throw new ObservationPrincipalError('unauthenticated', 'Missing credential.');
        return TOKEN_PRINCIPALS['token-no-scope'];
      } } } : {}),
    });
    const agent = new Agent({ keepAlive: true });
    let request: ClientRequest | undefined;
    let closed: Promise<void> | undefined;
    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        request = httpRequest(started.url, {
          method: 'POST', agent, headers: { 'Content-Type': 'application/json' },
          ...(failure === 'route' ? { path: '/missing' } : {}),
        }, resolve);
        request.once('error', reject);
        closed = new Promise<void>((resolveClose, rejectClose) => {
          request!.once('close', resolveClose);
          request!.once('error', rejectClose);
        });
        // Attach a handler immediately, including when an earlier assertion fails.
        void closed.catch(() => undefined);
        request.setTimeout(1000, () => request?.destroy(new Error('Server did not close the incomplete request')));
        request.write('{');
      });
      response.resume();
      assert.equal(response.statusCode, status);
      assert.equal(response.headers.connection, 'close');
      await closed;
    } finally {
      request?.destroy(); agent.destroy(); await started.close();
    }
  });

  it('releases rejected chunked bodies and still admits the next SDK request', async () => {
    let writes = 0;
    const started = await startObservationMcpHttpServer({
      captureStore: { async create() { writes += 1; throw new Error('must not write'); } },
      requestBodyLimitBytes: 256,
      maxConcurrentRequests: 1,
    });
    const client = createClient(started.url, 'token-a');
    try {
      assert.equal(await postRaw(started.url, { chunks: ['{'] }), 400);
      // Character count fits, UTF-8 byte count does not; no Content-Length shortcut.
      assert.equal(await postRaw(started.url, { chunks: ['{"text":"', '中'.repeat(100), '"}'] }), 413);
      await client.connect();
      assert.ok((await client.client.listTools()).tools.length > 0);
      assert.equal(writes, 0);
    } finally { await client.client.close(); await started.close(); }
  });

  it('releases the reader and request slot when a client disconnects mid-body', async () => {
    let received!: () => void;
    let serverClosed!: () => void;
    const reading = new Promise<void>(resolve => { received = resolve; });
    const disconnected = new Promise<void>(resolve => { serverClosed = resolve; });
    let observing = false;
    const started = await startObservationMcpHttpServer({
      captureStore: { async create() { throw new Error('must not write'); } },
      maxConcurrentRequests: 1,
      principalResolver: { async resolve(request) {
        if (!observing) {
          observing = true;
          // Let the handler attach its reader without consuming or changing the stream mode.
          setImmediate(received);
          request.once('close', serverClosed);
        }
        return TOKEN_PRINCIPALS['token-a'];
      } },
    });
    const request = httpRequest(started.url, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    request.on('error', () => undefined);
    const client = createClient(started.url, 'token-a');
    try {
      request.write('{');
      await reading;
      request.destroy();
      await disconnected;
      await client.connect();
      assert.ok((await client.client.listTools()).tools.length > 0);
    } finally { request.destroy(); await client.client.close(); await started.close(); }
  });
  it('uses one tool contract and isolates idempotency by server-resolved principal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-http-mcp-'));
    const started = await startObservationMcpHttpServer({
      captureStore: new FileObservationFeedbackStore({ observationsDir: dir }),
      principalResolver: resolver,
    });
    const clientA = createClient(started.url, 'token-a');
    const clientB = createClient(started.url, 'token-b');
    try {
      await Promise.all([clientA.connect(), clientB.connect()]);
      const tools = await clientA.client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name), [
        'save_observation',
        'get_observation',
        'record_observation_review',
        'draft_sample_from_observation',
        'review_observation',
      ]);

      const first = await clientA.client.callTool(captureRequest());
      const duplicate = await clientA.client.callTool(captureRequest());
      const otherPrincipal = await clientB.client.callTool(captureRequest());
      assert.equal((first.structuredContent as { created?: boolean }).created, true);
      assert.equal((duplicate.structuredContent as { created?: boolean }).created, false);
      assert.equal((otherPrincipal.structuredContent as { created?: boolean }).created, true);
      assert.equal(captureFileCount(dir), 2);
    } finally {
      await Promise.allSettled([clientA.client.close(), clientB.client.close()]);
      await started.close();
    }
  });

  it('fails closed for unauthenticated, missing-scope, and wrong-tenant requests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-http-mcp-auth-'));
    const started = await startObservationMcpHttpServer({
      captureStore: new FileObservationCaptureStore({ observationsDir: dir }),
      principalResolver: resolver,
    });
    try {
      const attempts = [undefined, 'token-no-scope', 'wrong-tenant'];
      const statuses = await Promise.all(attempts.map(async (token) => {
        const response = await fetch(started.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'save_observation', arguments: captureRequest().arguments },
          }),
        });
        return response.status;
      }));
      assert.deepEqual(statuses, [401, 403, 403]);
      assert.equal(captureFileCount(dir), 0);
    } finally {
      await started.close();
    }
  });

  it('rejects anonymous non-loopback binding and oversized request bodies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omk-http-mcp-limits-'));
    await assert.rejects(
      () => startObservationMcpHttpServer({
        host: '0.0.0.0',
        captureStore: new FileObservationCaptureStore({ observationsDir: dir }),
      }),
      /principalResolver/,
    );
    const started = await startObservationMcpHttpServer({
      captureStore: new FileObservationCaptureStore({ observationsDir: dir }),
      requestBodyLimitBytes: 64,
    });
    try {
      const crossOrigin = await fetch(started.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Origin: 'https://untrusted.example',
        },
        body: '{}',
      });
      assert.equal(crossOrigin.status, 403);
      assert.equal(await postRaw(started.url, { host: 'untrusted.example' }), 403);

      const response = await fetch(started.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 'x'.repeat(100) }),
      });
      assert.equal(response.status, 413);
      assert.equal(captureFileCount(dir), 0);
    } finally {
      await started.close();
    }
  });
});

function postRaw(url: URL, options: { host?: string; target?: string; chunks?: string[] } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      path: options.target ?? url.pathname,
      headers: {
        'Content-Type': 'application/json',
        Host: options.host ?? url.host,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.setTimeout(1000, () => request.destroy(new Error('Request target escaped the HTTP error boundary')));
    if (options.chunks) {
      for (const chunk of options.chunks) request.write(chunk);
      request.end();
    } else request.end('{}');
  });
}

function createClient(url: URL, token: string): {
  client: Client;
  connect(): Promise<void>;
} {
  const client = new Client({ name: `omk-http-test-${token}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return {
    client,
    connect: () => client.connect(transport),
  };
}

function captureRequest() {
  return {
    name: 'save_observation',
    arguments: {
      skillName: 'demo-skill',
      userFeedback: '需要补充远程集成边界。',
      captureId: 'same-http-capture-id',
      confirmedByUser: true,
    },
  };
}

function captureFileCount(dir: string): number {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.capture.json'))
    .length;
}
