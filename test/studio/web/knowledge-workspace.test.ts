import { afterEach, expect, it, vi } from 'vitest';
import { resolveKnowledgeDirectory, resolveKnowledgeWorkspace } from '../../../src/studio/web/components/knowledge/workspace.js';
import { KnowledgeRequestError, requestKnowledge } from '../../../src/studio/web/components/knowledge/request.js';
afterEach(() => vi.unstubAllGlobals());
it('uses explicit overrides then Node settings, without browser-owned persistence', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ effective: { workspace: '/configured', executor: 'codex', model: 'test-model' } }) })));
  expect(await resolveKnowledgeWorkspace()).toEqual({ workspace: '/configured', defaultWorkspace: '/configured', executor: 'codex', model: 'test-model' });
  expect((await resolveKnowledgeWorkspace('/explicit')).workspace).toBe('/explicit');
});
it('does not invent a path when server configuration is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  await expect(resolveKnowledgeWorkspace()).rejects.toThrow('settings unavailable');
});
it('reads explicit directories without model settings and still requires settings for the default directory', async () => {
  const fetch = vi.fn(async () => new Response('{}', { status: 503 })); vi.stubGlobal('fetch', fetch);
  expect(await resolveKnowledgeDirectory('/selected')).toBe('/selected'); expect(fetch).not.toHaveBeenCalled();
  await expect(resolveKnowledgeDirectory()).rejects.toThrow('settings unavailable');
});
it('distinguishes rejected writes from unknown outcomes without exposing raw server failures', async () => {
  for (const [status, code, rejected] of [[409, 'knowledge_workspace_busy', true], [400, 'knowledge_capacity_exceeded', true],
    [400, 'knowledge_request_failed', false], [400, 'carrier_invalid_metadata', false], [500, 'knowledge_workspace_busy', false], [500, '/private/secret', false]] as const) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: code }), { status })));
    await expect(requestKnowledge('library', { operation: 'save' })).rejects.toMatchObject({
      message: code === '/private/secret' ? 'knowledge_request_failed' : code, status, definiteRejection: rejected,
    });
  }
});
it('keeps unreadable acknowledgements unknown and rejects late responses after cancellation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unreadable', { status: 200 })));
  await expect(requestKnowledge('artifacts', { operation: 'save' })).rejects.toMatchObject({ definiteRejection: false, message: 'knowledge_response_unreadable' });
  const controller = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); return new Response('{}'); }));
  await expect(requestKnowledge('candidates', { operation: 'show' }, controller.signal)).rejects.not.toBeInstanceOf(KnowledgeRequestError);
});
