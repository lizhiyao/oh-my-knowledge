import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { openAiApiExecutor } from '../../src/executors/openai-api.js';

describe('openAiApiExecutor usage', () => {
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
  });

  it('keeps uncached input and cache-read buckets mutually exclusive', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: { content: 'done' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
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

  it('keeps HTTP status and body when an upstream proxy returns non-JSON', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream unavailable', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    })));

    const result = await openAiApiExecutor({
      model: 'gpt-test',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /503/);
    assert.match(result.error ?? '', /upstream unavailable/);
  });
});
