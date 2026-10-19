import { afterEach, expect, it, vi } from 'vitest';
import { resolveKnowledgeDirectory, resolveKnowledgeWorkspace } from '../../../src/studio/web/components/knowledge/workspace.js';
import { KnowledgeSaveSession } from '../../../src/studio/web/components/knowledge/save-session.js';
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
  for (const [status, code, rejected] of [[409, 'knowledge_workspace_busy', true], [400, 'knowledge_capacity_exceeded', true], [400, 'knowledge_citations_invalid', true],
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
it('keeps an unknown write frozen until its original receipt is confirmed, without submitting again', async () => {
  const session = new KnowledgeSaveSession<{ requestId: string; generation: number }>();
  const command = { requestId: 'original', generation: 3 };
  const write = vi.fn(async () => { throw new Error('acknowledgement lost'); });
  await session.save(command, write, () => undefined, 'unknown');
  expect(session.getSnapshot()).toEqual({ phase: 'unknown', command, error: 'unknown' });
  await session.save({ requestId: 'duplicate', generation: 4 }, write, () => undefined, 'unknown');
  expect(write).toHaveBeenCalledTimes(1);
  const match = (receipt: string, submitted: typeof command) => receipt === submitted.requestId;
  expect(await session.inspect(async () => 'other', match, 'missing', 'unreadable')).toBeUndefined();
  expect(session.getSnapshot()).toMatchObject({ phase: 'unknown', command, error: 'missing' });
  await session.inspect(async () => { throw new Error('offline'); }, match, 'missing', 'unreadable');
  expect(session.getSnapshot()).toMatchObject({ phase: 'unknown', error: 'unreadable' });
  expect(await session.inspect(async submitted => { expect(submitted.generation).toBe(3); return 'original'; }, match, 'missing', 'unreadable')).toMatchObject({ value: 'original' });
  expect(session.getSnapshot().phase).toBe('saved');
  await session.save(command, write, () => undefined, 'unknown');
  expect(write).toHaveBeenCalledTimes(1);
});
it('permits an explicit retry only after a known rejection and publishes observable state changes', async () => {
  const session = new KnowledgeSaveSession<string>(); const states: string[] = [];
  const unsubscribe = session.subscribe(() => states.push(session.getSnapshot().phase));
  await session.save('draft', async () => { throw new Error('conflict'); }, () => 'reload', 'unknown');
  expect(session.getSnapshot()).toEqual({ phase: 'editing', error: 'reload' });
  session.clearError();
  expect(await session.save('reviewed draft', async command => command, () => undefined, 'unknown')).toMatchObject({ value: 'reviewed draft' });
  expect(states).toEqual(['saving', 'editing', 'editing', 'saving', 'saved']);
  unsubscribe(); session.cancel(); expect(states).toHaveLength(5);
});
it('blocks simultaneous writes and ignores an aborted response after a new context starts', async () => {
  const session = new KnowledgeSaveSession<string>(); const old = deferred<string>(); let signal!: AbortSignal;
  const write = vi.fn(async (_command: string, active: AbortSignal) => { signal = active; return old.promise; });
  const pending = session.save('old', write, () => undefined, 'unknown');
  await session.save('duplicate', write, () => undefined, 'unknown'); expect(write).toHaveBeenCalledTimes(1);
  session.cancel(); expect(signal.aborted).toBe(true);
  const current = session.save('new', async () => 'new result', () => undefined, 'unknown');
  const accepted = await current; expect(accepted).toMatchObject({ value: 'new result' }); expect(accepted?.current()).toBe(true); session.cancel(); expect(accepted?.current()).toBe(false);
  await session.save('new', async () => 'current result', () => undefined, 'unknown'); old.resolve('stale result');
  expect(await pending).toBeUndefined(); expect(session.getSnapshot()).toMatchObject({ phase: 'saved', command: 'new' });
});
it('serializes receipt checks and never accepts a late check after cancellation', async () => {
  const session = new KnowledgeSaveSession<string>();
  await session.save('draft', async () => { throw new Error(); }, () => undefined, 'unknown');
  const receipt = deferred<string>(); const check = vi.fn(async () => receipt.promise);
  const pending = session.inspect(check, () => true, 'missing', 'unreadable');
  await session.inspect(check, () => true, 'missing', 'unreadable'); expect(check).toHaveBeenCalledTimes(1);
  session.cancel(); receipt.resolve('saved'); expect(await pending).toBeUndefined();
  expect(session.getSnapshot()).toEqual({ phase: 'editing', error: '' });
});
