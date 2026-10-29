import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication } from '../../../src/knowledge/application/local.js';
import type { ConversationCatalog, ConversationTaskTrajectory } from '../../../src/observability/conversation/catalog.js';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { executeArtifactAuthoring } from '../../../src/studio/application/knowledge/artifact-authoring.js';
import { WORKSPACE_LOCK_FILE } from '../../../src/evidence/storage/knowledge-workspace.js';
import { KnowledgeApplication } from '../../../src/knowledge/application/application.js';
import { EntityAnalysisWriteCapacityError } from '../../../src/knowledge/entities/contracts.js';
import { authoredKnowledgeResponse, seedKnowledgeWorkspace } from '../../cli/knowledge-fixtures.js';
import type { KnowledgeGenerationModel } from '../../../src/knowledge/adapters/generation-executor.js';
import type { GenerationOutcome } from '../../../src/knowledge/extraction/native-outcome.js';
import { AUTO_EXTRACTION_WORKFLOW } from '../../../src/knowledge/application/auto-extraction.js';
import { retrieveKnowledge } from '../../../src/knowledge/application/retrieval.js';
import { writeJsonFileAtomic } from '../../../src/shared/atomic-json.js';
import { FileKnowledgeReviewStore } from '../../../src/knowledge/adapters/review-store.js';
import type { KnowledgeReviewContentInput, KnowledgeReviewStatus } from '../../../src/studio/view-models/knowledge/knowledge-reviews.js';

/** Pure authored responses exercise current journal/publication paths without any model execution. */
function currentModel(multiple = false, outcome?: GenerationOutcome): KnowledgeGenerationModel {
  return { executor: 'authored-http-fixture', model: 'no-model-call', timeoutMs: 300_000,
    inspect: () => ({ producerId: 'authored-http-fixture', producerRevision: 'v1', sourceChannels: [], maxOutcomeJsonBytes: 1024 * 1024, proof: { nativeObserved: false } }),
    async invoke(profile, input, _signal, gate): Promise<GenerationOutcome> {
      gate?.(); if (outcome) return outcome;
      const response = authoredKnowledgeResponse(input, profile.stageKind);
      if (multiple && 'proposals' in response && response.proposals) response.proposals.push({ ...structuredClone(response.proposals[0]), proposalId: 'second-candidate' });
      return { outcomeKind: 'result', result: { ok: true, output: JSON.stringify(response), authoredFixture: true } };
    } };
}

