import { existsSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredExtractionModel } from '../../src/observability/knowledge-extraction/adapters/executor.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('knowledge generation executor boundary', () => {
  it.each(['success', 'failure', 'tool', 'cancel'] as const)('cleans Codex text execution after %s', async (outcome) => {
    let directory = '';
    const controller = new AbortController();
    const model = configuredExtractionModel('codex', 'test', async (input) => {
      directory = input.cwd!;
      expect(readdirSync(directory)).toEqual([]);
      expect(input.allowedSkills).toEqual([]);
      expect(input.prompt).toBe('selected text');
      if (outcome === 'failure') throw new Error('fixture failure');
      if (outcome === 'cancel') controller.abort();
      return { ok: true, output: '{"proposals":[]}', durationMs: 1, durationApiMs: 1,
        inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
        costUSD: 0, stopReason: 'end_turn', numTurns: 1,
        ...(outcome === 'tool' ? { toolCalls: [{ tool: 'read_file', input: {}, output: '', success: true }] } : {}) };
    });
    const promise = model.generate('system', 'selected text', controller.signal);
    if (outcome === 'success') expect(await promise).toMatchObject({ output: '{"proposals":[]}' });
    else await expect(promise).rejects.toThrow();
    expect(directory).not.toBe('');
    expect(existsSync(directory)).toBe(false);
  });
  it.each(['openai-api', 'anthropic-api'])('sends text without tools through %s', async (executor) => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture');
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body));
      expect(body).not.toHaveProperty('tools');
      expect(body).not.toHaveProperty('cwd');
      expect(body.messages.at(-1).content).toBe('selected evidence');
      return new Response(JSON.stringify(executor === 'openai-api'
        ? { choices: [{ message: { content: '{"proposals":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } }
        : { content: [{ type: 'text', text: '{"proposals":[]}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }));
    });
    vi.stubGlobal('fetch', fetch);
    const model = configuredExtractionModel(executor, 'fixture-model');
    expect(await model.generate('system', 'selected evidence')).toMatchObject({ output: '{"proposals":[]}' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const controller = new AbortController(); controller.abort();
    await expect(model.generate('system', 'selected evidence', controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['codex-sdk', 'claude', 'claude-sdk'])('rejects agent executor %s before invoking a runtime', (executor) => {
    expect(() => configuredExtractionModel(executor, 'test')).toThrow('adapter');
  });
});
