import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
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
        'capture_observation',
        'get_observation',
        'record_observation_review',
        'draft_sample_from_observation',
        'render_observation_review',
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
            params: { name: 'capture_observation', arguments: captureRequest().arguments },
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
      assert.equal(await postWithHost(started.url, 'untrusted.example'), 403);

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

function postWithHost(url: URL, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: host,
      },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end('{}');
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
    name: 'capture_observation',
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