describe('Studio candidate action boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'omk-candidate-api-'));
  const workspace = join(root, 'knowledge');
  const source = join(root, 'source.jsonl');
  let changed = false;
  let whole = false;
  let incomplete = false;
  const message = (role: string, text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  const catalog: ConversationCatalog = {
    async listConversations() { return { conversations: [], totalTurnCount: 0, totalToolCallCount: 0, totalToolFailureCount: 0 }; },
    async getConversation(threadId) { return threadId === 'thread' ? { threadId, sourceThreadId: threadId, sourceKind: 'codex', title: '项目对话', cwd: '/project', tasks: [{ turnId: 'turn', title: '处理问题', status: 'completed', eventCount: 3, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }, ...(whole ? [{ turnId: 'second', title: '第二轮', status: 'completed' as const, eventCount: 1, toolCallCount: 0, toolFailureCount: 0, relatedSkillNames: [] }] : [])], relatedSkillNames: [] } : undefined; },
    async loadTaskTrajectory(_thread, turn, options) { expect(options?.includeNextHumanMessage).toBe(false); if (incomplete) return undefined; if (turn === 'second') return { session: { sourceTrace: source }, sourceRecords: { status: 'available', truncated: false, records: [{ sourceIndex: 20, raw: message('user', '第二轮事实'), truncated: false }] } } as ConversationTaskTrajectory; return { session: { sourceTrace: source }, sourceRecords: { status: 'available', truncated: false, records: [
      { sourceIndex: 10, raw: message('user', changed ? 'changed' : '选择这条约束'), truncated: false },
      { sourceIndex: 11, raw: message('assistant', '不要自动带上这条回复'), truncated: false },
    ] } } as ConversationTaskTrajectory; },
  };
  let server: ReturnType<typeof createReportServer>;
  let url: string;
  beforeAll(async () => {
    writeFileSync(source, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '项目约束' }] } }));
    server = createReportServer({ port: 0, conversationCatalog: catalog, observationsDir: join(root, 'observations'), analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors') });
    url = await server.start();
  });
  afterAll(async () => { await server?.stop(); rmSync(root, { recursive: true, force: true }); });
  const post = (body: Record<string, unknown>, origin?: string) => fetch(`${url}/api/knowledge/candidates`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ workspace, ...body }),
  });
  const postReview = (body: Record<string, unknown>, origin?: string) => fetch(`${url}/api/knowledge/reviews`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  it('previews automation without permission, requires fresh explicit consent, and can stop before any call', async () => {
    const auto = (body: Record<string, unknown>, origin?: string) => fetch(`${url}/api/knowledge/auto-extraction`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
    });
    expect((await auto({ operation: 'status', workspace, threadId: 'thread' }, 'https://untrusted.example')).status).toBe(403);
    const preview = await (await auto({ operation: 'preview', threadId: 'thread' })).json();
    expect(preview.turnCount).toBe(1); expect(preview.messages).toHaveLength(2);
    expect(await (await auto({ operation: 'status', workspace, threadId: 'thread' })).json()).toBeNull();
    const consent = { workflowId: AUTO_EXTRACTION_WORKFLOW, operation: 'enable', workspace, threadId: 'thread', token: preview.token, executor: 'codex', model: 'not-invoked', maxCalls: 1 };
    expect((await auto({ ...consent, maxCalls: 0 })).status).toBe(400);
    expect((await auto({ ...consent, policy: {} })).status).toBe(400);
    expect((await auto({ ...consent, workflowId: undefined })).status).toBe(400);
    changed = true; expect((await auto(consent)).status).toBe(409); changed = false;
    expect((await auto(consent)).status).toBe(200);
    expect(await (await auto({ operation: 'stop', workspace, threadId: 'thread' })).json()).toMatchObject({ enabled: false, reason: 'stopped', callsUsed: 0 });
    // Schema2 explicitly authorizes both phases, each charged separately; preview/enable never constructs a model.
    expect(await (await auto(consent)).json()).toMatchObject({ schemaVersion: 2, workflowId: AUTO_EXTRACTION_WORKFLOW, callsUsed: 0 });
    expect(await (await auto({ operation: 'stop', workspace, threadId: 'thread' })).json()).toMatchObject({ enabled: false, reason: 'stopped', callsUsed: 0 });
    expect(createLocalKnowledgeApplication(workspace).runs()).toEqual({ current: [], unsupported: [], unavailable: [], archiveChecks: [] });
  });
  it('adds only ephemeral status tags and observes external atomic JSON heads without trusting a client revision', async () => {
    const selected = join(root, 'status-heads');
    const status = (tag?: string) => fetch(`${url}/api/knowledge/auto-extraction`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(tag ? { 'if-none-match': tag } : {}) },
      body: JSON.stringify({ operation: 'status', workspace: selected, threadId: 'head-thread' }),
    });
    const initial = await status(); expect(initial.status).toBe(200); expect(await initial.text()).toBe('null');
    expect(initial.headers.get('cache-control')).toBe('no-store');
    let previous = initial.headers.get('etag')!; expect(previous).toMatch(/^W\/"omk-ui-[a-f0-9]{64}"$/);
    const unchanged = await status(previous); expect(unchanged.status).toBe(200); expect(await unchanged.text()).toBe('null');
    expect(unchanged.headers.get('etag')).toBe(previous);
    const normalized = await fetch(`${url}/api/knowledge/auto-extraction`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'status', workspace: ` ${selected} `, threadId: ' head-thread ' }) });
    expect(normalized.status).toBe(200); expect(normalized.headers.get('etag')).toBe(previous);
    for (const folder of ['items', 'generation-journals', 'associations', 'tags', 'entities']) {
      const name = ['items', 'tags'].includes(folder) ? 'a'.repeat(64) : randomUUID();
      const path = join(selected, folder, `${name}.json`);
      // Authored UI-head fixtures are never admitted as knowledge/run evidence.
      writeJsonFileAtomic(path, { value: 'aaaa' }); utimesSync(path, 1_600_000_000, 1_600_000_000);
      const added = await status(previous); expect(added.status).toBe(200); expect(await added.text()).toBe('null');
      expect(added.headers.get('etag')).not.toBe(previous); previous = added.headers.get('etag')!;
      const before = statSync(path);
      writeJsonFileAtomic(path, { value: 'bbbb' }); utimesSync(path, 1_600_000_000, 1_600_000_000);
      expect(statSync(path).size).toBe(before.size); expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
      expect(statSync(path).ino).not.toBe(before.ino); // Same length and restored mtime still cannot hide atomic replacement.
      const replaced = await status('W/"untrusted-client-hint"'); expect(replaced.status).toBe(200); expect(await replaced.text()).toBe('null');
      expect(replaced.headers.get('etag')).not.toBe(previous); previous = replaced.headers.get('etag')!;
    }
    const invalid = await fetch(`${url}/api/knowledge/auto-extraction`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'status', workspace: selected, threadId: 'head-thread', revision: previous }) });
    expect(invalid.status).toBe(400);
    const head = join(selected, 'items', `${'f'.repeat(64)}.json`), target = join(root, 'private-ui-head.json');
    writeJsonFileAtomic(target, { privateValue: 'not-a-knowledge-record' }); symlinkSync(target, head);
    const noHint = await status(previous); expect(noHint.status).toBe(200); expect(await noHint.text()).toBe('null');
    expect(noHint.headers.get('etag')).toBeNull(); expect(noHint.headers.get('cache-control')).toBe('no-store');
    unlinkSync(head);
    expect((await status()).headers.get('etag')).toBe(previous);
  });

  it('retrieves task content through the production read path with candidate/source/budget boundaries and no new generation', async () => {
    const selected = join(root, 'task-retrieval'), app = createLocalKnowledgeApplication(selected);
    const captured = app.capture({ path: join(root, 'task-source.jsonl'), records: [{ recordIndex: 0, raw: message('user', 'Alpha uses Beta diagnostics only with matching source, model and configuration. ' + 'This limitation remains specific. '.repeat(70)) }] });
    const run = await app.generate(captured.snapshotId, currentModel(true));
    const request = { operation: 'retrieve', workspace: selected, format: 'json', query: 'Alpha diagnostics', maxBytes: 8192,
      snapshot: captured.snapshotId, sourceVersion: captured.sourceVersion };
    const defaultResult = await (await post(request)).json();
    expect(defaultResult.items).toEqual([]);
    const response = await post({ ...request, includeCandidates: true });
    expect(response.status).toBe(200); const result = await response.json();
    expect(result).toEqual(retrieveKnowledge(app, { query: request.query, maxBytes: 8192, includeCandidates: true,
      snapshot: captured.snapshotId, sourceVersion: captured.sourceVersion }));
    expect(result.items.length).toBeGreaterThan(0); expect(run.journal.bodies).toContainEqual(result.knowledge[0].bodyRef);
    expect(result.omitted.budgetSegments).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result)) + 1).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(result)).not.toContain(selected);
    for (const invalid of [{ format: 'text' }, { sourceVersion: captured.sourceVersion, snapshot: undefined }, { analysisId: randomUUID() }, { maxBytes: 100 }, { executor: 'codex' }]) {
      expect((await post({ ...request, ...invalid })).status).toBe(400);
    }
    expect(app.list().every(row => row.choice === null)).toBe(true);
    const ref = result.knowledge[0].bodyRef, before = app.detail(ref.knowledgeId, ref.revisionId);
    app.revise(ref.knowledgeId, ref.revisionId, before.history.generation, { title: before.revision.title + ' — current revision', content: before.revision.content, reuseRationale: before.revision.reuseRationale }, 'Explicit fixture revision after retrieval');
    const historical = await (await post({ workspace: selected, operation: 'show', id: ref.knowledgeId, revision: ref.revisionId })).json();
    expect(historical.revision).toEqual(before.revision); expect(historical.history.writeHeadRevisionId).not.toBe(ref.revisionId);
    for (const row of app.list()) app.maintain(row.knowledgeId, row.revisionId, 'discard', 'Explicitly excluded test knowledge', row.generation);
    expect((await (await post({ ...request, includeCandidates: true })).json()).items).toEqual([]);
    expect(app.inspect(run.journal.runId).journal.generation).toBe(run.journal.generation);
  });

  it('writes independent reviews with exact bodies, CAS receipts and trusted local UI attribution', async () => {
    const selected = join(root, 'review-ledger'), fixture = seedKnowledgeWorkspace(selected, 'review-source');
    const bodyRef = { knowledgeId: fixture.body.knowledgeId, revisionId: fixture.body.revisionId, bodyDigest: fixture.body.bodyDigest };
    const identity = { workspace: selected, bodyRef };
    const status = async (ref: KnowledgeReviewStatus['bodyRef'] = bodyRef) => {
      const response = await postReview({ ...identity, bodyRef: ref, operation: 'review-status' });
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      return await response.json() as KnowledgeReviewStatus;
    };
    expect(await status()).toMatchObject({ storageStatus: 'absent', generation: 0, headEventId: null, content: { status: 'not_reviewed' } });
    expect((await fetch(`${url}/api/knowledge/reviews`)).status).toBe(405);
    expect((await postReview({ ...identity, operation: 'review-status' }, 'https://untrusted.example')).status).toBe(403);
    const input: KnowledgeReviewContentInput = { requestId: randomUUID(), bodyRef,
      sources: [{ snapshotId: fixture.source.snapshotId, sourceVersion: fixture.source.sourceVersion }], expectedGeneration: 0, expectedHeadEventId: null,
      status: 'needs_revision', reason: 'Review the exact delivered body before reusing it.', limitations: [],
      findings: [{ problemKind: 'omission', description: 'The canonical text omits an independently stated limitation.', segmentIds: [], evidence: [] }] };
    const command = { workspace: selected, operation: 'review-content', ...input };
    for (const fields of [{ actor: { actorKind: 'agent', actorId: 'browser-spoof', executionRef: 'untrusted' } }, { actorId: 'browser-spoof' }, { executor: 'codex' }]) {
      expect((await postReview({ ...command, ...fields })).status).toBe(400);
    }
    expect(await status()).toMatchObject({ storageStatus: 'absent', generation: 0 });
    const response = await postReview(command); expect(response.status).toBe(200);
    const receipt = await response.json(); expect(receipt).toMatchObject({ requestId: input.requestId, committedGeneration: 1 });
    expect(await (await postReview(command)).json()).toEqual(receipt);
    expect((await postReview({ ...command, reason: 'Same request with a changed command must fail.' })).status).toBe(409);
    expect((await postReview({ ...command, requestId: randomUUID() })).status).toBe(409);
    const reviewed = await status();
    expect(reviewed).toMatchObject({ storageStatus: 'available', generation: 1, headEventId: receipt.eventId, content: { status: 'needs_revision' } });
    expect(reviewed.history?.receipts).toEqual([receipt]);
    expect(reviewed.content.events[0]).toMatchObject({ bodyRef, actor: { actorKind: 'human', actorId: 'local-user' }, findings: [{ segmentIds: [] }] });
    const app = createLocalKnowledgeApplication(selected), current = app.detail(bodyRef.knowledgeId), projection = current.derivedAssociations.revision!;
    const coverage = await postReview({ ...identity, operation: 'review-coverage', requestId: randomUUID(), sources: input.sources,
      expectedGeneration: 1, expectedHeadEventId: receipt.eventId, projectionRevisionId: projection.revisionId, reason: 'Inspect only this exact projection.',
      decisions: [{ segmentId: 's1', status: 'linked', reason: 'The authored projection binds exact source mentions.',
        entityRefs: projection.segmentEntityRefs.map(ref => ({ analysisId: ref.analysisId, entityRevisionId: ref.entityRevisionId, entityId: ref.entityId, mentionIds: ref.mentionIds })) }] });
    expect(coverage.status).toBe(200); const coverageReceipt = await coverage.json();
    expect((await status()).coverage).toMatchObject({ status: 'recorded', projectionRevisionId: projection.revisionId,
      decisions: [{ segmentId: 's1', status: 'linked' }] });
    const revision = app.revise(bodyRef.knowledgeId, bodyRef.revisionId, current.history.generation,
      { title: current.revision.title + '（explicit fixture correction）', content: current.revision.content, reuseRationale: current.revision.reuseRationale }, 'Explicit test fixture revision');
    const newRef = { knowledgeId: revision.revision.knowledgeId, revisionId: revision.revision.revisionId, bodyDigest: revision.revision.bodyDigest };
    expect((await status(newRef)).content.status).toBe('not_reviewed');
    expect((await status()).content.status).toBe('needs_revision');
    expect((await status(newRef)).coverage).toMatchObject({ status: 'not_reviewed', decisions: [{ segmentId: 's1', status: 'unknown' }] });
    const use = { ...identity, operation: 'record-use', requestId: randomUUID(), sources: input.sources, expectedGeneration: 2, expectedHeadEventId: coverageReceipt.eventId,
      taskRef: 'real-http-consumer-fixture', query: 'What limitation is actually provided?', segmentIds: ['s1'], signal: 'read', reason: 'Read the returned old body after a new revision existed.' };
    expect((await postReview({ ...use, signal: 'observed_help' })).status).toBe(400);
    expect((await postReview(use)).status).toBe(200);
    expect((await status()).usage[0]).toMatchObject({ bodyRef, signal: 'read', actor: { actorKind: 'human', actorId: 'local-user' } });
    expect((await status(newRef)).usage).toEqual([]);
    expect(app.list()[0].choice).toBeNull();
    expect(app.detail(bodyRef.knowledgeId, bodyRef.revisionId).revision).toEqual(fixture.body);
  });

  it('binds an explicit automation review actor at the trusted host and never accepts a browser actor', async () => {
    const selected = join(root, 'agent-review-ledger'), fixture = seedKnowledgeWorkspace(selected, 'agent-review-source');
    const actor = { actorKind: 'agent' as const, actorId: 'actual-browser-acceptance-Agent', executionRef: 'explicit-test-execution' };
    const agentServer = createReportServer({ port: 0, knowledgeReviewActor: actor, observationsDir: join(root, 'agent-observations'),
      analysesDir: join(root, 'agent-analyses'), doctorsDir: join(root, 'agent-doctors'), conversationCatalog: catalog });
    const agentUrl = await agentServer.start();
    const send = (body: object) => fetch(`${agentUrl}/api/knowledge/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const bodyRef = { knowledgeId: fixture.body.knowledgeId, revisionId: fixture.body.revisionId, bodyDigest: fixture.body.bodyDigest };
      const command = { workspace: selected, operation: 'review-content', bodyRef, requestId: randomUUID(), expectedGeneration: 0, expectedHeadEventId: null,
        sources: [{ snapshotId: fixture.source.snapshotId, sourceVersion: fixture.source.sourceVersion }], status: 'reviewed_with_limits',
        reason: 'The explicit Agent inspected only this source-local fixture.', limitations: ['This authored fixture establishes no semantic quality or human Gold.'], findings: [] };
      expect((await send({ ...command, actor: { actorKind: 'human', actorId: 'browser-spoof' } })).status).toBe(400);
      expect((await send(command)).status).toBe(200);
      const result = await (await send({ workspace: selected, operation: 'review-status', bodyRef })).json();
      expect(result.content.events[0].actor).toEqual(actor);
      expect(result.history.events).toHaveLength(1);
    } finally { await agentServer.stop(); }
  });

  it('can recover a lost acknowledgement from the production receipt and treats a corrupt review ledger as unavailable', async () => {
    const selected = join(root, 'review-acknowledgement'), fixture = seedKnowledgeWorkspace(selected, 'review-ack-source');
    const bodyRef = { knowledgeId: fixture.body.knowledgeId, revisionId: fixture.body.revisionId, bodyDigest: fixture.body.bodyDigest };
    const command = { workspace: selected, operation: 'review-content', bodyRef, requestId: randomUUID(), expectedGeneration: 0, expectedHeadEventId: null,
      sources: [{ snapshotId: fixture.source.snapshotId, sourceVersion: fixture.source.sourceVersion }], status: 'reviewed_with_limits',
      reason: 'Only the exact source-local fixture was reviewed.', limitations: ['The source does not establish general effectiveness.'], findings: [] };
    const original = FileKnowledgeReviewStore.prototype.write;
    const lostAcknowledgement = vi.spyOn(FileKnowledgeReviewStore.prototype, 'write').mockImplementation(function (this: FileKnowledgeReviewStore, ...args) {
      original.apply(this, args); throw new Error('Lost acknowledgement token=private /private/review-ledger');
    });
    try {
      const response = await postReview(command); expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'knowledge_request_failed' });
    } finally { lostAcknowledgement.mockRestore(); }
    const request = { workspace: selected, operation: 'review-status', bodyRef };
    const recovered = await (await postReview(request)).json();
    expect(recovered.history.events).toHaveLength(1);
    expect(recovered.history.receipts).toEqual([expect.objectContaining({ requestId: command.requestId, committedGeneration: 1 })]);
    const ledger = join(selected, 'reviews', readdirSync(join(selected, 'reviews'))[0]);
    writeFileSync(ledger, '{corrupt private ledger token=secret');
    const unavailable = await postReview(request); expect(unavailable.status).toBe(200);
    const unreadable = await unavailable.json();
    expect(unreadable).toMatchObject({ storageStatus: 'unavailable', generation: null, headEventId: null, history: null,
      content: { status: 'unavailable' }, coverage: { status: 'unavailable' } });
    expect(JSON.stringify(unreadable)).not.toContain(selected); expect(JSON.stringify(unreadable)).not.toContain('token=secret');
    const body = await post({ workspace: selected, operation: 'show', id: bodyRef.knowledgeId, revision: bodyRef.revisionId });
    expect(body.status).toBe(200); expect((await body.json()).revision).toEqual(fixture.body);
  });

  it('loads only scoped committed knowledge while preserving queue order, tags, missing rows and selected corruption failures', async () => {
    const selected = join(root, 'scoped-queue'), app = createLocalKnowledgeApplication(selected);
    const generate = async (threadId: string, multiple = false) => {
      const snapshot = app.capture({ path: join(root, `${threadId}.jsonl`), origin: { threadId, title: threadId },
        records: [{ recordIndex: 1, raw: message('user', 'Alpha 使用 Beta') }] });
      return app.generate(snapshot.snapshotId, currentModel(multiple));
    };
    const chosen = await generate('chosen-thread', true), other = await generate('other-thread');
    const id = chosen.journal.bodies[0].knowledgeId, detail = app.detail(id);
    app.tag(id, 0, ['候选/待核对']); app.maintain(id, detail.revision.revisionId, 'retain', 'Authored queue fixture', detail.history.generation);
    const ids = new Set(chosen.journal.bodies.map(value => value.knowledgeId)), expected = app.list().filter(row => ids.has(row.knowledgeId));
    const itemPath = (knowledgeId: string) => readdirSync(join(selected, 'items')).map(name => join(selected, 'items', name))
      .find(path => (JSON.parse(readFileSync(path, 'utf8')) as { knowledgeId: string }).knowledgeId === knowledgeId)!;
    const chosenPath = itemPath(id), otherPath = itemPath(other.journal.bodies[0].knowledgeId), chosenBytes = readFileSync(chosenPath);
    writeFileSync(otherPath, '{unrelated corrupt item');
    const queue = () => post({ workspace: selected, operation: 'queue', threadId: 'chosen-thread' });
    const scoped = await queue(); expect(scoped.status).toBe(200);
    const result = await scoped.json(); expect(result.rows).toHaveLength(2); expect(result.rows).toEqual(expected);
    expect(result.rows.find((row: { knowledgeId: string }) => row.knowledgeId === id)).toMatchObject({ choice: 'retain', tags: ['候选/待核对'] });
    expect(result.runs.map((run: { runId: string }) => run.runId)).toEqual([chosen.journal.runId]);
    const sourceRead = vi.spyOn(KnowledgeApplication.prototype, 'source').mockImplementation(() => { throw new Error('Full source reads are forbidden for the queue.'); });
    const inspection = vi.spyOn(KnowledgeApplication.prototype, 'inspect').mockImplementation(() => { throw new Error('Full archive reads are forbidden for the queue.'); });
    try {
      const metadataOnly = await queue(); expect(metadataOnly.status).toBe(200);
      expect((await metadataOnly.json()).runs[0]).toMatchObject({ sources: [expect.objectContaining({ origin: { threadId: 'chosen-thread', title: 'chosen-thread' } })], sourceMetadataStatus: 'frozen_input', archiveVerification: 'not_verified' });
      expect(sourceRead).not.toHaveBeenCalled(); expect(inspection).not.toHaveBeenCalled();
    } finally { sourceRead.mockRestore(); inspection.mockRestore(); }
    expect((await post({ workspace: selected, operation: 'list' })).status).toBe(400); // Unscoped reads remain fail-closed.
    unlinkSync(chosenPath); const missing = await queue(); expect(missing.status).toBe(200); expect((await missing.json()).rows).toEqual(expected.filter(row => row.knowledgeId !== id));
    writeFileSync(chosenPath, chosenBytes); writeFileSync(chosenPath, '{selected corrupt item');
    const corrupt = await queue(); expect(corrupt.status).toBe(400); const diagnostic = await corrupt.text();
    expect(diagnostic).not.toContain(selected); expect(diagnostic).not.toContain('selected corrupt item');
    const journalPath = join(selected, 'generation-journals', `${chosen.journal.runId}.json`), originalJournal = readFileSync(journalPath, 'utf8');
    try {
      writeFileSync(journalPath, JSON.stringify({ ...JSON.parse(originalJournal), sources: [{ ...JSON.parse(originalJournal).sources[0], snapshotId: randomUUID() }] }));
      const unknownScope = await post({ workspace: selected, operation: 'queue', threadId: 'unrelated-thread' }); expect(unknownScope.status).toBe(200);
      const projection = await unknownScope.json(); expect(projection.rows).toEqual([]);
      expect(projection.runs).toContainEqual(expect.objectContaining({ runId: chosen.journal.runId, schemaStatus: 'unavailable', unavailableReason: 'unreadable', bodies: [] }));
    } finally { writeFileSync(journalPath, originalJournal); }
  });

  it('uses the selected local workspace and shared capture operation', async () => {
    expect(await (await post({ operation: 'list' })).json()).toEqual([]);
    const captured = await post({ operation: 'capture', source });
    expect(captured.status).toBe(200);
    const snapshot = await captured.json() as { snapshotId: string };
    expect(snapshot.snapshotId).toBeTruthy();
    expect((await post({ operation: 'delete-source', snapshot: snapshot.snapshotId })).status).toBe(200);
  });
  it('previews catalog messages, captures only the selection, and preserves the return identity', async () => {
    const preview = await (await post({ operation: 'preview-conversation', threadId: 'thread', turnId: 'turn' })).json() as { sourceVersion: string; messages: { text: string }[] };
    expect(preview.messages.map(message => message.text)).toEqual(['选择这条约束', '不要自动带上这条回复']);
    const input = { operation: 'capture-conversation', threadId: 'thread', turnId: 'turn', sourceVersion: preview.sourceVersion, recordIndexes: [10] };
    expect((await post({ ...input, recordIndexes: [999] })).status).toBe(400);
    expect((await post({ ...input, turnId: 'other' })).status).toBe(400);
    const captured = await (await post(input)).json() as { snapshotId: string; excerpts: { text: string }[] };
    expect(captured.excerpts.map(entry => entry.text)).toEqual(['选择这条约束']);
    const stored = createLocalKnowledgeApplication(workspace).source(captured.snapshotId);
    expect(stored.status === 'available' && stored.window.origin).toEqual({ threadId: 'thread', turnId: 'turn', title: '项目对话', cwd: '/project' });
    changed = true;
    expect((await post(input)).status).toBe(409);
    changed = false;
  });
  it('captures the whole conversation across turns, preserving scope and rejecting changed or incomplete sources', async () => {
    whole = true;
    try {
      const preview = await (await post({ operation: 'preview-conversation', threadId: 'thread' })).json();
      expect(preview.messages.map((item: { recordIndex: number }) => item.recordIndex)).toEqual([10, 11, 20]);
      expect(preview.origin).not.toHaveProperty('turnId');
      const input = { operation: 'capture-conversation', threadId: 'thread', sourceVersion: preview.sourceVersion, recordIndexes: [10, 11, 20] };
      const response = await post(input);
      expect(response.status).toBe(200);
      const captured = await response.json();
      expect(captured.excerpts).toHaveLength(3);
      expect(createLocalKnowledgeApplication(workspace).source(captured.snapshotId).status).toBe('available');
      whole = false;
      expect((await post(input)).status).toBe(409);
      incomplete = true;
      expect((await post({ operation: 'preview-conversation', threadId: 'thread' })).status).toBe(400);
    } finally { whole = false; incomplete = false; }
  });
  it('rejects cross-origin mutation before touching a source', async () => {
    const response = await post({ operation: 'capture', source }, 'https://untrusted.example');
    expect(response.status).toBe(403);
  });
  it('does not expose raw filesystem exceptions or accept unrecognized request fields', async () => {
    const invalid = await post({ operation: 'capture', source: join(root, 'private-missing-file') });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(root);
    expect((await post({ operation: 'list', approved: true })).status).toBe(400);
  });
  it('lists archive metadata without native decoding and keeps full inspection fail-closed', async () => {
    const selected = join(root, 'native-summary'); const app = createLocalKnowledgeApplication(selected);
    const source = app.capture({ path: join(root, 'native-summary.jsonl'), records: [{ recordIndex: 1, raw: message('user', 'Alpha 使用 Beta') }] });
    const run = await app.generate(source.snapshotId, currentModel(false, {
      outcomeKind: 'result', result: { ok: false, output: 'private-native-output', error: 'private-native-diagnostic', durationMs: 2,
        failure: { failureKind: 'network' }, trace: { privateDetail: 'private-native-trace' } } }));
    const response = await post({ workspace: selected, operation: 'runs' }); expect(response.status).toBe(200);
    const text = await response.text(), rows = JSON.parse(text);
    expect(rows).toEqual([expect.objectContaining({ runId: run.journal.runId, status: 'failed', phases: [expect.objectContaining({ stageKind: 'body', state: 'failed', outcomeRef: expect.any(Object) })] })]);
    expect(rows[0]).toMatchObject({ archiveVerification: 'not_verified', archiveChecks: [{ archiveStatus: 'present', verificationStatus: 'not_verified' }] });
    for (const privateValue of ['private-native-', 'sourceChannels', 'rawOutput', root]) expect(text).not.toContain(privateValue);
    const inspect = await post({ workspace: selected, operation: 'inspect', id: run.journal.runId }); expect(inspect.status).toBe(200);
    expect(await inspect.json()).toMatchObject({ archiveVerification: 'verified' });
    const archive = join(selected, 'generation-journals', 'outcomes', run.journal.runId, `${run.journal.stages[0].invocationId}.json`);
    const original = readFileSync(archive, 'utf8');
    writeFileSync(archive, original.replace('knowledge-generation-native', 'knowledge-generation-broken'));
    const unverified = await post({ workspace: selected, operation: 'runs' }); expect(unverified.status).toBe(200);
    expect((await unverified.json())[0]).toMatchObject({ archiveVerification: 'not_verified', archiveChecks: [{ archiveStatus: 'present', verificationStatus: 'not_verified' }] });
    expect((await post({ workspace: selected, operation: 'inspect', id: run.journal.runId })).status).toBe(400);
    unlinkSync(archive);
    const missing = await post({ workspace: selected, operation: 'quality' }); expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ archiveChecks: [{ archiveStatus: 'missing', verificationStatus: 'not_verified' }] });
  });
  it.each(['history', 'file'] as const)('returns only the stable code for a known entity %s capacity refusal', async scope => {
    const refusal = new EntityAnalysisWriteCapacityError(scope); refusal.message += ` private-context:${root}`;
    const correction = vi.spyOn(KnowledgeApplication.prototype, 'correctEntities').mockImplementation(() => { throw refusal; });
    try {
      const response = await post({ operation: 'correct-entities', analysisId: randomUUID(), revision: randomUUID(), generation: 1024,
        draft: { entities: [], mentions: [] }, reason: '核对容量诊断' });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'knowledge_capacity_exceeded' });
      expect(correction).toHaveBeenCalledOnce();
    } finally { correction.mockRestore(); }
  });
  it('inspects/corrects independent entities and separately reviews associations then revises body through real HTTP', async () => {
    const entitySource = join(root, 'entity.jsonl');
    writeFileSync(entitySource, [message('user', 'Alpha 使用 Beta'), message('user', '仅在隔离环境中使用 Beta，语义质量尚未验收。'),
      JSON.stringify({ type: 'unknown_event', payload: { privateMetadata: 'private-raw-value' } })].join('\n'));
    const app = createLocalKnowledgeApplication(workspace), snapshot = app.capture({ path: entitySource }), run = await app.generate(snapshot.snapshotId, currentModel());
    const analysisId = run.journal.stages.find(stage => stage.stageKind === 'association')!.entityWrites![0].analysisId, bodyRef = run.journal.bodies[0];
    const inspection = await post({ operation: 'entities', analysisId }); expect(inspection.status).toBe(200);
    const text = await inspection.text(); expect(text).not.toContain(root); expect(text).not.toContain('private-raw-value');
    const before = JSON.parse(text); expect(before.source.excerpts[0].text).toBe('Alpha 使用 Beta');
    const graphResponse = await post({ operation: 'graph', knowledgeIds: [bodyRef.knowledgeId] });
    expect(graphResponse.status).toBe(200); const graphText = await graphResponse.text(), graph = JSON.parse(graphText);
    expect(graphText).not.toContain(root); expect(graphText).not.toContain('private-raw-value'); expect(graphText).not.toContain('sourcePath');
    expect(graph.nodes.filter((node: { nodeKind: string }) => node.nodeKind === 'knowledge')).toHaveLength(1);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ nodeKind: 'knowledge', bodyRef, current: true }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({ nodeKind: 'source', snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ edgeKind: 'segment_entity' }));
    for (const bad of [{ knowledgeIds: Array(1001).fill(bodyRef.knowledgeId) }, { includeHistory: 'yes' }, { unsafe: true }]) {
      expect((await post({ operation: 'graph', ...bad })).status).toBe(400);
    }
    const choices = await (await post({ operation: 'association-catalogs', id: bodyRef.knowledgeId, revision: bodyRef.revisionId })).json();
    expect(choices.bodyRef).toEqual(bodyRef); expect(choices.catalogs).toContainEqual(expect.objectContaining({ analysisId,
      snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion, writeHeadRevisionId: before.revision.revisionId }));
    expect(JSON.stringify(choices)).not.toContain(root); expect(JSON.stringify(choices)).not.toContain('sourcePath');
    const catalog = await (await post({ operation: 'entity-catalog', query: 'Alpha', pageSize: 1 })).json();
    expect(catalog.rows[0]).toMatchObject({ analysisId, mentionCount: 1, knowledgeCount: 1 }); expect(JSON.stringify(catalog)).not.toContain('rawOutput'); expect(JSON.stringify(catalog)).not.toContain(root);
    for (const bad of [{ page: 0 }, { pageSize: 101 }, { analysisId: '../private' }, { unsafe: true }]) expect((await post({ operation: 'entity-catalog', ...bad })).status).toBe(400);
    const entityResponse = await post({ operation: 'entity-detail', analysisId, entityId: before.revision.entities[0].entityId });
    expect(entityResponse.status).toBe(200); const entityText = await entityResponse.text(); expect(entityText).not.toContain(root); expect(entityText).not.toContain('private-raw-value');
    expect(JSON.parse(entityText).knowledge[0].segmentIds).toEqual(['s1']);
    const edit = { entities: before.revision.entities, mentions: before.revision.mentions }; edit.entities[0].label = '项目 Alpha';
    const request = { operation: 'correct-entities', analysisId, revision: before.revision.revisionId, generation: 1, draft: edit, reason: '核对项目名称' };
    expect((await post(request, 'https://untrusted.example')).status).toBe(403);
    const corrected = await (await post(request)).json(); expect(corrected.history.generation).toBe(2);
    const stale = await post(request); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: 'knowledge_conflict' });
    const candidate = await (await post({ operation: 'show', id: bodyRef.knowledgeId })).json(), original = app.detail(bodyRef.knowledgeId);
    expect(candidate.derivedAssociations.revision.catalogRefs[0].entityRevisionId).toBe(before.revision.revisionId);
    const associationDraft = { catalogRefs: [{ analysisId, entityRevisionId: corrected.revision.revisionId }], segmentEntityRefs: [{ segmentId: 's1', analysisId, entityRevisionId: corrected.revision.revisionId, entityId: corrected.revision.entities[0].entityId, mentionIds: [corrected.revision.mentions[0].mentionId] }], typedRelations: [], issues: [] };
    const applyRequest = { operation: 'apply-associations', id: bodyRef.knowledgeId, revision: bodyRef.revisionId, bodyDigest: bodyRef.bodyDigest,
      generation: 1, draft: associationDraft, reason: '正文不改，只修订独立关联' };
    const invalid = await post({ ...applyRequest, draft: { ...associationDraft, segmentEntityRefs: [{ ...associationDraft.segmentEntityRefs[0], mentionIds: [randomUUID()] }] } });
    expect(invalid.status).toBe(400); expect((await invalid.text())).not.toContain(root); expect(app.detail(bodyRef.knowledgeId)).toEqual(original);
    const applied = await post(applyRequest); expect(applied.status).toBe(200); const projection = await applied.json();
    expect(projection.history.revisions).toHaveLength(1); expect(projection.revision).toEqual(original.revision); expect(projection.derivedAssociations.reviewStatus).toBe('pending');
    const reviewed = await post({ operation: 'review-associations', id: bodyRef.knowledgeId, revision: projection.derivedAssociations.revision.revisionId, generation: 2, choice: 'accept', reason: '明确核对新关联' });
    expect(reviewed.status).toBe(200); expect((await reviewed.json()).derivedAssociations.reviewStatus).toBe('accepted');
    const reopenedGraph = await (await post({ operation: 'graph', knowledgeIds: [bodyRef.knowledgeId], includeHistory: true })).json();
    expect(reopenedGraph.edges).toContainEqual(expect.objectContaining({ edgeKind: 'segment_entity', projectionRevisionId: projection.derivedAssociations.revision.revisionId, reviewStatus: 'accepted' }));
    expect(createLocalKnowledgeApplication(workspace).detail(bodyRef.knowledgeId).revision).toEqual(original.revision);
    const conditions = before.source.excerpts[1], draft = { title: candidate.revision.title, content: structuredClone(candidate.revision.content), reuseRationale: candidate.revision.reuseRationale };
    draft.content.segments[0].text += ` ${conditions.text}`;
    draft.content.segments[0].evidence.push({ source: { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }, basis: 'source_assertion',
      selection: { evidenceRef: conditions.evidenceRef, quote: conditions.text, start: 0, end: conditions.text.length } });
    const revisedRequest = { operation: 'revise', id: bodyRef.knowledgeId, revision: bodyRef.revisionId, generation: 1, draft, reason: '正文保留后文条件与直接引文' };
    const malformed = structuredClone(revisedRequest); malformed.draft.content.segments[0].evidence[0].selection.quote = 'not-in-source';
    const refused = await post(malformed); expect(refused.status).toBe(400); expect(await refused.text()).not.toContain(root);
    const revised = await post(revisedRequest); expect(revised.status).toBe(200); const latest = await revised.json();
    expect(latest.revision.content.segments[0].evidence).toEqual(draft.content.segments[0].evidence); expect(latest.derivedAssociations.status).toBe('stale');
    expect(app.detail(bodyRef.knowledgeId, bodyRef.revisionId).revision).toEqual(original.revision);
    expect(await (await post({ operation: 'quality' })).json()).toEqual(app.quality());
    const runPath = join(workspace, 'generation-journals', `${run.journal.runId}.json`), saved = readFileSync(runPath);
    try {
      writeFileSync(runPath, '{bad private content');
      const quality = await post({ operation: 'quality' }); expect(quality.status).toBe(200);
      const inventory = await quality.json(); expect(inventory.unavailable).toEqual([{ runId: run.journal.runId, reason: 'unreadable', detail: 'Generation journal is invalid or unreadable.' }]);
      expect(JSON.stringify(inventory)).not.toContain('bad private content');
      const runs = await post({ operation: 'runs' }); expect(runs.status).toBe(200);
      expect(await runs.json()).toContainEqual(expect.objectContaining({ runId: run.journal.runId, schemaStatus: 'unavailable', status: 'unavailable', nextAction: 'unavailable' }));
      const queue = await post({ operation: 'queue', threadId: 'cannot-attribute-this-run' }); expect(queue.status).toBe(200);
      expect((await queue.json()).runs).toContainEqual(expect.objectContaining({ runId: run.journal.runId, schemaStatus: 'unavailable' }));
    }
    finally { writeFileSync(runPath, saved); }
    const summaries = await (await post({ operation: 'runs' })).json(); expect(JSON.stringify(summaries)).not.toContain('rawOutput');
    expect(summaries.find((entry: { runId: string }) => entry.runId === run.journal.runId).entityAnalyses[0].entityCount).toBe(2);
    await post({ operation: 'delete-source', snapshot: snapshot.snapshotId }); const deleted = await post({ ...request, revision: corrected.revision.revisionId, generation: 2 });
    expect(deleted.status).toBe(400); expect(await deleted.text()).not.toContain(root);
  });
  it('organizes exact entity revisions through the real library API and retains history without exposing source paths', async () => {
    const selected = join(root, 'library-workspace'); const app = createLocalKnowledgeApplication(selected);
    const seeded = seedKnowledgeWorkspace(selected, 'library-source'), entity = seeded.analysis;
    const member = { ...seeded.ref(), entityRevisionId: entity.revision.revisionId, mentionIds: [entity.revision.mentions[0].mentionId], rationale: '按来源确认项目身份' };
    const projection = app.detail(seeded.body.knowledgeId).derivedAssociations;
    app.reviewAssociations(seeded.body.knowledgeId, projection.revision!.revisionId, projection.generation, 'accept', '独立核对派生关联');
    const libraryPost = (body: object, origin?: string) => fetch(`${url}/api/knowledge/library`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ workspace: selected, ...body }) });
    const command = { operation: 'save', objectId: randomUUID(), requestId: randomUUID(), generation: 0, headRevisionId: null,
      draft: { label: 'Alpha', description: '维护的项目对象', referentKind: 'object', members: [member] }, reason: '建立入口', identityConfirmed: true };
    expect((await libraryPost(command, 'https://untrusted.example')).status).toBe(403);
    expect(existsSync(join(selected, 'library'))).toBe(false);
    const response = await libraryPost(command); expect(response.status).toBe(200); const saved = await response.json();
    expect((await libraryPost(command)).status).toBe(200);
    const detail = await libraryPost({ operation: 'show', id: saved.objectId }); const text = await detail.text();
    expect(text).not.toContain(root); expect(text).not.toContain('rawOutput');
    expect(JSON.parse(text).counts).toEqual({ retained: 0, pending: 1, discarded: 0, needsReview: 0 });
    expect((await (await libraryPost({ operation: 'owners', analysisId: member.analysisId, entityId: member.entityId })).json())[0].objectId).toBe(saved.objectId);
    expect((await libraryPost({ ...command, objectId: randomUUID(), requestId: randomUUID() })).status).toBe(409);
    for (const bad of [{ operation: 'show', id: '../private' }, { operation: 'list', unsafe: true }, { ...command, identityConfirmed: false }]) {
      const failed = await libraryPost(bad); expect(failed.status).toBe(400); expect(await failed.text()).not.toContain(root);
    }
    const removed = await libraryPost({ ...command, requestId: randomUUID(), generation: saved.generation, headRevisionId: saved.writeHeadRevisionId,
      draft: { ...command.draft, members: [] }, reason: '明确解除关联' }); expect(removed.status).toBe(200);
    expect((await (await libraryPost({ operation: 'show', id: saved.objectId })).json()).knowledge).toEqual([]);
    expect((await (await libraryPost({ operation: 'show', id: saved.objectId, revision: saved.writeHeadRevisionId })).json()).knowledge).toHaveLength(1);
    expect(app.detail(seeded.body.knowledgeId).history.revisions).toHaveLength(1);
  });
  it('reports workspace contention consistently for source, tag and carrier writes, then recovers after release', async () => {
    const selected = join(root, 'busy-workspace'); const app = createLocalKnowledgeApplication(selected);
    const fixture = join(root, 'busy-source.jsonl'); writeFileSync(fixture, message('user', 'Alpha 使用 Beta'));
    const seeded = seedKnowledgeWorkspace(selected, 'busy-source'), snapshot = seeded.source;
    const current = app.detail(seeded.body.knowledgeId);
    app.maintain(current.revision.knowledgeId, current.revision.revisionId, 'retain', '已核对', current.history.generation);
    const draft = executeArtifactAuthoring({ operation: 'preview', workspace: selected, source: { sourceKind: 'new' }, artifactKind: 'prompt', name: '当前知识', ids: [current.revision.knowledgeId] }, 'zh');
    const lock = join(selected, WORKSPACE_LOCK_FILE); const owner = JSON.stringify({ owner: randomUUID(), pid: process.pid, hostname: (await import('node:os')).hostname(), acquiredAt: new Date().toISOString() });
    writeFileSync(lock, owner); const clock = vi.spyOn(Date, 'now'); let tick = 0; clock.mockImplementation(() => tick += 6000);
    try {
      for (const fields of [{ operation: 'capture', source: fixture }, { operation: 'delete-source', snapshot: snapshot.snapshotId },
        { operation: 'tag', id: current.revision.knowledgeId, generation: 0, tags: ['tag'] }]) {
        const response = await post({ workspace: selected, ...fields }); expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: 'knowledge_workspace_busy' });
      }
      const fields = draft as import('../../../src/studio/view-models/knowledge/artifact-authoring.js').ReviewedCarrierDraft;
      const response = await fetch(`${url}/api/knowledge/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'save', workspace: selected, artifactId: fields.artifactId, source: fields.source, artifactKind: fields.artifactKind, name: fields.name,
          directoryName: fields.directoryName, baselineRevisionId: fields.baselineRevisionId, baselineHash: fields.baselineHash, content: fields.content, selectedRefs: fields.selectedRefs, tagSelections: fields.tagSelections }) });
      expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'knowledge_workspace_busy' });
      expect(readFileSync(lock, 'utf8')).toBe(owner); expect(app.source(snapshot.snapshotId).status).toBe('available');
      expect(app.detail(current.revision.knowledgeId).tagging).toEqual({ generation: 0, tags: [] });
      expect(existsSync(join(selected, 'artifacts'))).toBe(false);
    } finally { clock.mockRestore(); unlinkSync(lock); }
    expect((await post({ workspace: selected, operation: 'tag', id: current.revision.knowledgeId, generation: 0, tags: ['tag'] })).status).toBe(200);
  });
  it('rejects unsupported storage and removed operations without altering files or exposing data', async () => {
    const selected = join(root, 'unsupported'); const folder = join(selected, 'extraction-runs'); mkdirSync(folder, { recursive: true });
    const path = join(folder, `${randomUUID()}.json`);
    const original = JSON.stringify({ schemaVersion: 0, privateValue: 'private-sensitive-value' }); writeFileSync(path, original);
    const required = await post({ workspace: selected, operation: 'runs' }); expect(required.status).toBe(200);
    expect(await required.json()).toMatchObject([{ schemaStatus: 'unsupported', status: 'unsupported', bodies: [], phases: [] }]);
    const resume = await post({ workspace: selected, operation: 'resume', id: path.slice(path.lastIndexOf('/') + 1, -5) });
    expect(resume.status).toBe(409); expect(await resume.json()).toEqual({ error: 'knowledge_storage_unsupported' });
    const backup = join(root, 'external-backup');
    for (const operation of ['migration-preview', 'migrate']) {
      const response = await post({ workspace: selected, operation, backupDirectory: backup });
      expect(response.status).toBe(400);
      const body = await response.text(); expect(body).not.toContain(root); expect(body).not.toContain('private-sensitive-value');
    }
    expect(existsSync(backup)).toBe(false); expect(readFileSync(path, 'utf8')).toBe(original);
  });
  it('protects carrier measurement mutations and redacts invalid input without model execution', async () => {
    const send = (body: string, origin?: string) => fetch(`${url}/api/knowledge/measurements`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body });
    expect((await send(JSON.stringify({ operation: 'start', workspace, id: 'invalid' }), 'https://untrusted.example')).status).toBe(403);
    expect((await send('invalid')).status).toBe(400);
    const invalid = await send(JSON.stringify({ operation: 'preview', input: { workspace, secret: 'private-value' } }));
    expect(invalid.status).toBe(400);
    const body = await invalid.text(); expect(body).not.toContain(root); expect(body).not.toContain('private-value');
    expect((await send(JSON.stringify({ operation: 'list', workspace, artifactId: 'invalid', version: 1, unknown: true }))).status).toBe(400);
  });
  it('routes artifact authoring through the same trusted Studio boundary with redacted errors', async () => {
    const send = (body: string, origin?: string) => fetch(`${url}/api/knowledge/artifacts`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body });
    expect(await (await send(JSON.stringify({ operation: 'list', workspace }))).json()).toEqual([]);
    expect((await send(JSON.stringify({ operation: 'list', workspace }), 'https://untrusted.example')).status).toBe(403);
    expect((await send('invalid')).status).toBe(400);
    const invalid = await send(JSON.stringify({ operation: 'show', workspace, id: 'private-invalid' }));
    expect(await invalid.text()).not.toContain(root);
    expect((await send(JSON.stringify({ operation: 'list', workspace, unknown: true }))).status).toBe(400);
    expect((await send(JSON.stringify({ workspace, content: 'x'.repeat(3 * 1024 * 1024) }))).status).toBe(413);
  });

});
