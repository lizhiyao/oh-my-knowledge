import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'vitest';
import { RequestBodyError } from '../../../src/studio/http/request-errors.js';
import { createStudioRouter, type StudioRouteDefinition } from '../../../src/studio/http/routes/router.js';
import type { StudioRouteContext } from '../../../src/studio/http/routes/contracts.js';

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function fakeContext(path: string, method = 'GET', headers: Record<string, string | string[]> = {}) {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const request = { method, headers } as unknown as IncomingMessage;
  const response = {
    writeHead(status: number, responseHeaders: Record<string, string>) {
      captured.status = status;
      captured.headers = responseHeaders;
      return this;
    },
    end(body = '') {
      captured.body = body;
    },
  } as unknown as ServerResponse;
  const context: StudioRouteContext = {
    request,
    response,
    url: new URL(path, 'http://127.0.0.1'),
    path,
    lang: 'zh',
  };
  return { context, captured };
}

function recording(calls: string[], tag: string): StudioRouteDefinition<StudioRouteContext>['handler'] {
  return () => { calls.push(tag); };
}

describe('Studio declarative router', () => {
  it('prefers literal segments over params and params over wildcards', async () => {
    const calls: string[] = [];
    const router = createStudioRouter([
      { pattern: '/a/*rest', handler: recording(calls, 'wild') },
      { pattern: '/a/:id', handler: recording(calls, 'param') },
      { pattern: '/a/exact', handler: recording(calls, 'literal') },
    ]);
    assert.equal(await router(fakeContext('/a/exact').context), true);
    assert.equal(await router(fakeContext('/a/other').context), true);
    assert.equal(await router(fakeContext('/a/other/deeper').context), true);
    assert.deepEqual(calls, ['literal', 'param', 'wild']);
  });

  it('returns false when no pattern matches', async () => {
    const router = createStudioRouter([{ pattern: '/a', handler: () => undefined }]);
    assert.equal(await router(fakeContext('/nope').context), false);
  });

  it('aggregates 405 with Allow for path-matched method mismatches', async () => {
    const router = createStudioRouter([
      { pattern: '/api/thing', handler: () => undefined },
      { pattern: '/api/thing', method: ['POST', 'DELETE'], handler: () => undefined },
    ]);
    const { context, captured } = fakeContext('/api/thing', 'PUT');
    assert.equal(await router(context), true);
    assert.equal(captured.status, 405);
    assert.equal(captured.headers.Allow, 'DELETE, GET, POST');
    assert.deepEqual(JSON.parse(captured.body), { error: 'method_not_allowed' });
  });

  it('answers non-API 405 as text', async () => {
    const router = createStudioRouter([{ pattern: '/page', handler: () => undefined }]);
    const { context, captured } = fakeContext('/page', 'POST');
    assert.equal(await router(context), true);
    assert.equal(captured.status, 405);
    assert.equal(captured.headers.Allow, 'GET');
    assert.equal(captured.body, 'method_not_allowed');
  });

  it('matches ANY method for redirect-style routes', async () => {
    const calls: string[] = [];
    const router = createStudioRouter([
      { pattern: '/old', method: 'ANY', handler: recording(calls, 'hit') },
    ]);
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal(await router(fakeContext('/old', method).context), true);
    }
    assert.deepEqual(calls, ['hit', 'hit', 'hit']);
  });

  it('decodes params and degrades malformed encoding to an empty string', async () => {
    const seen: (string | undefined)[] = [];
    const router = createStudioRouter([
      { pattern: '/a/:id', handler: ({ params }) => { seen.push(params.id); } },
    ]);
    await router(fakeContext('/a/hello%20world').context);
    await router(fakeContext('/a/%ZZ').context);
    assert.deepEqual(seen, ['hello world', '']);
  });

  it('rejects untrusted mutations before invoking the handler', async () => {
    const calls: string[] = [];
    const router = createStudioRouter([
      { pattern: '/api/thing', method: 'POST', mutation: true, handler: recording(calls, 'hit') },
    ]);
    await assert.rejects(
      router(fakeContext('/api/thing', 'POST', { 'sec-fetch-site': 'cross-site' }).context),
      (error: unknown) => error instanceof RequestBodyError && error.statusCode === 403,
    );
    assert.deepEqual(calls, []);
    assert.equal(await router(fakeContext('/api/thing', 'POST').context), true);
    assert.deepEqual(calls, ['hit']);
  });

  it('rejects mutations with ambiguous or malformed origins', async () => {
    const calls: string[] = [];
    const router = createStudioRouter([
      { pattern: '/api/thing', method: 'POST', mutation: true, handler: recording(calls, 'hit') },
    ]);

    const rejected: Record<string, string | string[]>[] = [
      { origin: ['https://a.example', 'https://b.example'], host: 'a.example' },
      { origin: 'https://a.example' },
      { origin: 'not a url', host: 'a.example' },
      { origin: 'https://evil.example', host: 'a.example' },
    ];
    for (const headers of rejected) {
      await assert.rejects(
        router(fakeContext('/api/thing', 'POST', headers).context),
        (error: unknown) => error instanceof RequestBodyError
          && error.statusCode === 403
          && error.code === 'mutation_not_trusted',
      );
    }
    assert.deepEqual(calls, []);

    assert.equal(await router(fakeContext('/api/thing', 'POST', {
      origin: 'https://a.example',
      host: 'a.example',
    }).context), true);
    assert.deepEqual(calls, ['hit']);
  });
});
