import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { openAiApiExecutor } from '../../src/executors/openai/api.js';
import { MAX_API_RESPONSE_BYTES } from '../../src/executors/core/http.js';
import { createExecutor } from '../../src/executors/index.js';
import { buildOpenAiChatRequest } from '../../src/executors/openai/request.js';

describe('openAiApiExecutor usage', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  beforeEach(() => vi.stubEnv('OPENAI_BASE_URL', 'https://api-fixture.example/v1/'));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it('sends only the selected structured-output protocol and provider output ceiling without mutating the schema', async () => {
    process.env.OPENAI_API_KEY = 'fixture-key';
    const schema = { type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'], additionalProperties: false };
    const originalSchema = JSON.stringify(schema);
    for (const outputFormat of [
      { mode: 'json-schema', name: 'knowledge_window', schema },
      { mode: 'json-object' }, { mode: 'prompt-json' }, undefined,
    ] as const) {
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.max_completion_tokens, 321);
        assert.equal(Object.hasOwn(body, 'n'), false);
        assert.equal(Object.hasOwn(body, 'stream'), false);
        assert.equal(init?.redirect, undefined);
        assert.deepEqual(body.messages, [{ role: 'system', content: 'stable system' }, { role: 'user', content: 'JSON input' }]);
        if (outputFormat?.mode === 'json-schema') {
          assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'knowledge_window', schema, strict: true } });
        } else if (outputFormat?.mode === 'json-object') assert.deepEqual(body.response_format, { type: 'json_object' });
        else assert.equal(Object.hasOwn(body, 'response_format'), false);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"value":null}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 } }));
      });
      vi.stubGlobal('fetch', fetch);
      const result = await openAiApiExecutor({ model: 'fixture', system: 'stable system', prompt: 'JSON input', outputFormat, maxOutputTokens: 321 });
      assert.equal(result.ok, true);
      assert.equal(fetch.mock.calls.length, 1);
    }
    assert.equal(JSON.stringify(schema), originalSchema);
  });

  it('binds the actual shared request before one opt-in bounded dispatch and rejects drift without fetch', async () => {
    const environment = { OPENAI_API_KEY: 'fixture-key', OPENAI_BASE_URL: 'http://127.0.0.1:9321' };
    const input = { model: 'fixture-model', system: 'system bytes', prompt: 'input bytes', maxOutputTokens: 12 };
    const events: string[] = [];
    const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      events.push('fetch'); assert.equal(url, 'http://127.0.0.1:9321/v1/chat/completions');
      assert.equal(init?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(init?.body)), { model: 'fixture-model', messages: [{ role: 'system', content: 'system bytes' },
        { role: 'user', content: 'input bytes' }], max_completion_tokens: 12, n: 1, stream: false });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }));
    });
    vi.stubGlobal('fetch', fetch);
    const policy = { requestConstraints: 'single-completion/v1' as const, redirect: 'error' as const,
      beforeDispatch(request: Readonly<{ endpoint: string; body: string }>) {
        events.push('gate'); assert.equal(Object.isFrozen(request), true);
        assert.deepEqual(request, buildOpenAiChatRequest(input, environment, 'single-completion/v1'));
      } };
    const execute = createExecutor('openai-api', { env: environment, apiDispatchPolicy: policy });
    assert.equal((await execute(input)).ok, true); assert.deepEqual(events, ['gate', 'fetch']);
    const blocked = createExecutor('openai-api', { env: environment, apiDispatchPolicy: { ...policy, beforeDispatch() { throw new Error('plan drift'); } } });
    assert.equal((await blocked(input)).failure?.failureKind, 'invalid_request');
    assert.equal(fetch.mock.calls.length, 1);
    assert.throws(() => createExecutor('codex', { env: environment, apiDispatchPolicy: policy }), /openai-api/);
  });

  it('classifies HTTP failures and bounded Retry-After without retrying or losing reported evidence', async () => {
    process.env.OPENAI_API_KEY = 'fixture-key';
    const cases = [
      { status: 400, error: { code: 'invalid_json_schema', param: 'response_format' }, failureKind: 'invalid_request' },
      { status: 400, error: { code: 'unsupported_value', param: 'response_format' }, failureKind: 'unsupported_output' },
      { status: 401, failureKind: 'authentication' }, { status: 403, failureKind: 'permission' },
      { status: 408, failureKind: 'timeout' }, { status: 429, failureKind: 'rate_limit' }, { status: 503, failureKind: 'server_error' },
    ];
    for (const fixture of cases) {
      const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'fixture-key unavailable', ...fixture.error },
        choices: [{ message: { content: 'original partial output' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }),
      { status: fixture.status, headers: { 'retry-after': fixture.status === 429 ? '1.25' : '99999999999' } }));
      vi.stubGlobal('fetch', fetch);
      const result = await openAiApiExecutor({ model: 'fixture', prompt: 'JSON input' });
      assert.equal(result.ok, false);
      assert.deepEqual(result.failure, { failureKind: fixture.failureKind, httpStatus: fixture.status,
        ...(fixture.status === 429 ? { retryAfterMs: 1250 } : {}) });
      assert.equal(result.output, 'original partial output');
      assert.equal(result.inputTokens, 10);
      assert.equal(result.cacheReadTokens, 2);
      assert.equal(result.outputTokens, 3);
      assert.doesNotMatch(result.error ?? '', /fixture-key/);
      assert.equal(fetch.mock.calls.length, 1);
    }
  });

  it('distinguishes transport errors, timeouts, cancellation and missing credentials without synthetic usage', async () => {
    process.env.OPENAI_API_KEY = 'fixture-key';
    for (const [name, failureKind] of [['TypeError', 'network_error'], ['TimeoutError', 'timeout']] as const) {
      const fetch = vi.fn(async () => { const error = new Error('fixture transport'); error.name = name; throw error; });
      vi.stubGlobal('fetch', fetch);
      const result = await openAiApiExecutor({ model: 'fixture', prompt: '' });
      assert.equal(result.failure?.failureKind, failureKind);
      assert.equal(result.tokenUsageReportedByExecutor, false);
      assert.equal(fetch.mock.calls.length, 1);
    }
    for (const failureKind of ['network_error', 'timeout', 'authentication'] as const) {
      vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({
        start(controller) {
          if (failureKind !== 'timeout') controller.error(new TypeError('body connection terminated'));
          else init?.signal?.addEventListener('abort', () => controller.error(new DOMException('body aborted', 'AbortError')), { once: true });
        },
      }), { status: failureKind === 'authentication' ? 401 : 200 })));
      const result = await openAiApiExecutor({ model: 'fixture', prompt: '', timeoutMs: 10 });
      assert.equal(result.failure?.failureKind, failureKind);
      assert.equal(result.tokenUsageReportedByExecutor, false);
    }
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const controller = new AbortController(); controller.abort();
    const cancelled = await openAiApiExecutor({ model: 'fixture', prompt: '', abortSignal: controller.signal });
    assert.equal(cancelled.failure?.failureKind, 'cancelled');
    delete process.env.OPENAI_API_KEY;
    const missing = await openAiApiExecutor({ model: 'fixture', prompt: '' });
    assert.equal(missing.failure?.failureKind, 'authentication');
    assert.equal(fetch.mock.calls.length, 0);
  });

  it('captures provider selection and credentials at factory creation without changing successful output', async () => {
    const environment = { OPENAI_BASE_URL: 'https://selected.example/', OPENAI_API_KEY: 'selected-credential' };
    const executor = createExecutor('openai-api', { env: environment });
    environment.OPENAI_BASE_URL = 'https://changed.example';
    environment.OPENAI_API_KEY = 'changed-credential';
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(url), 'https://selected.example/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer selected-credential');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'selected-credential' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    }));
    const result = await executor({ model: 'fixture', prompt: 'fixture' });
    assert.equal(result.ok, true);
    assert.equal(result.output, 'selected-credential');
  });

  it('rejects invalid or credential-bearing base URLs before transport without echoing them', async () => {
    process.env.OPENAI_API_KEY = 'fixture-key';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const base of ['ftp://fixture.example', 'https://private-user:private-pass@fixture.example', 'https://fixture.example?api_key=private-query', 'invalid-base']) {
      vi.stubEnv('OPENAI_BASE_URL', base);
      const result = await openAiApiExecutor({ model: 'fixture', prompt: 'fixture' });
      assert.equal(result.ok, false);
      assert.equal(result.failure?.failureKind, 'invalid_request');
      assert.match(result.error ?? '', /OPENAI_BASE_URL/);
      assert.doesNotMatch(result.error ?? '', /private-user|private-pass|private-query/);
    }
    assert.equal(fetch.mock.calls.length, 0);
  });

  it('rejects oversized declared and streamed responses before reading to EOF', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    for (const declared of [true, false]) {
      let produced = 0;
      let ended = false;
      let cancelled = false;
      const chunk = new Uint8Array(1024 * 1024);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
        pull(controller) {
          produced += 1;
          if (produced <= 8) controller.enqueue(chunk);
          else { ended = true; controller.close(); }
        },
        cancel() { cancelled = true; },
      }), { headers: declared ? { 'content-length': String(MAX_API_RESPONSE_BYTES + 1) } : {} })));
      const result = await openAiApiExecutor({ model: 'fixture', prompt: 'fixture' });
      assert.equal(result.ok, false);
      assert.equal(result.failure?.failureKind, 'capacity');
      assert.match(result.error ?? '', /API response exceeded/);
      assert.equal(result.output, null);
      assert.equal(cancelled, true);
      assert.equal(ended, false);
      assert.ok(produced <= (declared ? 1 : 6));
    }
  });

  it('keeps uncached input and cache-read buckets mutually exclusive', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      assert.equal(String(url), 'https://api-fixture.example/v1/chat/completions');
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await openAiApiExecutor({
      model: 'gpt-test',
      system: 'system',
      prompt: 'prompt',
    });

    assert.equal(result.inputTokens, 60);
    assert.equal(result.cacheReadTokens, 40);
    assert.equal(result.outputTokens, 20);
    assert.equal(result.costReportedByExecutor, false);
  });

  it('fails closed on contradictory or malformed provider counters', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: 'done' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: -20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await openAiApiExecutor({
      model: 'gpt-test',
      system: 'system',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /invalid token usage/);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.cacheReadTokens, 0);
    assert.equal(result.outputTokens, 0);
    assert.equal(result.output, 'done');
    assert.equal(result.failure?.failureKind, 'invalid_response');
    assert.equal(result.tokenUsageReportedByExecutor, false);
  });

  it('preserves refusal, filtered and truncated text and usage as failures even if the text parses as valid JSON', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const refusal = `request refused test-key ${'原文'.repeat(1000)}`;
    for (const fixture of [
      { content: null, refusal, finish_reason: 'stop', failureKind: 'refusal' },
      { content: '{}', refusal, finish_reason: 'stop', failureKind: 'refusal' },
      { content: '{}', finish_reason: 'content_filter', failureKind: 'content_filter' },
      { content: '{}', finish_reason: 'length', failureKind: 'truncation' },
      { content: '{}', finish_reason: 'tool_calls', failureKind: 'invalid_response' },
      { content: '{}', finish_reason: 'stop', tool_calls: [{ id: 'unexpected', type: 'function' }], failureKind: 'invalid_response' },
      { content: '{}', finish_reason: undefined, outputFormat: { mode: 'json-object' as const }, failureKind: 'invalid_response' },
    ]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: fixture.content, refusal: fixture.refusal, tool_calls: fixture.tool_calls },
        finish_reason: fixture.finish_reason,
      }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 2 },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await openAiApiExecutor({
      model: 'gpt-test',
      prompt: 'prompt',
      outputFormat: fixture.outputFormat,
    });

    assert.equal(result.ok, false);
    assert.equal(result.failure?.failureKind, fixture.failureKind);
    assert.equal(result.inputTokens, 10);
    assert.equal(result.cacheReadTokens, 2);
    assert.equal(result.outputTokens, 3);
    assert.equal(result.output, fixture.content ?? fixture.refusal);
    assert.equal(result.refusal, fixture.refusal);
    if (fixture.refusal) {
      assert.doesNotMatch(result.error ?? '', /test-key/);
      assert.ok((result.error?.length ?? 0) <= 1027);
    }
    assert.equal(result.costReportedByExecutor, false);
    }
  });

  it('keeps status and safe diagnostics for non-JSON proxies and malformed error messages, redacting before preview truncation', async () => {
    const credential = 'SENSITIVE_CREDENTIAL_SUFFIX_12345';
    process.env.OPENAI_API_KEY = credential;
    for (const body of [
      `upstream unavailable ${'x'.repeat(464)}${credential}`,
      JSON.stringify({ error: { message: { detail: `upstream unavailable ${credential}` } } }),
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })));
      const result = await openAiApiExecutor({ model: 'gpt-test', prompt: 'prompt' });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /503/);
      assert.match(result.error ?? '', /upstream unavailable/);
      assert.match(result.error ?? '', /\[REDACTED\]/);
      assert.doesNotMatch(result.error ?? '', /SENSITIVE_/);
    }
  });
});
