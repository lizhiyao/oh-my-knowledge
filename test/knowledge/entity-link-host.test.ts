import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpenAiArchiveProducer, openAiArchiveDiagnosticGrowth } from '../../src/executors/openai/archive.js';
import { createExecutor } from '../../src/executors/index.js';
import { createLocalKnowledgeApplication, createLocalEntityLinks, createLocalKnowledgeLibrary, parseEntityLinkPreview } from '../../src/observability/knowledge-extraction/local.js';
import { FileEntityLinkStore, entityLinkAllocation, ENTITY_LINK_NAMESPACE_BYTES } from '../../src/observability/knowledge-extraction/adapters/entity-link-store.js';
import { FileEntityAnalysisStore } from '../../src/observability/knowledge-extraction/adapters/entity-store.js';
import { FileLibraryStore } from '../../src/observability/knowledge-extraction/adapters/library-store.js';
import { EntityLinkApplication, EntityLinkArchiveError } from '../../src/observability/knowledge-extraction/linking/entity-links.js';
import { configureEntityLinkApiProducer, entityLinkTextHash } from '../../src/observability/knowledge-extraction/adapters/entity-link-api-producer.js';
import { KnowledgeLibraryApplication } from '../../src/observability/knowledge-extraction/library.js';
import { transitionEntityLinkInvocation, projectEntityLinkInvocation } from '../../src/knowledge/entities/link-invocation-state.js';
import { EntityLinkPreviewSchema, type EntityLinkInvocation, type EntityLinkInvocationStore, type EntityLinkInvocationTransaction } from '../../src/knowledge/entities/link-invocation.js';
import { entityLinkDigest } from '../../src/observability/knowledge-extraction/linking/entity-link-hash.js';
import { modelWindow } from './fixtures.js';

