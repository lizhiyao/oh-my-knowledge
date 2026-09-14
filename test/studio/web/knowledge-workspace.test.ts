import { afterEach, expect, it, vi } from 'vitest';
import { resolveKnowledgeWorkspace } from '../../../src/studio/web/components/knowledge/workspace.js';
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
