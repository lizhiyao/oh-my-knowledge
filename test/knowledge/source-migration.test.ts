import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applySourceMigration, prepareSourceMigration, SOURCE_MIGRATION_IN_PROGRESS, SOURCE_MIGRATION_STATE_FILE, SOURCE_MIGRATION_PLAN_MAX_BYTES,
  SourceMigrationError, type SourceMigrationInput } from '../../src/knowledge/adapters/source-migration.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileKnowledgeTags } from '../../src/knowledge/adapters/knowledge-tags.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import type { KnowledgeRevision } from '../../src/knowledge/contracts.js';
import type { EntityAnalysisEnvelope } from '../../src/knowledge/entities/contracts.js';
import { EvidenceWindowSchema, type EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { runCommand } from '../helpers/run-command.js';
import { createLocalKnowledgeApplication, createLocalKnowledgeReview } from '../../src/knowledge/application/local.js';
import { traceSnapshotFixture } from '../helpers/knowledge-source.js';
import { sourceSnapshotProjection } from '../../src/knowledge/sources.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const actor = { actorKind: 'human' as const, actorId: 'fixture-migrator' }, oldActor = { actorKind: 'human' as const, actorId: 'original-author' };
const oldAt = '2026-10-20T00:00:00.000Z', at = '2026-10-30T00:00:00.000Z';
function put(root: string, path: string, bytes: string | Uint8Array) { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); return target; }
function fingerprint(root: string) {
  const files: { path: string; digest: string }[] = [];
  const walk = (directory: string) => { for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name); if (lstatSync(path).isDirectory()) walk(path); else files.push({ path: relative(root, path), digest: sha(readFileSync(path)) });
  } }; walk(root); return files;
}
/** Authored healthy storage, including human edits and approvals; no model, measurement or actual rollback evidence. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-source-migration-')); roots.push(root);
  const sourceRoot = join(root, 'old'), targetRoot = join(root, 'new'); mkdirSync(sourceRoot);
  const text = '甲😀 Alpha 使用 Beta\r\n末尾', snapshotId = randomUUID(), records = [
    { recordIndex: 2, raw: '  {"message":"legacy 😀"}  \r\n' }, { recordIndex: 7, raw: '{"message":"no final newline"}' }];
  const source: EvidenceWindow = EvidenceWindowSchema.parse({ snapshotId, sourceVersion: sha(JSON.stringify(records)), sourceKind: 'codex', sourcePath: '/unavailable-original-trace.jsonl',
    projectionVersion: 'knowledge-window-v2', capturedAt: oldAt, startRecord: 2, endRecord: 7, records,
    origin: { threadId: 'original-thread', turnId: 'original-turn', title: '原始标题', cwd: '/original/host/path' }, limitations: ['Original source limitation.'],
    excerpts: [{ evidenceRef: `${snapshotId}:3`, recordIndex: 2, eventKind: 'message', role: 'user', timestamp: oldAt, text },
      { evidenceRef: `${snapshotId}:8`, recordIndex: 7, eventKind: 'message', role: 'assistant', timestamp: oldAt, text: 'tail 😀' }] });
  const sourcePath = put(sourceRoot, `sources/${snapshotId}.json`, JSON.stringify({ ...source, windowDigest: sha(JSON.stringify(source, null, 2)) }, null, 1) + '\n');
  const sourceRef = { snapshotId, sourceVersion: source.sourceVersion }, knowledgeId = randomUUID();
  const draft = { title: '原始标题', reuseRationale: '原始条件与适用范围', content: { segments: [{ segmentId: 's1', text: '初稿，后续人已修改。', evidence: [
    { source: sourceRef, selection: { evidenceRef: source.excerpts[0].evidenceRef, quote: text, start: 0, end: text.length }, basis: 'source_assertion' as const }] }] } };
  const first: KnowledgeRevision = { ...draft, knowledgeId, revisionId: randomUUID(), bodyDigest: knowledgeBodyDigest(draft), observationRefs: ['original-observation'], derivations: [],
    createdAt: oldAt, revisedAt: oldAt, createdBy: oldActor, revisedBy: oldActor, revisionReason: 'Original draft.' };
  const knowledge = new FileKnowledgeStore(join(sourceRoot, 'items'), 'local', sourceRoot);
  knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null, revision: first }, oldActor);
  const currentDraft = { ...draft, title: '人改过的标题', content: { segments: [{ ...draft.content.segments[0], text: '用户修改后的完整条件：应保留否定、例外、不同立场和未知。😀' }] } };
  const current: KnowledgeRevision = { ...first, ...currentDraft, bodyDigest: knowledgeBodyDigest(currentDraft), revisionId: randomUUID(), parentRevision: { knowledgeId, revisionId: first.revisionId },
    revisedAt: '2026-10-21T00:00:00.000Z', revisionReason: 'User content revision, not a generated summary.' };
  knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: 1, expectedHeadRevisionId: first.revisionId, revision: current }, oldActor);
  knowledge.write({ commandKind: 'record_maintenance', requestId: randomUUID(), knowledgeId, expectedGeneration: 2,
    maintenance: { revisionId: current.revisionId, choice: 'retain', actor: oldActor, at, reason: 'Original retain decision.' } }, oldActor);
  const entities = new FileEntityAnalysisStore(join(sourceRoot, 'entities'), sourceRoot), analysisId = randomUUID(), entityIds = [randomUUID(), randomUUID()], mentionIds = [randomUUID(), randomUUID()];
  const catalog = { entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: entityIds[index], label, description: `Original ${label}`, qualifiers: [], identityStatus: 'proposed' as const,
    possibleEntityIds: [], uncertainties: [], referentKind: index ? 'instance' as const : 'component' as const,
    componentRef: index ? { entityId: entityIds[0], mentionIds: [mentionIds[1]], rationale: 'Authored structural component fixture.' } : null, collection: null })),
  mentions: ['Alpha', 'Beta'].map((quote, index) => ({ mentionId: mentionIds[index], entityId: entityIds[index], selection: { evidenceRef: source.excerpts[0].evidenceRef, quote,
    start: text.indexOf(quote), end: text.indexOf(quote) + quote.length }, basis: 'explicit' as const, rationale: 'Authored exact mention.' })), limitations: ['Original catalog limitation.'] };
  const entityRevisionIds = [randomUUID(), randomUUID()];
  for (let index = 0; index < 2; index++) entities.write({ ...sourceRef, analysisId, requestId: randomUUID(), expectedGeneration: index, expectedHeadRevisionId: index ? entityRevisionIds[0] : null,
    revision: { ...catalog, revisionId: entityRevisionIds[index], ...(index ? { parentRevisionId: entityRevisionIds[0] } : {}),
      revisedAt: oldAt, revisedBy: oldActor, revisionReason: `Original catalog ${index}.` } }, oldActor);
  const associations = new FileKnowledgeAssociationStore(join(sourceRoot, 'associations'), 'local', knowledge, entities, sourceRoot);
  let generation = 0, head: string | undefined;
  for (const body of [first, current]) {
    const revisionId = randomUUID(); associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: generation++, expectedHeadRevisionId: head ?? null,
      revision: { revisionId, ...(head ? { parentRevisionId: head } : {}), bodyRef: knowledgeBodyRef(body), status: 'available', reviewStatus: 'pending',
        catalogRefs: [{ analysisId, entityRevisionId: entityRevisionIds[0] }], segmentEntityRefs: entityIds.map((entityId, index) => ({ segmentId: 's1', analysisId, entityRevisionId: entityRevisionIds[0], entityId, mentionIds: [mentionIds[index]] })),
        typedRelations: [{ relationId: 'r1', segmentIds: ['s1'], subject: { analysisId, entityRevisionId: entityRevisionIds[0], entityId: entityIds[0] }, relation: 'uses',
          object: { analysisId, entityRevisionId: entityRevisionIds[0], entityId: entityIds[1] }, modality: 'descriptive', polarity: 'positive', evidence: body.content.segments[0].evidence, issues: [] }],
        issues: [], revisedAt: oldAt, revisedBy: oldActor, revisionReason: 'Original derived projection.' } }, oldActor);
    associations.write({ commandKind: 'record_review', requestId: randomUUID(), knowledgeId, expectedGeneration: generation++, review: { projectionRevisionId: revisionId, choice: 'accept', actor: oldActor, at, reason: 'Original human acceptance.' } }, oldActor); head = revisionId;
  }
  new FileKnowledgeTags(join(sourceRoot, 'tags'), 'local', sourceRoot).write(knowledgeId, 0, ['architecture'], oldActor);
  for (const path of ['generation-journals/native/raw.bin', 'reviews/old.json', 'library/old.json', 'artifacts/old.json', 'auto-extraction/grant.json', 'entity-links/confirmation.json']) put(sourceRoot, path, path.endsWith('.bin') ? Buffer.from([0, 255, 13, 10]) : '{"historicalApproval":true,"neverEnableInNewWorkspace":true}\n');
  mkdirSync(join(sourceRoot, 'empty'));
  const matchingBuildArchivePath = put(root, 'matching-old-build.tgz', Buffer.from([31, 139, 0, 255, 10]));
  const input: SourceMigrationInput = { sourceRoot, targetRoot, namespace: 'local', migrationId: randomUUID(), actor, at, matchingBuildArchivePath, matchingBuildId: 'authored-fixture-not-an-installable-runtime' };
  return { root, sourceRoot, targetRoot, input, source, sourcePath, current, knowledge, analysisId, entityRevisionIds, entityIds, mentionIds, associations };
}
/** Direct authored histories keep capacity fixtures bounded without thousands of durable writes. The real store validates every history on read. */
function replaceWithEmptyCatalogs(f: ReturnType<typeof fixture>, count: number, revisionCount: number, perFileBytes?: number) {
  rmSync(join(f.sourceRoot, 'entities'), { recursive: true }); rmSync(join(f.sourceRoot, 'associations'), { recursive: true });
  let bytes = 0;
  for (let index = 0; index < count; index++) {
    const analysisId = randomUUID(), revisionIds = Array.from({ length: revisionCount }, () => randomUUID());
    const history: EntityAnalysisEnvelope = { storeKind: 'entity-analysis-history', schemaVersion: 2, analysisId, snapshotId: f.source.snapshotId, sourceVersion: f.source.sourceVersion,
      generation: revisionCount, writeHeadRevisionId: revisionIds.at(-1)!,
      revisions: revisionIds.map((revisionId, ordinal) => ({ revisionId, ...(ordinal ? { parentRevisionId: revisionIds[ordinal - 1] } : {}),
        entities: [], mentions: [], limitations: perFileBytes ? Array.from({ length: 64 }, () => 'p'.repeat(4096)) : [], revisedAt: oldAt, revisedBy: oldActor, revisionReason: 'Original catalog.' })),
      receipts: revisionIds.map((revisionId, ordinal) => ({ requestId: randomUUID(), commandDigest: sha('authored original command'), committedGeneration: ordinal + 1, revisionId })) };
    let encoded = JSON.stringify(history, null, 2);
    if (perFileBytes) {
      const limitations = history.revisions.at(-1)!.limitations;
      while (Buffer.byteLength(encoded) > perFileBytes) {
        const excess = Buffer.byteLength(encoded) - perFileBytes, last = limitations.at(-1)!;
        if (last.length > excess) limitations[limitations.length - 1] = last.slice(0, -excess); else limitations.pop();
        encoded = JSON.stringify(history, null, 2);
      }
    }
    bytes += Buffer.byteLength(encoded); put(f.sourceRoot, `entities/${analysisId}.json`, encoded);
  }
  return bytes;
}
function additionalLargeSources(f: ReturnType<typeof fixture>, count: number, textBytes: number) {
  for (let index = 0; index < count; index++) {
    const text = 'x'.repeat(textBytes), snapshotId = randomUUID(), records = [{ recordIndex: 0,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) }];
    const source = EvidenceWindowSchema.parse({ snapshotId, sourceVersion: sha(JSON.stringify(records)), sourceKind: 'codex', sourcePath: `/unavailable/large-${index}.jsonl`,
      projectionVersion: 'knowledge-window-v2', capturedAt: oldAt, startRecord: 0, endRecord: 0, records,
      excerpts: [{ evidenceRef: `${snapshotId}:0`, recordIndex: 0, eventKind: 'message', role: 'user', text }], limitations: [] });
    const encoded = JSON.stringify({ ...source, windowDigest: sha(JSON.stringify(source, null, 2)) }, null, 2);
    expect(Buffer.byteLength(encoded)).toBeLessThan(16 * 1024 * 1024);
    put(f.sourceRoot, `sources/${snapshotId}.json`, encoded);
  }
}

