import { afterEach, describe, expect, it, vi } from 'vitest';
import { configuredExtractionModel } from '../../src/observability/knowledge-extraction/adapters/executor.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('knowledge generation executor boundary', () => {
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
  it.each(['codex', 'codex-sdk', 'claude', 'claude-sdk'])('rejects agent executor %s before invoking a runtime', (executor) => {
    expect(() => configuredExtractionModel(executor, 'test')).toThrow('restricted');
  });
});
