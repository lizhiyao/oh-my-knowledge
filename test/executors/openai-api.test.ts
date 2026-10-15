import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { openAiApiExecutor } from '../../src/executors/openai/api.js';
import { MAX_API_RESPONSE_BYTES } from '../../src/executors/core/http.js';
import { createExecutor } from '../../src/executors/index.js';

describe('openAiApiExecutor usage', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  beforeEach(() => vi.stubEnv('OPENAI_BASE_URL', 'https://api-fixture.example/v1/'));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
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
  });

  it('treats a successful HTTP response without assistant text as protocol failure', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: null, refusal: 'request refused' },
        finish_reason: 'stop',
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
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /refused/);
    assert.equal(result.inputTokens, 10);
    assert.equal(result.cacheReadTokens, 2);
    assert.equal(result.outputTokens, 3);
    assert.equal(result.output, null);
    assert.equal(result.costReportedByExecutor, false);
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
