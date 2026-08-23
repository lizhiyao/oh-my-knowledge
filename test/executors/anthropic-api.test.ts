import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { anthropicApiExecutor } from '../../src/executors/anthropic/api.js';

describe('anthropicApiExecutor protocol boundary', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('treats a successful HTTP response without text as protocol failure and keeps usage', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'thinking' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 12,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const result = await anthropicApiExecutor({
      model: 'claude-test',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /did not contain assistant text/);
    assert.equal(result.inputTokens, 12);
    assert.equal(result.outputTokens, 3);
    assert.equal(result.cacheReadTokens, 2);
    assert.equal(result.cacheCreationTokens, 1);
    assert.equal(result.output, null);
    assert.equal(result.costReportedByExecutor, false);
  });

  it('fails closed when a successful response has malformed usage', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: -1 },
    }), { status: 200 })));

    const result = await anthropicApiExecutor({
      model: 'claude-test',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /invalid token usage/);
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
  });

  it('rejects a non-JSON success response as a protocol failure', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not an API response</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })));

    const result = await anthropicApiExecutor({
      model: 'claude-test',
      prompt: 'prompt',
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /non-JSON response/);
  });
});