let root: string;
const servers: Server[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omk-link-host-')); });
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false); expect(readdirSync(root, { recursive: true }).filter(name => String(name).endsWith('.tmp'))).toEqual([]); rmSync(root, { recursive: true, force: true }); });
const knowledge = () => createLocalKnowledgeApplication(root);
async function window(name: string) {
  const source = knowledge().capture({ path: join(root, `${name}.jsonl`), origin: { threadId: name, title: name }, records: [{ recordIndex: 1,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
  const run = await knowledge().generate(source.snapshotId, { executor: 'recorded-fixture', model: 'no-model-call', generate: async (_system, input) => ({
    output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 }) });
  const analysis = knowledge().entities(run.runId), entity = analysis.revision.entities[0];
  const ref = { analysisId: run.runId, entityId: entity.entityId };
  const member = { ...ref, entityRevisionId: analysis.revision.revisionId, mentionIds: analysis.revision.mentions.filter(m => m.entityId === entity.entityId).map(m => m.mentionId), rationale: '人工核对来源' };
  return { source, run, analysis, ref, member };
}
const selection = { executor: 'openai-api', model: 'fixture-compatible-model' };
function suggestion(preview: ReturnType<EntityLinkApplication['preview']>) {
  return JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1, leftEntityId: preview.plan.left.entityId, rightEntityId: preview.plan.right.entityId,
    assessment: 'insufficient_evidence', leftMentionIds: preview.plan.left.mentionIds, rightMentionIds: preview.plan.right.mentionIds, rationale: '同名不能决定同一对象' });
}
async function api(handler: (body: unknown) => unknown | Promise<unknown>, status = 200) {
  let count = 0; const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part.toString(); count++; requests.push(JSON.parse(body));
    const output = await handler(JSON.parse(body)); response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(typeof output === 'string' || Buffer.isBuffer(output) ? output : JSON.stringify(output));
  }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing loopback address.');
  const env = { OPENAI_BASE_URL: `http://127.0.0.1:${address.port}`, OPENAI_API_KEY: 'fixture-long-private-key' };
  return { env, get count() { return count; }, requests };
}
const native = (output: string, finish = 'stop') => ({ choices: [{ message: { content: output }, finish_reason: finish }], usage: { prompt_tokens: 13, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } });
const prepare = (app: EntityLinkApplication, preview: ReturnType<EntityLinkApplication['preview']>) => app.prepare({ reviewId: preview.reviewId, requestId: preview.requestId, plan: preview.plan, confirmDigest: preview.plan.confirmedDigest });
const start = (app: EntityLinkApplication, reviewId: string) => app.start({ reviewId, requestId: randomUUID(), expectedGeneration: 1 });
const accept = (app: EntityLinkApplication, review: EntityLinkInvocation) => app.decide({ reviewId: review.reviewId, requestId: randomUUID(), expectedGeneration: review.generation,
  decision: 'accept', identityConfirmed: true, reason: '人工逐项核对两侧来源后确认', objectLabel: 'Alpha 对象' });
function host(env: NodeJS.ProcessEnv, store: EntityLinkInvocationStore = new FileEntityLinkStore(join(root, 'entity-links'), root), create = createExecutor) {
  return new EntityLinkApplication(knowledge(), new FileEntityAnalysisStore(join(root, 'entities'), root), store, new FileLibraryStore(join(root, 'library'), root), createOpenAiArchiveProducer(env, create));
}
function faultStore(stage: 'execution_recorded' | 'application_applied', after: boolean) {
  const base = new FileEntityLinkStore(join(root, 'entity-links'), root); let fail = true;
  const store: EntityLinkInvocationStore = { read: id => base.read(id), list: () => base.list(), transaction: operation => base.transaction(transaction => operation({ ...transaction,
    save: (history, generation) => {
      if (fail && history.events.at(-1)!.command.commandKind === stage) { fail = false; if (after) transaction.save(history, generation); throw new Error('simulated publication/ack failure'); }
      return transaction.save(history, generation);
    } })) };
  return store;
}

describe('entity-link actual host/store/API flow', () => {
  it('keeps preview local, freezes the production body/env, persists once before dispatch and reopens complete evidence', async () => {
    const a = await window('a'), b = await window('b');
    const transport = await api(body => { expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false); const saved = host(transport.env).read(preview.reviewId);
      expect(saved.events.at(-1)!.command.commandKind).toBe('start'); expect(body).toMatchObject({ model: selection.model, n: 1, stream: false, max_completion_tokens: 4096, response_format: { type: 'json_schema' } }); return native(suggestion(preview)); });
    const app = createLocalEntityLinks(root, createOpenAiArchiveProducer(transport.env)); const preview = app.preview(a.ref, b.ref, selection);
    expect(transport.count).toBe(0); expect(app.list()).toEqual([]);
    expect(app.quality()).toMatchObject({ readStatus: 'available', reviewCount: 0, groups: [] });
    const altered = structuredClone(preview); altered.input.left.entity.label = '与发送计划不同的展示'; expect(() => EntityLinkPreviewSchema.parse(altered)).toThrow('content/context');
    const forgedContext = structuredClone(preview); (forgedContext.producerContext.proof as Record<string, unknown>).endpoint = 'https://unconfirmed.invalid/v1/chat/completions'; expect(() => parseEntityLinkPreview(forgedContext)).toThrow('integrity');
    expect(parseEntityLinkPreview(preview)).toEqual(preview); expect(preview.plan.producerContextDigest).toBe(preview.producerContext.reservationDigest); const stored = prepare(app, preview);
    expect(stored.events[0].facts.reservation).toMatchObject({ producerId: 'openai-chat-archive/v1' });
    expect(entityLinkAllocation(stored)).toBeLessThan(ENTITY_LINK_NAMESPACE_BYTES);
    transport.env.OPENAI_BASE_URL = 'http://127.0.0.1:1'; // constructor already owns a private snapshot
    const completed = await start(app, preview.reviewId); expect(transport.count).toBe(1);
    expect(app.project(preview.reviewId)).toMatchObject({ status: 'awaiting_review', invocationBudget: { consumed: 1 }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 0, costUSD: null } });
    expect(app.inspect(preview.reviewId)).toEqual({ history: completed, projection: app.projectHistory(completed) });
    expect(host({}).read(preview.reviewId)).toEqual(completed); expect(prepare(host({}), preview)).toEqual(completed); expect(app.resume(preview.reviewId)).toEqual(completed);
    expect(await start(app, preview.reviewId)).toEqual(completed); expect(transport.count).toBe(1);
  });
  it('rejects missing confirmation, unsupported capacity, changed source/owner and extreme actual redactor growth before dispatch', async () => {
    const a = await window('a'), b = await window('b'); const create = vi.fn(createExecutor), app = host({ OPENAI_API_KEY: 'valid-long-test-key' }, undefined, create);
    const preview = app.preview(a.ref, b.ref, selection);
    expect(() => app.prepare({ ...preview, confirmDigest: 'not-confirmed' })).toThrow('confirmation');
    expect(() => app.preview(a.ref, b.ref, { executor: 'codex', model: 'fixture' })).toThrow('not yet proven'); expect(create).not.toHaveBeenCalled();
    expect(() => prepare(host({}), preview)).toThrow('OPENAI_API_KEY');
    expect(preview.producerContext).toMatchObject({ proof: { endpoint: 'https://api.openai.com/v1/chat/completions' } });
    const huge = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`PRIVATE_${i}_TOKEN`, String.fromCharCode(65 + i)]));
    expect(openAiArchiveDiagnosticGrowth(huge)).toBeGreaterThan(1_000_000n); expect(() => prepare(host({ ...huge, OPENAI_API_KEY: 'test-private-key' }), preview)).toThrow('growth');
    createLocalKnowledgeLibrary(root).save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null, identityConfirmed: true,
      reason: '人工组织', draft: { label: '旧 owner', description: '限定对象', referentKind: 'object', members: [a.member] } });
    expect(() => prepare(app, preview)).toThrow('owner_conflict'); expect(app.list()).toEqual([]);
    const updated = app.preview(a.ref, b.ref, selection); prepare(app, updated);
    const corrected = structuredClone(a.analysis.revision.entities); corrected[0].description = '新限定';
    knowledge().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities: corrected, mentions: a.analysis.revision.mentions }, '人工纠正');
    await expect(start(app, updated.reviewId)).rejects.toThrow('entity_changed'); expect(app.project(updated.reviewId).invocationBudget.consumed).toBe(0);
    expect(app.read(updated.reviewId).events).toHaveLength(1);
  });
  it('archives and reopens complete API evidence when the wall clock moves backwards', async () => {
    const a = await window('a'), b = await window('b');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(native(suggestion(preview)))));
    const app = host({ OPENAI_API_KEY: 'hermetic-fake-transport-only' }, undefined, (name, options) => {
      const execute = createExecutor(name, options);
      return async input => {
        const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(500);
        try { return await execute(input); } finally { clock.mockRestore(); }
      };
    });
    const preview = app.preview(a.ref, b.ref, selection); prepare(app, preview);
    const completed = await start(app, preview.reviewId);
    expect(completed.events.at(-1)!.command).toMatchObject({ commandKind: 'execution_recorded',
      outcome: { outcomeKind: 'result', result: { ok: true, output: suggestion(preview), durationMs: -500, inputTokens: 10, cacheReadTokens: 3, outputTokens: 5 } } });
    expect(host({}).read(preview.reviewId)).toEqual(completed);
    expect(app.projectHistory(completed).status).toBe('awaiting_review');
    expect(entityLinkAllocation(completed)).toBeLessThan(ENTITY_LINK_NAMESPACE_BYTES);
    expect(await start(app, preview.reviewId)).toEqual(completed);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('claims one durable start across concurrent hosts, read/list/resume do not dispatch, and late abort retains the result', async () => {
    const a = await window('a'), b = await window('b'); let release!: () => void, received!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), arrived = new Promise<void>(resolve => { received = resolve; });
    const transport = await api(async () => { received(); await gate; return native(suggestion(preview)); });
    const controller = new AbortController(), app = host(transport.env, undefined, (name, options) => { const executor = createExecutor(name, options); return async input => { const result = await executor(input); controller.abort(); return result; }; });
    const preview = app.preview(a.ref, b.ref, selection); prepare(app, preview);
    const pending = app.start({ reviewId: preview.reviewId, requestId: randomUUID(), expectedGeneration: 1 }, controller.signal); await arrived;
    const other = host(transport.env); expect((await start(other, preview.reviewId)).events.at(-1)!.command.commandKind).toBe('start');
    other.list(); other.read(preview.reviewId); other.resume(preview.reviewId); expect(transport.count).toBe(1);
    expect(() => other.recoverUnknown(preview.reviewId, randomUUID())).toThrow('live or unverifiable'); release(); await pending;
    expect(controller.signal.aborted).toBe(true); expect(app.project(preview.reviewId).status).toBe('awaiting_review'); expect(transport.count).toBe(1);
  });
  it.each(['rate_limit', 'refusal', 'truncation', 'invalid_json', 'usage_overflow'] as const)('archives real API %s raw/failure/refusal/usage without retry', async mode => {
    const a = await window('a'), b = await window('b');
    const transport = await api(() => ({ ...native(mode === 'invalid_json' ? '{bad' : '完整原始部分输出', mode === 'truncation' ? 'length' : 'stop'),
      ...(mode === 'rate_limit' ? { error: { message: 'rate limited' } } : {}),
      ...(mode === 'usage_overflow' ? { usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: Number.MAX_SAFE_INTEGER } } : {}),
      choices: [{ message: { content: mode === 'invalid_json' ? '{bad' : '完整原始部分输出', ...(mode === 'refusal' || mode === 'rate_limit' ? { refusal: '完整拒绝通道' } : {}) }, finish_reason: mode === 'truncation' ? 'length' : 'stop' }] }), mode === 'rate_limit' ? 429 : 200);
    const app = host(transport.env), preview = app.preview(a.ref, b.ref, selection); prepare(app, preview); const review = await start(app, preview.reviewId);
    const archived = review.events.at(-1)!.command; expect(archived).toMatchObject({ commandKind: 'execution_recorded', outcome: { outcomeKind: 'result', result: { output: mode === 'invalid_json' ? '{bad' : '完整原始部分输出', inputTokens: mode === 'usage_overflow' ? Number.MAX_SAFE_INTEGER : 10, outputTokens: mode === 'usage_overflow' ? Number.MAX_SAFE_INTEGER : 5, cacheReadTokens: mode === 'usage_overflow' ? 0 : 3 } } });
    if (mode !== 'invalid_json' && mode !== 'usage_overflow') expect(archived).toMatchObject({ outcome: { result: { failure: { failureKind: mode } } } });
    if (mode === 'refusal' || mode === 'rate_limit') expect(archived).toMatchObject({ outcome: { result: { refusal: '完整拒绝通道' } } });
    expect(app.project(preview.reviewId).status).toBe('execution_failed'); expect(transport.count).toBe(1);
    expect(() => app.preview(a.ref, b.ref, selection)).toThrow('retryOf');
    expect(app.preview(a.ref, b.ref, selection, preview.reviewId).plan.retryOf).toBe(preview.reviewId);
  });
  it.each([false, true])('recovers an archive %s publication acknowledgement failure from held raw without re-execution', async after => {
    const a = await window('a'), b = await window('b');
    const transport = await api(() => native(suggestion(preview))), app = host(transport.env, faultStore('execution_recorded', after));
    const preview = app.preview(a.ref, b.ref, selection); prepare(app, preview);
    await expect(start(app, preview.reviewId)).rejects.toBeInstanceOf(EntityLinkArchiveError); expect(transport.count).toBe(1);
    expect(app.project(preview.reviewId).status).toBe(after ? 'awaiting_review' : 'running');
    const recovered = app.resume(preview.reviewId); expect(app.project(preview.reviewId).status).toBe('awaiting_review');
    expect(recovered.events.filter(event => event.command.commandKind === 'execution_recorded')).toHaveLength(1); expect(transport.count).toBe(1);
  });
  it('preserves exception unknown without touching arbitrary thrown objects and pre-abort never refunds a started slot', async () => {
    const a = await window('a'), b = await window('b'); let touched = 0;
    const thrown = new Proxy({}, { get() { touched++; throw new Error('getter'); }, getOwnPropertyDescriptor() { touched++; throw new Error('descriptor'); } });
    const app = host({ OPENAI_API_KEY: 'private-test-key' }, undefined, () => async () => { throw thrown; });
    const preview = app.preview(a.ref, b.ref, selection); prepare(app, preview); await start(app, preview.reviewId);
    expect(touched).toBe(0); expect(app.project(preview.reviewId)).toMatchObject({ status: 'execution_unknown', invocationBudget: { consumed: 1 }, usage: { inputTokens: null, costUSD: null } });
    const next = app.preview(a.ref, b.ref, selection, preview.reviewId); prepare(app, next); const controller = new AbortController(); controller.abort();
    await app.start({ reviewId: next.reviewId, requestId: randomUUID(), expectedGeneration: 1 }, controller.signal);
    expect(app.project(next.reviewId).status).toBe('execution_unknown'); expect(app.project(next.reviewId).invocationBudget.consumed).toBe(1);
  });
  it('requires a real exited local owner for crash recovery and never starts from resume or an unknown read', async () => {
    const a = await window('a'), b = await window('b'), transport = await api(() => native('unused'));
    const app = host(transport.env), preview = app.preview(a.ref, b.ref, selection); const saved = prepare(app, preview);
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']); const pid = child.pid!; await once(child, 'exit');
    const config = configureEntityLinkApiProducer(preview.plan.request, createOpenAiArchiveProducer(transport.env)), base = new FileEntityLinkStore(join(root, 'entity-links'), root);
    const command = { commandKind: 'start' as const, reviewId: preview.reviewId, requestId: randomUUID(), eventId: randomUUID(), expectedGeneration: 1,
      at: new Date().toISOString(), actor: { actorKind: 'agent' as const, actorId: 'crashed-host', executionRef: preview.reviewId }, executionId: randomUUID(), owner: { ownerId: randomUUID(), hostname: hostname(), pid } };
    const started = transitionEntityLinkInvocation(saved, command, { hashJson: entityLinkDigest, hashText: entityLinkTextHash, reserve: () => config.reservation,
      reservationIsCurrent: () => true, proveOwnerExited: () => undefined }).history;
    base.transaction(tx => tx.save(started, 1)); const reopened = host(transport.env); reopened.list(); reopened.resume(preview.reviewId);
    expect(reopened.project(preview.reviewId).status).toBe('running'); reopened.recoverUnknown(preview.reviewId, randomUUID());
    expect(reopened.project(preview.reviewId)).toMatchObject({ status: 'execution_unknown', invocationBudget: { consumed: 1 }, canStart: false });
    expect((await start(reopened, preview.reviewId)).events).toHaveLength(3); expect(transport.count).toBe(0);
  });
  it.each(['library_ack', 'review_ack'] as const)('restores accepted organization after %s with the stable receipt, preserving original entities/knowledge', async fault => {
    const a = await window('a'), b = await window('b');
    const transport = await api(() => native(suggestion(preview))), app = host(transport.env, fault === 'review_ack' ? faultStore('application_applied', false) : undefined);
    const preview = app.preview(a.ref, b.ref, selection); prepare(app, preview); const completed = await start(app, preview.reviewId);
    const entityFile = join(root, 'entities', `${a.run.runId}.json`), entitiesBefore = readFileSync(entityFile);
    if (fault === 'library_ack') { const original = KnowledgeLibraryApplication.prototype.applyLinkIntent; vi.spyOn(KnowledgeLibraryApplication.prototype, 'applyLinkIntent').mockImplementationOnce(function (this: KnowledgeLibraryApplication, ...args) { original.apply(this, args); throw new Error('lost library ack'); }); }
    expect(() => accept(app, completed)).toThrow(); expect(app.project(preview.reviewId).status).toBe('accepted_pending_application');
    const prior = createLocalKnowledgeLibrary(root).catalog(); expect(prior.objectCount).toBe(1);
    knowledge().deleteSource(a.source.snapshotId); // receipt-first recovery must precede current-source checks
    const applied = host(transport.env).resume(preview.reviewId); expect(projectEntityLinkInvocation(applied, { hashJson: entityLinkDigest, hashText: entityLinkTextHash }).status).toBe('applied');
    expect(createLocalKnowledgeLibrary(root).detail(prior.rows[0].objectId).history.generation).toBe(1); expect(readFileSync(entityFile)).toEqual(entitiesBefore); expect(transport.count).toBe(1);
  });
  it('persists a human rejection, suppresses same revision after restart and retains a changed-source terminal conflict', async () => {
    const a = await window('a'), b = await window('b'); let preview!: ReturnType<EntityLinkApplication['preview']>;
    const transport = await api(() => native(suggestion(preview))), app = host(transport.env); preview = app.preview(a.ref, b.ref, selection); prepare(app, preview); const complete = await start(app, preview.reviewId);
    app.decide({ reviewId: complete.reviewId, requestId: randomUUID(), expectedGeneration: complete.generation, decision: 'reject', reason: '同名证据不足' });
    expect(() => host(transport.env).preview(b.ref, a.ref, selection, complete.reviewId)).toThrow('pair_already_reviewed'); expect(app.recall(a.ref).rows).toEqual([]);
    const c = await window('c'), d = await window('d'); preview = app.preview(c.ref, d.ref, selection); prepare(app, preview); const another = await start(app, preview.reviewId);
    knowledge().deleteSource(c.source.snapshotId); const accepted = accept(app, another);
    expect(app.project(accepted.reviewId).status).toBe('accepted_conflict'); expect(accepted.events.at(-1)!.command).toMatchObject({ application: { conflictCode: 'source_unavailable' } });
    expect(createLocalKnowledgeLibrary(root).catalog().objectCount).toBe(0);
    const quality = app.quality(); expect(quality.readStatus).toBe('available'); expect(quality.groups).toHaveLength(1);
    expect(quality.groups[0]).toMatchObject({ reviews: { total: 2, dispatched: 2 }, admission: { admitted: 2 },
      humanDecisions: { decided: 2, accepted: 1, rejected: 1 }, organization: { acceptedConflict: 1 }, usage: { costUSD: { unknownReviewCount: 2, knownTotal: null } } });
    expect(transport.count).toBe(2); // Aggregation neither rereads deleted sources nor dispatches another request.
  });
  it('preserves an existing owner and unrelated members, and terminates known library history capacity', async () => {
    const a = await window('a'), b = await window('b'), c = await window('c'); let preview!: ReturnType<EntityLinkApplication['preview']>;
    const transport = await api(() => native(suggestion(preview))), app = host(transport.env), library = createLocalKnowledgeLibrary(root);
    const owner = library.save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null, identityConfirmed: true,
      reason: '人工组织', draft: { label: 'Alpha 对象', description: '有范围限定', referentKind: 'object', members: [a.member, c.member] } });
    preview = app.preview(a.ref, b.ref, selection); prepare(app, preview); const result = await start(app, preview.reviewId); accept(app, result);
    const saved = library.detail(owner.objectId).history; expect(saved.generation).toBe(2); expect(saved.revisions.at(-1)!.draft.members).toHaveLength(3);
    expect(saved.revisions.at(-1)!.draft.members.find(member => member.entityId === c.member.entityId)).toEqual(c.member);
    const d = await window('d'), e = await window('e'), full = library.save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null, identityConfirmed: true,
      reason: '人工组织', draft: { label: 'Alpha 对象', description: '有范围限定', referentKind: 'object', members: [d.member] } });
    while (full.revisions.length < 256) { const previous = full.revisions.at(-1)!, revisionId = randomUUID();
      full.revisions.push({ ...previous, revisionId, parentRevisionId: previous.revisionId }); full.receipts.push({ requestId: randomUUID(), commandDigest: entityLinkDigest(revisionId), committedGeneration: full.revisions.length, revisionId }); }
    full.generation = 256; full.writeHeadRevisionId = full.revisions.at(-1)!.revisionId; writeFileSync(join(root, 'library', `${full.objectId}.json`), JSON.stringify(full));
    preview = app.preview(d.ref, e.ref, selection); prepare(app, preview); const completed = await start(app, preview.reviewId); accept(app, completed);
    expect(app.project(preview.reviewId).status).toBe('accepted_conflict'); expect(app.read(preview.reviewId).events.at(-1)!.command).toMatchObject({ conflictCode: 'library_capacity' });
    expect(library.detail(full.objectId).history.generation).toBe(256); expect(app.resume(preview.reviewId)).toEqual(app.read(preview.reviewId));
  });
  it('rejects changed production request context before start and checks exact bytes at dispatch', async () => {
    const a = await window('a'), b = await window('b'), transport = await api(() => native('unused')), app = host(transport.env);
    const preview = app.preview(a.ref, b.ref, selection);
    expect(() => prepare(host({ ...transport.env, OPENAI_BASE_URL: 'http://127.0.0.1:1' }), preview)).toThrow('producer context');
    expect(app.list()).toEqual([]); prepare(app, preview);
    await expect(start(host({ ...transport.env, OPENAI_BASE_URL: 'http://127.0.0.1:1' }), preview.reviewId)).rejects.toThrow('reservation changed');
    expect(app.project(preview.reviewId).status).toBe('prepared'); expect(transport.count).toBe(0);
    const changed = host(transport.env, undefined, (name, options) => { const executor = createExecutor(name, options); return input => executor({ ...input, prompt: 'tampered delivery input' }); });
    await start(changed, preview.reviewId); expect(transport.count).toBe(0); expect(app.project(preview.reviewId).status).toBe('execution_failed');
    expect(app.read(preview.reviewId).events.at(-1)!.command).toMatchObject({ outcome: { result: { failure: { failureKind: 'invalid_request' }, error: 'API dispatch identity conflict.' } } });
  });
  it('reserves actual worst-case namespace space before publication and rejects known exhaustion without creating a pending file', async () => {
    const a = await window('a'), b = await window('b'), env = { OPENAI_API_KEY: 'long-test-private-key' }, app = host(env);
    const plans = Array.from({ length: 3 }, () => app.preview(a.ref, b.ref, selection)), store = new FileEntityLinkStore(join(root, 'entity-links'), root);
    const histories = plans.map(preview => { const config = configureEntityLinkApiProducer(preview.plan.request, createOpenAiArchiveProducer(env));
      return transitionEntityLinkInvocation(undefined, { commandKind: 'prepare', reviewId: preview.reviewId, requestId: preview.requestId, eventId: randomUUID(), at: new Date().toISOString(),
        actor: { actorKind: 'human', actorId: 'local-user' }, expectedGeneration: 0, input: preview.plan }, { hashJson: entityLinkDigest, hashText: entityLinkTextHash,
          reserve: () => config.reservation, reservationIsCurrent: () => true, proveOwnerExited: () => undefined }).history; });
    expect(entityLinkAllocation(histories[0]) * 2).toBeLessThan(ENTITY_LINK_NAMESPACE_BYTES); expect(entityLinkAllocation(histories[0]) * 3).toBeGreaterThan(ENTITY_LINK_NAMESPACE_BYTES);
    store.transaction(tx => tx.save(histories[0], 0)); store.transaction(tx => tx.save(histories[1], 0));
    expect(() => store.transaction(tx => tx.save(histories[2], 0))).toThrow('capacity'); expect(store.list()).toHaveLength(2);
    expect(existsSync(join(root, 'entity-links', `${histories[2].reviewId}.json`))).toBe(false);
  });
  it('reserves UTF-8 replacement and duplicate refusal channels at the real 4 MiB transport boundary', async () => {
    const a = await window('a'), b = await window('b');
    const prefix = Buffer.from('{"choices":[{"message":{"content":null,"refusal":"'), suffix = Buffer.from('"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}');
    const count = 4 * 1024 * 1024 - prefix.length - suffix.length;
    const transport = await api(() => Buffer.concat([prefix, Buffer.alloc(count, 0xff), suffix])), app = host(transport.env), preview = app.preview(a.ref, b.ref, selection);
    const before = prepare(app, preview), completed = await start(app, preview.reviewId), last = completed.events.at(-1)!.command;
    if (last.commandKind !== 'execution_recorded' || last.outcome.outcomeKind !== 'result') throw new Error('Missing result.');
    expect(last.outcome.result.output?.length).toBe(count); expect(Buffer.byteLength(last.outcome.result.output!)).toBe(3 * count);
    expect(last.outcome.result.refusal).toBe(last.outcome.result.output); expect(last.outcome.result.failure?.failureKind).toBe('refusal');
    const actualBytes = Buffer.byteLength(JSON.stringify(last.outcome));
    expect(actualBytes).toBeLessThan((before.events[0].facts.reservation as { maxOutcomeJsonBytes: number }).maxOutcomeJsonBytes);
    expect(app.read(preview.reviewId)).toEqual(completed); expect(transport.count).toBe(1);
  });
  it('keeps an unreadable library capacity error pending and validates the unchanged owner anchor before any publication', async () => {
    const a = await window('a'), b = await window('b');
    const transport = await api(() => native(suggestion(preview))), app = host(transport.env), library = createLocalKnowledgeLibrary(root);
    const owner = library.save({ objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null, identityConfirmed: true,
      reason: '人工组织', draft: { label: 'Alpha 对象', description: '有范围限定', referentKind: 'object', members: [a.member] } });
    const preview = app.preview(a.ref, b.ref, selection); prepare(app, preview); const completed = await start(app, preview.reviewId);
    vi.spyOn(KnowledgeLibraryApplication.prototype, 'applyLinkIntent').mockImplementationOnce(() => { throw new Error('pause before publication'); });
    expect(() => accept(app, completed)).toThrow('pause'); expect(app.project(preview.reviewId).status).toBe('accepted_pending_application');
    vi.spyOn(FileLibraryStore.prototype, 'list').mockImplementationOnce(() => { throw new Error('Library capacity exceeded.'); });
    expect(() => app.resume(preview.reviewId)).toThrow('Library capacity exceeded.'); expect(app.project(preview.reviewId).status).toBe('accepted_pending_application');
    const entities = structuredClone(a.analysis.revision.entities); entities[0].description = '人工重新限定原有owner成员';
    knowledge().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '更正原有anchor');
    const resumed = app.resume(preview.reviewId); expect(resumed.events.at(-1)!.command).toMatchObject({ conflictCode: 'entity_changed' });
    expect(library.detail(owner.objectId).history.generation).toBe(1); expect(transport.count).toBe(1);
  });
  it('allows explicit organization naming without truncating a long extracted label or persisting an unusable decision', async () => {
    const a = await window('a'), b = await window('b'); const entities = structuredClone(a.analysis.revision.entities); entities[0].label = 'A'.repeat(257);
    knowledge().correctEntities(a.run.runId, a.analysis.revision.revisionId, 1, { entities, mentions: a.analysis.revision.mentions }, '保留完整名称');
    const transport = await api(() => native(suggestion(preview))), app = host(transport.env), preview = app.preview(a.ref, b.ref, selection);
    prepare(app, preview); const completed = await start(app, preview.reviewId);
    expect(() => app.decide({ reviewId: preview.reviewId, requestId: randomUUID(), expectedGeneration: completed.generation, decision: 'accept', identityConfirmed: true, reason: '人工确认' })).toThrow('explicit organization label');
    expect(app.project(preview.reviewId).status).toBe('awaiting_review'); accept(app, completed); expect(app.project(preview.reviewId).status).toBe('applied');
    expect(knowledge().entities(a.run.runId).revision.entities[0].label).toHaveLength(257); expect(transport.count).toBe(1);
  });
  it('fails closed on corrupt/unsupported/symlink files, releases atomic temps/locks, and rejects escaped transactions', async () => {
    const a = await window('a'), b = await window('b'), app = host({ OPENAI_API_KEY: 'fixture-key-long' });
    const preview = app.preview(a.ref, b.ref, selection), saved = prepare(app, preview), file = join(root, 'entity-links', `${saved.reviewId}.json`), bytes = readFileSync(file);
    writeFileSync(file, '{bad'); expect(() => app.list()).toThrow(); expect(() => app.recall(a.ref)).toThrow();
    expect(app.quality()).toMatchObject({ readStatus: 'unreadable', reviewCount: null, groups: [] });
    writeFileSync(file, JSON.stringify({ ...saved, storeKind: 'entity-link-review-history' }));
    expect(() => app.read(saved.reviewId)).toThrow('knowledge_storage_unsupported'); writeFileSync(file, bytes);
    let escaped!: EntityLinkInvocationTransaction; new FileEntityLinkStore(join(root, 'entity-links'), root).transaction(tx => { escaped = tx; });
    expect(() => escaped.save(saved, 1)).toThrow('expired'); expect(existsSync(join(root, '.knowledge-write.lock'))).toBe(false);
    app.cancelBeforeStart({ reviewId: saved.reviewId, requestId: randomUUID(), expectedGeneration: 1, reason: '明确取消发送' }); expect(app.project(saved.reviewId).invocationBudget).toEqual({ reserved: 0, consumed: 0 });
    rmSync(file); symlinkSync(join(root, 'entities', `${a.run.runId}.json`), file); expect(() => app.list()).toThrow('Invalid entity-link file');
  });
});
