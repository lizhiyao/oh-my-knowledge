import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalEntityLinks, createLocalKnowledgeApplication, createLocalKnowledgeLibrary } from '../../../src/observability/application.js';
import { createOpenAiArchiveProducer } from '../../../src/executors/openai/archive.js';
import type { ExecutorInput } from '../../../src/executors/contracts/ports.js';
import type { ExecResult } from '../../../src/executors/contracts/result.js';
import { createReportServer } from '../../../src/studio/http/report-server.js';
import { createEntityLinkStudioService } from '../../../src/studio/application/knowledge/entity-links.js';
import type { EntityLinkStudioInspection, EntityLinkStudioPreview } from '../../../src/studio/view-models/knowledge/entity-links.js';
import { modelWindow } from '../../knowledge/fixtures.js';

let root: string, workspace: string, server: ReturnType<typeof createReportServer> | undefined, url: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omk-studio-links-')); workspace = join(root, 'selected'); });
afterEach(async () => { await server?.stop(); server = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
async function source(name: string) {
  const app = createLocalKnowledgeApplication(workspace);
  const snapshot = app.capture({ path: join(root, `${name}.jsonl`), origin: { threadId: name, title: name }, records: [{ recordIndex: 1,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
  const run = await app.generate(snapshot.snapshotId, { executor: 'fixture', model: 'no-model-call', generate: async (_system, input) => ({ output: JSON.stringify(modelWindow()).replaceAll('record-1', JSON.parse(input).excerpts[0].evidenceRef), durationMs: 0 }) });
  const analysis = app.entities(run.runId);
  return { analysisId: run.runId, entityId: analysis.revision.entities[0].entityId };
}
function result(input: ExecutorInput): ExecResult {
  const pair = JSON.parse(input.prompt);
  return { ok: true, output: JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1, leftEntityId: pair.left.binding.entityId,
    rightEntityId: pair.right.binding.entityId, assessment: 'same_object', leftMentionIds: pair.left.binding.mentionIds, rightMentionIds: pair.right.binding.mentionIds,
    rationale: '模型建议，等待独立人工核对 <script>test</script>' }), durationMs: 1, durationApiMs: 0, inputTokens: 7, outputTokens: 3,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUSD: 0, costReportedByExecutor: false, stopReason: 'stop', numTurns: 1 };
}
async function serve(execute: (input: ExecutorInput) => Promise<ExecResult> = async input => result(input)) {
  const calls = vi.fn(execute), factory = vi.fn(() => calls);
  const producer = createOpenAiArchiveProducer({ OPENAI_BASE_URL: 'https://fixture.invalid', OPENAI_API_KEY: 'test-private-key' }, factory);
  server = createReportServer({ port: 0, entityLinkProducer: producer, observationsDir: join(root, 'observations'), analysesDir: join(root, 'analyses'), doctorsDir: join(root, 'doctors') });
  url = await server.start(); return { producer, calls, factory };
}
const post = (body: object, overrides: object = {}, origin?: string) => fetch(`${url}/api/knowledge/entity-links`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify({ workspace, ...body, ...overrides }) });
async function json<T>(body: object, overrides?: object): Promise<T> { const response = await post(body, overrides); expect(response.status).toBe(200); return response.json() as Promise<T>; }
async function preview() { const a = await source('left'), b = await source('right'); return json<EntityLinkStudioPreview>({ operation: 'preview', left: a, right: b, selection: { executor: 'openai-api', model: 'explicit-fixture-model' } }); }
const propose = (value: EntityLinkStudioPreview) => ({ operation: 'propose', previewToken: value.previewToken, contentConfirmed: true });

describe('Studio entity-link production service boundary', () => {
  it('previews locally, binds workspace and complete server-owned preview, and dispatches once after exact consent', async () => {
    const { calls, factory } = await serve(); const value = await preview();
    expect(factory).not.toHaveBeenCalled(); expect(calls).not.toHaveBeenCalled(); expect(existsSync(join(workspace, 'entity-links'))).toBe(false);
    expect(value.preview.producerContext.proof).toMatchObject({ endpoint: 'https://fixture.invalid/v1/chat/completions' });
    expect((await post(propose(value), {}, 'https://untrusted.invalid')).status).toBe(403);
    expect((await post(propose(value), { contentConfirmed: false })).status).toBe(400);
    const other = join(root, 'unconfirmed');
    expect((await post(propose(value), { workspace: other })).status).toBe(409); expect(existsSync(other)).toBe(false);
    expect((await post(propose(value), { plan: value.preview.plan })).status).toBe(400);
    const [one, two] = await Promise.all([json<EntityLinkStudioInspection>(propose(value)), json<EntityLinkStudioInspection>(propose(value))]);
    expect(one.projection.status).toBe('awaiting_review'); expect(['awaiting_review', 'running']).toContain(two.projection.status); expect(calls).toHaveBeenCalledTimes(1);
    const show = await json<EntityLinkStudioInspection>({ operation: 'show', reviewId: value.preview.reviewId });
    expect(show.history).toEqual(one.history); expect(show.projection.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, costUSD: null });
    await json({ operation: 'list' }); await json({ operation: 'resume', reviewId: value.preview.reviewId });
    const quality = await json<ReturnType<ReturnType<typeof createLocalEntityLinks>['quality']>>({ operation: 'quality' });
    expect(quality).toMatchObject({ projectionVersion: 'omk.entity-link-quality/v2', readStatus: 'available', reviewCount: 1 });
    expect(quality.groups[0]).toMatchObject({ reviews: { dispatched: 1 }, admission: { admitted: 1 }, humanDecisions: { decided: 0, undecidedAdmitted: 1 } });
    expect(calls).toHaveBeenCalledTimes(1);
    const rejected = await json<EntityLinkStudioInspection>({ operation: 'reject', reviewId: value.preview.reviewId, requestId: randomUUID(), expectedGeneration: show.history.generation, reason: '真人不采纳此建议' });
    expect(rejected.projection.status).toBe('rejected'); expect(rejected.projection.decision?.actor.actorKind).toBe('human');
    const candidates = await json<{ rows: unknown[] }>({ operation: 'candidates', selected: { analysisId: value.preview.plan.left.analysisId, entityId: value.preview.plan.left.entityId } });
    expect(candidates.rows).toEqual([]); expect(calls).toHaveBeenCalledTimes(1);
  });
  it('accepts only a separate explicit human confirmation and applies the existing library receipt without rewriting entity UUIDs', async () => {
    const { calls } = await serve(); const value = await preview(); const saved = await json<EntityLinkStudioInspection>(propose(value));
    const command = { operation: 'accept', reviewId: value.preview.reviewId, requestId: randomUUID(), expectedGeneration: saved.history.generation, reason: '独立核对两侧原文', identityConfirmed: true };
    expect((await post(command, { identityConfirmed: false })).status).toBe(400);
    const accepted = await json<EntityLinkStudioInspection>(command); expect(accepted.projection.status).toBe('applied');
    expect(createLocalKnowledgeLibrary(workspace).catalog().rows).toHaveLength(1);
    const library = createLocalKnowledgeLibrary(workspace).catalog().rows[0]; expect(createLocalKnowledgeLibrary(workspace).detail(library.objectId).revision.draft.members.map(member => member.entityId).sort()).toEqual([value.preview.plan.left.entityId, value.preview.plan.right.entityId].sort());
    const app = createLocalKnowledgeApplication(workspace); expect(app.entities(value.preview.plan.left.analysisId).revision.entities[0].entityId).toBe(value.preview.plan.left.entityId);
    await json({ operation: 'resume', reviewId: value.preview.reviewId }); expect(calls).toHaveBeenCalledTimes(1);
  });
  it('archives complete paid failures before admission, distinguishes unreadable history, and never retries on read/resume', async () => {
    const { calls } = await serve(async input => ({ ...result(input), ok: false, output: '完整失败原文 <script>', refusal: '完整拒绝', error: 'bounded fixture', failure: { failureKind: 'refusal' }, tokenUsageReportedByExecutor: true }));
    const value = await preview(), saved = await json<EntityLinkStudioInspection>(propose(value));
    expect(saved.projection.status).toBe('execution_failed'); expect(JSON.stringify(saved.history)).toContain('完整失败原文'); expect(JSON.stringify(saved.history)).toContain('完整拒绝');
    writeFileSync(join(workspace, 'entity-links', `${randomUUID()}.json`), '{broken');
    const unreadable = await post({ operation: 'list' }); expect(unreadable.status).toBe(503); expect(await unreadable.json()).toEqual({ error: 'entity_link_outcome_unconfirmed' });
    const quality = await post({ operation: 'quality' }); expect(quality.status).toBe(200);
    expect(await quality.json()).toEqual({ projectionKind: 'entity-link-quality', projectionVersion: 'omk.entity-link-quality/v2', readStatus: 'unreadable', reviewCount: null, groups: [] });
    await json({ operation: 'show', reviewId: value.preview.reviewId }); expect(calls).toHaveBeenCalledTimes(1);
  });
  it('projects a CLI-terminated invocation and its late archive without exposing a terminate HTTP mutation or admitting it', async () => {
    let arrived!: () => void, release!: () => void;
    const arrival = new Promise<void>(resolve => { arrived = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    const { producer, calls } = await serve(async input => { arrived(); await hold; return result(input); });
    const value = await preview(), pending = json<EntityLinkStudioInspection>(propose(value));
    try {
      await arrival;
      const app = createLocalEntityLinks(workspace, producer), running = app.inspect(value.preview.reviewId), execution = running.projection.execution!;
      app.terminateExecution({ reviewId: running.history.reviewId, requestId: randomUUID(), expectedGeneration: running.history.generation,
        executionId: execution.executionId, ownerId: execution.owner.ownerId, reason: 'CLI人工终止，保留原结果' });
      const saved = await json<EntityLinkStudioInspection>({ operation: 'show', reviewId: running.history.reviewId });
      expect(saved.projection).toMatchObject({ projectionVersion: 'omk.entity-link-invocation-projection/v2', status: 'execution_terminated', admission: null, decision: null,
        termination: { terminationVersion: 'omk.entity-link-termination/v1', reason: 'CLI人工终止，保留原结果' }, invocationBudget: { consumed: 1 } });
      expect(saved.startToken).toBeUndefined();
      await json({ operation: 'resume', reviewId: running.history.reviewId });
      const observation = await json<ReturnType<typeof app.quality>>({ operation: 'quality' });
      expect(observation).toMatchObject({ projectionVersion: 'omk.entity-link-quality/v2', readStatus: 'available' });
      if (observation.readStatus !== 'available') throw new Error('Expected readable fixture observations.');
      expect(observation.groups[0]).toMatchObject({ humanTerminations: { total: 1, outcomeUnrecorded: 1, lateOutcomeRecorded: 0 },
        admission: { recorded: 0, terminatedDispatched: 1, unrecordedDispatched: 0 }, humanDecisions: { decided: 0 } });
      expect((await post({ operation: 'terminate', reviewId: running.history.reviewId })).status).toBe(400);
      release(); const late = await pending;
      expect(late.projection).toMatchObject({ status: 'execution_terminated', admission: null, decision: null, usage: { inputTokens: 7, outputTokens: 3 } });
      const listed = await json<EntityLinkStudioInspection['projection'][]>({ operation: 'list' }); expect(listed[0].status).toBe('execution_terminated');
      const after = await json<ReturnType<typeof app.quality>>({ operation: 'quality' });
      if (after.readStatus !== 'available') throw new Error('Expected readable fixture observations.');
      expect(after.groups[0]).toMatchObject({ humanTerminations: { total: 1, outcomeUnrecorded: 0, lateOutcomeRecorded: 1 }, admission: { recorded: 0, terminatedDispatched: 1 }, humanDecisions: { decided: 0 } });
      const next = await json<EntityLinkStudioPreview>({ operation: 'preview', left: { analysisId: value.preview.plan.left.analysisId, entityId: value.preview.plan.left.entityId },
        right: { analysisId: value.preview.plan.right.analysisId, entityId: value.preview.plan.right.entityId },
        selection: { executor: 'openai-api', model: 'explicit-fixture-model' }, retryOf: value.preview.reviewId });
      expect(next.preview.plan.retryOf).toBe(value.preview.reviewId); expect(next.preview.reviewId).not.toBe(value.preview.reviewId);
      expect(calls).toHaveBeenCalledTimes(1); expect(createLocalKnowledgeLibrary(workspace).catalog().rows).toHaveLength(0);
    } finally { release(); await pending; }
  });
  it('retains a raw result in the same service application after archive IO failure and restores it without dispatch', async () => {
    let bad = '';
    const { calls } = await serve(async input => { bad = join(workspace, 'entity-links', `${randomUUID()}.json`); writeFileSync(bad, '{broken'); return result(input); });
    const value = await preview(), response = await post(propose(value)); expect(response.status).toBe(503);
    const running = await json<EntityLinkStudioInspection>({ operation: 'show', reviewId: value.preview.reviewId }); expect(running.projection.status).toBe('running');
    expect((await post({ operation: 'recover-unknown', reviewId: value.preview.reviewId, requestId: randomUUID() })).status).toBe(503);
    rmSync(bad); const resumed = await json<EntityLinkStudioInspection>({ operation: 'resume', reviewId: value.preview.reviewId });
    expect(resumed.projection.status).toBe('awaiting_review'); expect(calls).toHaveBeenCalledTimes(1);
  });
  it('shows durable prepared content, binds continuation to workspace, and cancels before dispatch', async () => {
    const { producer, calls } = await serve(); const value = await preview(), app = createLocalEntityLinks(workspace, producer);
    app.prepare({ ...value.preview, confirmDigest: value.preview.plan.confirmedDigest });
    const saved = await json<EntityLinkStudioInspection>({ operation: 'show', reviewId: value.preview.reviewId }); expect(saved.startToken).toBeTruthy();
    expect((await post({ operation: 'continue', reviewId: value.preview.reviewId, startToken: saved.startToken, contentConfirmed: true }, { workspace: join(root, 'other') })).status).toBe(409);
    const cancelled = await json<EntityLinkStudioInspection>({ operation: 'cancel', reviewId: value.preview.reviewId, expectedGeneration: saved.history.generation, requestId: randomUUID(), reason: '尚未发送，停止预约' });
    expect(cancelled.projection.status).toBe('cancelled_before_start'); expect(calls).not.toHaveBeenCalled();
    expect((await post({ operation: 'continue', reviewId: value.preview.reviewId, startToken: saved.startToken, contentConfirmed: true })).status).toBe(409);
  });
  it('supports explicit continuation, records exceptions as unknown, and refuses unsupported Codex before invocation', async () => {
    const { producer, calls } = await serve(async () => { throw { get privateValue() { throw new Error('must not access'); } }; });
    const value = await preview(), app = createLocalEntityLinks(workspace, producer); app.prepare({ ...value.preview, confirmDigest: value.preview.plan.confirmedDigest });
    const original = await json<EntityLinkStudioInspection>(propose(value)); expect(original.projection.status).toBe('prepared');
    const replay = await json<EntityLinkStudioInspection>(propose(value)); expect(replay.projection.status).toBe('prepared'); expect(calls).not.toHaveBeenCalled();
    const saved = await json<EntityLinkStudioInspection>({ operation: 'show', reviewId: value.preview.reviewId });
    const unknown = await json<EntityLinkStudioInspection>({ operation: 'continue', reviewId: value.preview.reviewId, startToken: saved.startToken, contentConfirmed: true });
    expect(unknown.projection.status).toBe('execution_unknown'); expect(unknown.projection.usage.inputTokens).toBeNull();
    await json({ operation: 'resume', reviewId: value.preview.reviewId }); expect(calls).toHaveBeenCalledTimes(1);
    const otherLeft = await source('third'), otherRight = await source('fourth');
    expect((await post({ operation: 'preview', left: otherLeft, right: otherRight, selection: { executor: 'codex', model: 'no-proof' } })).status).toBe(503); expect(calls).toHaveBeenCalledTimes(1);
  });
  it('bounds and expires server authorizations, discards previews explicitly, and never silently evicts application instances', async () => {
    const { producer, calls } = await serve(), value = await preview();
    await json({ operation: 'discard-preview', previewToken: value.previewToken }); expect((await post(propose(value))).status).toBe(409);
    const a = value.preview.plan.left, b = value.preview.plan.right;
    const expired = await json<EntityLinkStudioPreview>({ operation: 'preview', left: { analysisId: a.analysisId, entityId: a.entityId }, right: { analysisId: b.analysisId, entityId: b.entityId }, selection: { executor: 'openai-api', model: 'fixture' } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    expect((await post(propose(expired))).status).toBe(409); clock.mockRestore();
    const service = createEntityLinkStudioService(producer);
    for (let n = 0; n < 32; n++) await service.execute({ operation: 'list', workspace: join(root, `workspace-${n}`) });
    await expect(service.execute({ operation: 'list', workspace: join(root, 'workspace-overflow') })).rejects.toThrow('session capacity');
    expect(calls).not.toHaveBeenCalled();
    const bounded = createEntityLinkStudioService(producer);
    const request = { operation: 'preview', workspace, left: { analysisId: a.analysisId, entityId: a.entityId }, right: { analysisId: b.analysisId, entityId: b.entityId }, selection: { executor: 'openai-api', model: 'fixture' } };
    let first: EntityLinkStudioPreview | undefined;
    for (let n = 0; n < 224; n++) { const next = await bounded.execute(request) as EntityLinkStudioPreview; first ??= next; }
    await expect(bounded.execute(request)).rejects.toThrow('preview capacity');
    await bounded.execute({ operation: 'discard-preview', workspace, previewToken: first!.previewToken });
    await expect(bounded.execute(request)).resolves.toHaveProperty('previewToken'); expect(calls).not.toHaveBeenCalled();
  });
  it('propagates HTTP cancellation while preserving a late native result and a readable stable review', async () => {
    let reached!: () => void, finished!: () => void;
    const arrival = new Promise<void>(resolve => { reached = resolve; }), archived = new Promise<void>(resolve => { finished = resolve; });
    const { calls } = await serve(async input => { reached(); await new Promise<void>(resolve => input.abortSignal?.addEventListener('abort', () => resolve(), { once: true })); finished(); return result(input); });
    const value = await preview(), controller = new AbortController();
    const pending = fetch(`${url}/api/knowledge/entity-links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace, ...propose(value) }), signal: controller.signal }).catch(error => error);
    await arrival; controller.abort(); await pending; await archived;
    // The executor promise resolves immediately before archive; yield to that same task.
    await new Promise<void>(resolve => setImmediate(resolve));
    const saved = await json<EntityLinkStudioInspection>({ operation: 'show', reviewId: value.preview.reviewId }); expect(saved.projection.status).toBe('awaiting_review'); expect(calls).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(workspace, 'entity-links', `${value.preview.reviewId}.json`), 'utf8')).toContain('execution_recorded');
  });
});