describe('explicit Source2 to Source3 independent-copy migration', () => {
  it('preflights without writes, preserves original bytes and user content, and creates fresh pending exact-reference histories', () => {
    const f = fixture(), original = fingerprint(f.sourceRoot), plan = prepareSourceMigration(f.input);
    expect(plan.limitations.some(text => text.includes('without durable migration ownership'))).toBe(true);
    expect(plan.limitations.some(text => text.includes('sourcePath, origin.cwd and capture timestamps remain in the original archive only'))).toBe(true);
    expect(existsSync(f.targetRoot)).toBe(false); expect(prepareSourceMigration(f.input)).toEqual(plan); expect(fingerprint(f.sourceRoot)).toEqual(original);
    const result = applySourceMigration(plan, plan.planDigest); expect(result).toMatchObject({ state: 'complete', pending: true });
    expect(result.sources[0].current).not.toEqual(result.sources[0].old);
    const sources = new FileSourceStore(join(f.targetRoot, 'sources'), f.targetRoot), captured = sources.read(result.sources[0].current.snapshotId);
    expect(captured.status).toBe('available'); if (captured.status !== 'available') throw new Error('Expected migrated source.');
    expect(captured.snapshot.rawUnits.map(unit => unit.text)).toEqual(f.source.records.map(record => record.raw));
    expect(captured.snapshot.excerpts.map(excerpt => excerpt.text)).toEqual(f.source.excerpts.map(excerpt => excerpt.text));
    expect(captured.snapshot.sourceKind === 'agent_trace' ? captured.snapshot.origin : undefined)
      .toEqual({ threadId: f.source.origin!.threadId, turnId: f.source.origin!.turnId, title: f.source.origin!.title });
    expect(captured.snapshot.excerpts[0].coordinate).toMatchObject({ recordIndex: 2, role: 'user', timestamp: oldAt });
    expect(captured.snapshot.limitations.some(text => text.includes('terminators'))).toBe(true);
    expect(new FileSourceStore(join(f.sourceRoot, 'sources'), f.sourceRoot).read(f.source.snapshotId)).toMatchObject({ status: 'unavailable', reason: 'unsupported' });
    const knowledge = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot), body = knowledge.read(f.current.knowledgeId);
    expect(body.revisions).toHaveLength(1); expect(body.maintenance).toEqual([]);
    expect(body.revisions[0].title).toBe(f.current.title); expect(body.revisions[0].content.segments[0].text).toBe(f.current.content.segments[0].text);
    expect(body.revisions[0].bodyDigest).not.toBe(f.current.bodyDigest); expect(body.revisions[0].revisionId).toBe(plan.bodies[0].revisionId);
    const evidence = body.revisions[0].content.segments[0].evidence[0]; expect(evidence.source).toEqual(result.sources[0].current);
    expect(captured.snapshot.excerpts[0].text.slice(evidence.selection.start, evidence.selection.end)).toBe(evidence.selection.quote);
    const entityStore = new FileEntityAnalysisStore(join(f.targetRoot, 'entities'), f.targetRoot), catalog = entityStore.read(plan.catalogs[0].analysisId);
    expect(catalog.revisions).toHaveLength(2); expect(catalog.analysisId).not.toBe(f.analysisId); expect(catalog.snapshotId).toBe(captured.snapshot.snapshotId);
    expect(catalog.revisions[0].entities[1].componentRef).toMatchObject({ entityId: catalog.revisions[0].entities[0].entityId, mentionIds: [catalog.revisions[0].mentions[1].mentionId] });
    expect(catalog.revisions[0].mentions[1].entityId).toBe(catalog.revisions[0].entities[1].entityId);
    expect(catalog.revisions[0].mentions[1].mentionId).not.toBe(f.mentionIds[1]);
    const associations = new FileKnowledgeAssociationStore(join(f.targetRoot, 'associations'), 'local', knowledge, entityStore, f.targetRoot).read(f.current.knowledgeId);
    expect(associations.reviews).toEqual([]); expect(associations.revisions).toHaveLength(1);
    expect(associations.revisions[0]).toMatchObject({ reviewStatus: 'pending', bodyRef: knowledgeBodyRef(body.revisions[0]), catalogRefs: [{ analysisId: catalog.analysisId, entityRevisionId: catalog.revisions[0].revisionId }] });
    expect(associations.revisions[0].typedRelations![0].evidence[0]).toEqual(evidence);
    expect(new FileKnowledgeTags(join(f.targetRoot, 'tags'), 'local', f.targetRoot).read(f.current.knowledgeId).tags).toEqual(['architecture']);
    for (const file of plan.inventory) {
      const archived = join(plan.archiveRoot, 'original', file.path), originalPath = join(f.sourceRoot, file.path);
      expect(readFileSync(archived)).toEqual(readFileSync(originalPath)); expect(lstatSync(archived).ino).not.toBe(lstatSync(originalPath).ino);
    }
    expect(existsSync(join(plan.archiveRoot, 'original', 'empty'))).toBe(true);
    expect(readFileSync(join(plan.archiveRoot, 'matching-build', 'matching-old-build.tgz'))).toEqual(readFileSync(f.input.matchingBuildArchivePath));
    for (const directory of ['reviews', 'library', 'artifacts', 'auto-extraction', 'generation-journals', 'entity-links']) expect(existsSync(join(f.targetRoot, directory))).toBe(false);
    const final = fingerprint(f.targetRoot); expect(applySourceMigration(plan, plan.planDigest)).toEqual(result); expect(fingerprint(f.targetRoot)).toEqual(final); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it.each(['source', 'body', 'entity', 'association', 'abort'] as const)('resumes only the same plan after %s publication interruption', stage => {
    const f = fixture(), plan = prepareSourceMigration(f.input), original = fingerprint(f.sourceRoot);
    const controller = new AbortController();
    if (stage === 'source') {
      const original = FileSourceStore.prototype.captureBatch;
      vi.spyOn(FileSourceStore.prototype, 'captureBatch').mockImplementationOnce(function (this: FileSourceStore, input, options) { original.call(this, input, options); throw new Error('authored acknowledgement loss'); });
    } else if (stage === 'body' || stage === 'abort') {
      const original = FileKnowledgeStore.prototype.write;
      vi.spyOn(FileKnowledgeStore.prototype, 'write').mockImplementationOnce(function (this: FileKnowledgeStore, command, actor) {
        const receipt = original.call(this, command, actor);
        if (stage === 'abort') { controller.abort(new Error('authored cancellation')); return receipt; }
        throw new Error('authored acknowledgement loss');
      });
    } else if (stage === 'entity') {
      const original = FileEntityAnalysisStore.prototype.write;
      vi.spyOn(FileEntityAnalysisStore.prototype, 'write').mockImplementationOnce(function (this: FileEntityAnalysisStore, command, actor) { original.call(this, command, actor); throw new Error('authored acknowledgement loss'); });
    } else {
      const original = FileKnowledgeAssociationStore.prototype.write;
      vi.spyOn(FileKnowledgeAssociationStore.prototype, 'write').mockImplementationOnce(function (this: FileKnowledgeAssociationStore, command, actor) { original.call(this, command, actor); throw new Error('authored acknowledgement loss'); });
    }
    expect(() => applySourceMigration(plan, plan.planDigest, { signal: controller.signal })).toThrow(stage === 'abort' ? 'authored cancellation' : 'acknowledgement loss'); vi.restoreAllMocks();
    expect(JSON.parse(readFileSync(join(f.targetRoot, SOURCE_MIGRATION_STATE_FILE), 'utf8')).state).toBe(SOURCE_MIGRATION_IN_PROGRESS);
    const sourceFiles = readdirSync(join(f.targetRoot, 'sources')); expect(sourceFiles).toHaveLength(1);
    expect(prepareSourceMigration(f.input)).toEqual(plan);
    const completed = applySourceMigration(plan, plan.planDigest); expect(completed.sources[0].current.snapshotId).toBe(sourceFiles[0].slice(0, -5));
    expect(fingerprint(f.sourceRoot)).toEqual(original);
    const knowledge = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot).read(f.current.knowledgeId); expect(knowledge.generation).toBe(1);
  });

  it('preserves unrelated dead-owner user locks and refuses user edits after an interrupted prefix', () => {
    const f = fixture(), plan = prepareSourceMigration(f.input);
    vi.spyOn(FileEntityAnalysisStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('stop before catalog'); });
    expect(() => applySourceMigration(plan, plan.planDigest)).toThrow('stop before catalog'); vi.restoreAllMocks();
    const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { cwd: f.root, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 5000, stdio: 'pipe' });
    expect(exited.status).toBe(0); expect(exited.error).toBeUndefined();
    const lockBytes = JSON.stringify({ owner: randomUUID(), pid: exited.pid, hostname: hostname(), acquiredAt: at });
    const userLock = put(f.targetRoot, 'unrelated-user.lock', lockBytes);
    expect(() => applySourceMigration(plan, plan.planDigest)).toThrow('locked writes'); expect(readFileSync(userLock, 'utf8')).toBe(lockBytes); rmSync(userLock);
    const store = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot), existing = store.read(f.current.knowledgeId), old = existing.revisions[0];
    const draft = { title: 'New target user edit', content: old.content, reuseRationale: old.reuseRationale };
    expect(() => store.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: old.knowledgeId, expectedGeneration: 1, expectedHeadRevisionId: old.revisionId,
      revision: { ...old, ...draft, revisionId: randomUUID(), bodyDigest: knowledgeBodyDigest(draft), parentRevision: { knowledgeId: old.knowledgeId, revisionId: old.revisionId }, revisionReason: 'User edit after migration interruption.' } }, actor)).toThrow('knowledge_storage_unsupported');
    // Out-of-band byte edits still invalidate recovery; the normal API no longer permits them.
    const path = join(f.targetRoot, 'items', readdirSync(join(f.targetRoot, 'items'))[0]); writeFileSync(path, readFileSync(path, 'utf8') + '\n');
    const before = fingerprint(f.targetRoot); expect(() => applySourceMigration(plan, plan.planDigest)).toThrow('user changes'); expect(fingerprint(f.targetRoot)).toEqual(before);
  });

  it('blocks stale application, review and direct-store writers after interruption and resumes the unchanged same plan', () => {
    const f = fixture(), trace = put(f.root, 'session.jsonl', JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Unrelated later source' }] } }));
    const app = createLocalKnowledgeApplication(f.targetRoot, { sourceScope: { scopeVersion: 'knowledge-source-scope/v1', projects: [],
      traces: [{ sourceId: 'fixture:later', traceKind: 'codex', path: trace }] } });
    const review = createLocalKnowledgeReview(f.targetRoot, actor), sourceStore = new FileSourceStore(join(f.targetRoot, 'sources'), f.targetRoot);
    const preview = app.previewSources([{ sourceKind: 'agent_trace', sourceId: 'fixture:later', traceKind: 'codex', recordRanges: [{ startRecord: 0, endRecord: 0 }] }]);
    const plan = prepareSourceMigration(f.input);
    vi.spyOn(FileEntityAnalysisStore.prototype, 'write').mockImplementationOnce(() => { throw new Error('interrupted before catalog'); });
    expect(() => applySourceMigration(plan, plan.planDigest)).toThrow('interrupted before catalog'); vi.restoreAllMocks();
    const before = fingerprint(f.targetRoot), body = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot).read(f.current.knowledgeId).revisions[0];
    const model = { executor: 'authored', model: 'fixture', timeoutMs: 300000, inspect: vi.fn(), invoke: vi.fn() };
    expect(() => app.captureSources(preview)).toThrow('knowledge_storage_unsupported');
    expect(() => app.prepareGeneration([body.content.segments[0].evidence[0].source], model)).toThrow('knowledge_storage_unsupported');
    expect(() => review.reviewContent({ requestId: randomUUID(), bodyRef: knowledgeBodyRef(body), sources: body.content.segments[0].evidence.map(value => value.source),
      expectedGeneration: 0, expectedHeadEventId: null, status: 'needs_revision', reason: 'Must not create a ledger during migration.', limitations: [],
      findings: [{ problemKind: 'omission', description: 'Authored refusal fixture.', segmentIds: [] }] })).toThrow('knowledge_storage_unsupported');
    expect(() => sourceStore.capture(sourceSnapshotProjection(traceSnapshotFixture('Unrelated captured material')))).toThrow(/migration.*incomplete/i);
    expect(model.inspect).not.toHaveBeenCalled(); expect(model.invoke).not.toHaveBeenCalled(); expect(fingerprint(f.targetRoot)).toEqual(before);
    expect(prepareSourceMigration(f.input)).toEqual(plan); expect(applySourceMigration(plan, plan.planDigest).state).toBe('complete');
    expect(createLocalKnowledgeApplication(f.targetRoot).detail(body.knowledgeId).revision).toEqual(body);
  });

  it('never recreates a deleted completed snapshot or retargets the old reference', () => {
    const f = fixture(), plan = prepareSourceMigration(f.input), result = applySourceMigration(plan, plan.planDigest);
    const sourcePath = join(f.targetRoot, 'sources', `${result.sources[0].current.snapshotId}.json`); rmSync(sourcePath);
    const before = fingerprint(f.targetRoot); expect(() => applySourceMigration(plan, plan.planDigest)).toThrow(); expect(existsSync(sourcePath)).toBe(false); expect(fingerprint(f.targetRoot)).toEqual(before);
  });

  it('rejects source/target aliases, ancestors, symlinks and unrelated destination data in read-only preflight', () => {
    const f = fixture(), original = fingerprint(f.sourceRoot);
    for (const targetRoot of [f.sourceRoot, join(f.sourceRoot, 'nested'), f.root]) expect(() => prepareSourceMigration({ ...f.input, targetRoot })).toThrow('separate');
    const alias = join(f.root, 'alias'); symlinkSync(f.sourceRoot, alias); expect(() => prepareSourceMigration({ ...f.input, sourceRoot: alias })).toThrow('ordinary directories');
    const buildAlias = join(f.root, 'build-alias.tgz'); symlinkSync(f.input.matchingBuildArchivePath, buildAlias);
    expect(() => prepareSourceMigration({ ...f.input, matchingBuildArchivePath: buildAlias })).toThrow('symbolic');
    const nested = join(f.root, 'missing', 'deep', 'copy'); expect(prepareSourceMigration({ ...f.input, targetRoot: nested }).targetRoot).toMatch(/missing\/deep\/copy$/u);
    expect(existsSync(join(f.root, 'missing'))).toBe(false);
    symlinkSync(f.sourcePath, join(f.sourceRoot, 'link')); expect(() => prepareSourceMigration(f.input)).toThrow('symbolic'); rmSync(join(f.sourceRoot, 'link'));
    put(f.targetRoot, 'user-data.txt', 'do not overwrite'); expect(() => prepareSourceMigration(f.input)).toThrow('unrelated');
    expect(readFileSync(join(f.targetRoot, 'user-data.txt'), 'utf8')).toBe('do not overwrite'); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it.each(['missing', 'deleted', 'corrupt', 'unsupported', 'oversized'] as const)('refuses a required %s Source2 window without repairing or writing either workspace', state => {
    const f = fixture();
    if (state === 'missing') rmSync(f.sourcePath);
    else if (state === 'deleted') writeFileSync(f.sourcePath, JSON.stringify({ snapshotId: f.source.snapshotId, deleted: true }));
    else if (state === 'oversized') truncateSync(f.sourcePath, 16 * 1024 * 1024 + 257);
    else { const raw = JSON.parse(readFileSync(f.sourcePath, 'utf8')); if (state === 'corrupt') raw.records[0].raw = 'changed'; else raw.projectionVersion = 'knowledge-window-v1'; writeFileSync(f.sourcePath, JSON.stringify(raw)); }
    const original = fingerprint(f.sourceRoot); expect(() => prepareSourceMigration(f.input)).toThrow(SourceMigrationError); expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('refuses migration growth beyond the readable aggregate entity capacity while the original directory is healthy', () => {
    const f = fixture(), bytes = replaceWithEmptyCatalogs(f, 64, 4, 1024 * 1024 - 16), input = { ...f.input, actor: { ...actor, actorId: 'm'.repeat(256) } };
    expect(bytes).toBeLessThanOrEqual(64 * 1024 * 1024); expect(bytes).toBeGreaterThan(64 * 1024 * 1024 - 4096);
    const original = fingerprint(f.sourceRoot), listed = new FileEntityAnalysisStore(join(f.sourceRoot, 'entities'), f.sourceRoot).list();
    expect(listed.unavailable).toBe(0); expect(listed.histories).toHaveLength(64);
    expect(() => prepareSourceMigration(input)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded', message: 'Migrated entity catalog storage exceeds capacity.' }));
    expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('refuses a healthy multi-revision catalog plan whose complete receipt would exceed the step bound before target creation', () => {
    const f = fixture(); replaceWithEmptyCatalogs(f, 48, 1024);
    const original = fingerprint(f.sourceRoot), listed = new FileEntityAnalysisStore(join(f.sourceRoot, 'entities'), f.sourceRoot).list();
    expect(listed.unavailable).toBe(0); expect(listed.histories.reduce((count, history) => count + history.revisions.length, 0)).toBe(49_152);
    expect(() => prepareSourceMigration(f.input)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded', message: 'Migration receipt step count exceeds capacity.' }));
    expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('refuses an otherwise bounded long-path inventory whose actual final receipt bytes exceed capacity', () => {
    const f = fixture(), directory = ['a'.repeat(200), 'b'.repeat(200), 'c'.repeat(200)].join('/');
    for (let index = 0; index < 10_000; index++) put(f.sourceRoot, `${directory}/${'d'.repeat(180)}${index.toString().padStart(5, '0')}`, '');
    const original = fingerprint(f.sourceRoot);
    expect(() => prepareSourceMigration(f.input)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded', message: 'Migration receipt bytes exceed capacity.' }));
    expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('round-trips a real multi-source CLI migration plan larger than 16 MiB through the fixed plan reader', async () => {
    const f = fixture(); additionalLargeSources(f, 3, 3 * 1024 * 1024);
    const original = fingerprint(f.sourceRoot), output = await runCommand(ObserveKnowledge, ['migrate-sources', '--from-workspace', f.sourceRoot, '--workspace', f.targetRoot,
      '--operation-id', f.input.migrationId, '--matching-build', f.input.matchingBuildArchivePath, '--matching-build-id', f.input.matchingBuildId, '--plan-only', '--json'], { cwd: f.root });
    expect(Buffer.byteLength(output.stdout)).toBeGreaterThan(16 * 1024 * 1024); expect(Buffer.byteLength(output.stdout)).toBeLessThan(SOURCE_MIGRATION_PLAN_MAX_BYTES);
    const plan = JSON.parse(output.stdout), path = put(f.root, 'large-plan.json', output.stdout);
    expect(existsSync(f.targetRoot)).toBe(false);
    const result = JSON.parse((await runCommand(ObserveKnowledge, ['migrate-sources', '--input', path, '--confirm-plan', plan.planDigest, '--json'], { cwd: f.root })).stdout);
    expect(result).toMatchObject({ state: 'complete', pending: true, modelCalls: 0 }); expect(result.sources).toHaveLength(4);
    expect(fingerprint(f.sourceRoot)).toEqual(original); expect(sha(readFileSync(join(plan.archiveRoot, 'plan.json')))).toBe(sha(JSON.stringify(plan, null, 2)));
  });

  it('refuses oversized migration plans consistently before either adapter or CLI creates the target', async () => {
    const small = fixture(), plan = prepareSourceMigration(small.input);
    const shell = { ...plan, limitations: [''] }, padding = SOURCE_MIGRATION_PLAN_MAX_BYTES - Buffer.byteLength(JSON.stringify(shell, null, 2));
    const atJsonBoundary = { ...shell, limitations: ['p'.repeat(padding)] };
    expect(Buffer.byteLength(JSON.stringify(atJsonBoundary, null, 2)) + 1).toBe(SOURCE_MIGRATION_PLAN_MAX_BYTES + 1); // CLI adds one LF.
    expect(() => applySourceMigration(atJsonBoundary, plan.planDigest))
      .toThrowError(expect.objectContaining({ code: 'capacity_exceeded', message: 'Migration plan exceeds the 128 MiB capacity.' }));
    const path = put(small.root, 'over-plan.json', '{}'); truncateSync(path, SOURCE_MIGRATION_PLAN_MAX_BYTES + 1);
    await expect(runCommand(ObserveKnowledge, ['migrate-sources', '--input', path, '--confirm-plan', plan.planDigest, '--json'], { cwd: small.root })).rejects.toMatchObject({ code: 1 });
    expect(existsSync(small.targetRoot)).toBe(false);
    const f = fixture(); additionalLargeSources(f, 9, 15 * 1024 * 1024 / 2);
    const original = fingerprint(f.sourceRoot);
    expect(() => prepareSourceMigration(f.input)).toThrowError(expect.objectContaining({ code: 'capacity_exceeded', message: 'Migration plan exceeds the 128 MiB capacity.' }));
    expect(existsSync(f.targetRoot)).toBe(false); expect(fingerprint(f.sourceRoot)).toEqual(original);
  });

  it('rejects forged deterministic mappings, source/build drift and invalid quote offsets before target writes', () => {
    const f = fixture(), plan = prepareSourceMigration(f.input), forged = structuredClone(plan); forged.bodies[0].revisionId = randomUUID();
    const cancelled = new AbortController(); cancelled.abort(new Error('cancel before migration'));
    expect(() => applySourceMigration(plan, plan.planDigest, { signal: cancelled.signal })).toThrow('cancel before migration'); expect(existsSync(f.targetRoot)).toBe(false);
    const payload: Partial<typeof forged> = { ...forged }; delete payload.planDigest; forged.planDigest = sha(canonicalJson(payload));
    expect(() => applySourceMigration(forged, forged.planDigest)).toThrow('mapping changed'); expect(existsSync(f.targetRoot)).toBe(false);
    const drift = put(f.sourceRoot, 'external-change.txt', 'source changed after preflight');
    expect(() => applySourceMigration(plan, plan.planDigest)).toThrow('mapping changed'); expect(existsSync(f.targetRoot)).toBe(false); rmSync(drift);
    writeFileSync(f.input.matchingBuildArchivePath, 'changed archive'); expect(() => applySourceMigration(plan, plan.planDigest)).toThrow(); expect(existsSync(f.targetRoot)).toBe(false);
    const current = f.knowledge.read(f.current.knowledgeId), revision = structuredClone(current.revisions.at(-1)!); revision.content.segments[0].evidence[0].selection.start++;
    revision.content.segments[0].evidence[0].selection.end++; revision.revisionId = randomUUID(); revision.parentRevision = { knowledgeId: current.knowledgeId, revisionId: current.writeHeadRevisionId };
    revision.bodyDigest = knowledgeBodyDigest(revision);
    f.knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: current.knowledgeId, expectedGeneration: current.generation, expectedHeadRevisionId: current.writeHeadRevisionId, revision }, oldActor);
    expect(() => prepareSourceMigration(f.input)).toThrow('UTF-16'); expect(existsSync(f.targetRoot)).toBe(false);
  });
});
