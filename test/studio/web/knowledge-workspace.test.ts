import { afterEach, expect, it, vi } from 'vitest';
import { resolveKnowledgeWorkspace } from '../../../src/studio/web/components/knowledge/workspace.js';
afterEach(() => vi.unstubAllGlobals());
it('uses explicit, remembered, then server-provided directories without writing browser state', async () => {
  let remembered: string | null = null;
  const setItem = vi.fn();
  vi.stubGlobal('window', { localStorage: { getItem: () => remembered, setItem } });
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ workspace: '/isolated/omk/knowledge' }) }));
  vi.stubGlobal('fetch', fetch);
  expect(await resolveKnowledgeWorkspace()).toEqual({ workspace: '/isolated/omk/knowledge', defaultWorkspace: '/isolated/omk/knowledge' });
  remembered = '/chosen';
  expect((await resolveKnowledgeWorkspace()).workspace).toBe('/chosen');
  expect((await resolveKnowledgeWorkspace('/explicit')).workspace).toBe('/explicit');
  expect(setItem).not.toHaveBeenCalled();
  expect(fetch.mock.calls).toHaveLength(3);
});
it('does not invent a path when server configuration is unavailable', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  await expect(resolveKnowledgeWorkspace()).rejects.toThrow('defaults unavailable');
});
