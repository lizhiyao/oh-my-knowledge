import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '../../src/knowledge/store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { applyKnowledgeMigration, inspectLegacyKnowledgeWorkspace, prepareKnowledgeMigration } from '../../src/knowledge/adapters/knowledge-migration.js';
import { parseLegacyKnowledgeEnvelope } from '../../src/knowledge/migration/legacy-v2.js';
import { bodyActor as actor, bodyAt as at } from './body-fixtures.js';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-v2-migrate-')); roots.push(root);
  const sourceRoot = join(root, 'legacy'), targetRoot = join(root, 'body'); mkdirSync(join(sourceRoot, 'items'), { recursive: true });
  const unknown = { timeKind: 'unknown', reason: '来源没有说明' }, knowledgeId = 'old-item';
  const draft = { title: '来源的旧命题', entities: [{ entityId: 'entity', label: 'Alpha', description: '来源提及的对象' }], content: {
    statements: [{ statementId: 'statement', subject: { entityId: 'entity' }, relation: '在测试条件下可采用', modality: 'capability', polarity: 'negative',
      context: { scenario: '选定记录', conditions: ['只有选定环境'], exceptions: [], unknowns: ['没有独立验证'], occurredDuring: unknown, validDuring: unknown } }],
    organization: { knowledgeKind: 'fact' } }, evidence: [{ evidenceLinkId: 'link', evidenceRef: 'e1', statementIds: ['statement'], relation: 'opposes', basis: 'source_assertion', interpretation: '来源报告；不证明真实能力' }] };
  const revision = { ...draft, knowledgeId, revisionId: 'old-r1', observationRefs: ['original-observation'], derivations: [], createdAt: at, createdBy: actor, revisedAt: at, revisedBy: actor, revisionReason: '旧提取' };
  const grounding = { revisionId: 'old-r1', mentions: [{ mentionId: 'm1', entityId: 'entity', selection: { evidenceRef: 'e1', start: 0, end: 5, quote: 'Alpha' }, basis: 'explicit', rationale: '来源提及' }],
    citations: [{ evidenceLinkId: 'link', selection: { evidenceRef: 'e1', start: 0, end: 5, quote: 'Alpha' } }],
    sourceBindings: [{ snapshotId: randomUUID(), sourceVersion: hash('source'), evidenceRefs: ['e1'] }], reuseRationale: '以后核对相同条件', identityUncertainties: ['旧身份尚未确认'] };
  const envelope = { storeKind: 'knowledge-item-history', schemaVersion: 2, namespace: 'local', knowledgeId, generation: 3, writeHeadRevisionId: 'old-r2',
    revisions: [revision, { ...revision, revisionId: 'old-r2', parentRevision: { knowledgeId, revisionId: 'old-r1' }, revisionReason: '旧补充' }],
    grounding: [grounding, { ...grounding, revisionId: 'old-r2' }],
    maintenance: [{ revisionId: 'old-r1', choice: 'retain', actor, at, reason: '旧维护决定' }],
    receipts: [{ requestId: 'old-create', commandDigest: 'old1', committedGeneration: 1, revisionId: 'old-r1' },
      { requestId: 'old-retain', commandDigest: 'old2', committedGeneration: 2, revisionId: 'old-r1' },
      { requestId: 'old-edit', commandDigest: 'old3', committedGeneration: 3, revisionId: 'old-r2' }] };
  const filename = `${hash(canonicalJson(['local', knowledgeId])).slice(7)}.json`, itemPath = join(sourceRoot, 'items', filename);
  const original = `${JSON.stringify(envelope, null, 1)}\n`; writeFileSync(itemPath, original);
  mkdirSync(join(sourceRoot, 'library')); writeFileSync(join(sourceRoot, 'library', 'exact-old-ref.json'), '{"knowledgeId":"old-item","revisionId":"old-r1"}');
  mkdirSync(join(sourceRoot, 'native')); const native = Buffer.from([0, 255, 13, 10, 65]); writeFileSync(join(sourceRoot, 'native', 'original.bin'), native);
  return { sourceRoot, targetRoot, itemPath, original, native, envelope };
}
function prepare(f: ReturnType<typeof fixture>) {
  return prepareKnowledgeMigration({ sourceRoot: f.sourceRoot, targetRoot: f.targetRoot, namespace: 'local', actor, at, migrationId: randomUUID() });
}
describe('explicit legacy v2 to separate body workspace migration', () => {
  it('prepares without writes, preserves every original byte/history/reference, and publishes only pending mechanical bodies', () => {
    const f = fixture(); expect(inspectLegacyKnowledgeWorkspace(f.sourceRoot).unsupported).toEqual([]);
    expect(() => new FileKnowledgeStore(join(f.sourceRoot, 'items'), 'local', f.sourceRoot).list()).toThrow('knowledge_storage_unsupported');
    const plan = prepare(f); expect(existsSync(f.targetRoot)).toBe(false); expect(readFileSync(f.itemPath, 'utf8')).toBe(f.original);
    expect(applyKnowledgeMigration(plan, plan.planDigest)).toEqual({ planDigest: plan.planDigest, migratedRevisions: 2, pending: true });
    const store = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot), entry = store.list()[0];
    expect(entry.schemaVersion).toBe(3); expect(entry.maintenance).toEqual([]); expect(entry.knowledgeId).not.toBe('old-item');
    expect(entry.revisions[0].content.segments[0].text).toContain('negative');
    expect(entry.revisions[0].content.segments[0].text).toContain('只有选定环境');
    for (const segment of entry.revisions[0].content.segments) expect(segment.text).toContain('旧身份尚未确认');
    expect(entry.revisions[0].content.segments[0].evidence[0]).toMatchObject({ basis: 'source_assertion', interpretation: expect.stringContaining('opposes') });
    const archive = join(f.targetRoot, 'migration', plan.migrationId, 'original');
    expect(Buffer.from(readFileSync(join(archive, 'native', 'original.bin.base64'), 'utf8'), 'base64')).toEqual(f.native);
    const archived = Buffer.from(readFileSync(join(archive, 'items', readdirSync(join(f.sourceRoot, 'items'))[0] + '.base64'), 'utf8'), 'base64').toString('utf8');
    expect(archived).toBe(f.original); expect(existsSync(join(f.targetRoot, 'library'))).toBe(false);
    const before = readFileSync(join(f.targetRoot, 'items', readdirSync(join(f.targetRoot, 'items'))[0]));
    applyKnowledgeMigration(plan, plan.planDigest);
    expect(readFileSync(join(f.targetRoot, 'items', readdirSync(join(f.targetRoot, 'items'))[0]))).toEqual(before);
    expect(readFileSync(f.itemPath, 'utf8')).toBe(f.original);
  });
  it('resumes a fixed plan after a partially acknowledged write, but never overwrites a later human maintenance decision', () => {
    const f = fixture(), plan = prepare(f), original = FileKnowledgeStore.prototype.write;
    vi.spyOn(FileKnowledgeStore.prototype, 'write').mockImplementationOnce(function (this: FileKnowledgeStore, command, actor) {
      original.call(this, command, actor); throw new Error('publication acknowledgement interrupted');
    });
    expect(() => applyKnowledgeMigration(plan, plan.planDigest)).toThrow('acknowledgement interrupted'); vi.restoreAllMocks();
    expect(new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot).list()[0].revisions).toHaveLength(1);
    applyKnowledgeMigration(plan, plan.planDigest);
    const store = new FileKnowledgeStore(join(f.targetRoot, 'items'), 'local', f.targetRoot), entry = store.list()[0];
    store.write({ commandKind: 'record_maintenance', requestId: 'human', knowledgeId: entry.knowledgeId, expectedGeneration: entry.generation,
      maintenance: { revisionId: entry.writeHeadRevisionId, actor, at, choice: 'retain', reason: '另行人工确认' } }, actor);
    expect(() => applyKnowledgeMigration(plan, plan.planDigest)).toThrow('edited');
    expect(store.read(entry.knowledgeId).maintenance).toHaveLength(1);
  });
  it('fails closed for unsupported items, source drift, target reuse and forged mechanical projections', () => {
    const f = fixture(), plan = prepare(f);
    expect(() => applyKnowledgeMigration(plan, hash('wrong'))).toThrow('digest mismatch');
    const changed = structuredClone(plan); changed.writes[0].revision.content.segments[0].text = 'invented';
    const payload = { ...changed } as Partial<typeof changed>; delete payload.planDigest; changed.planDigest = hash(canonicalJson(payload));
    expect(() => applyKnowledgeMigration(changed, changed.planDigest)).toThrow('projection');
    writeFileSync(f.itemPath, f.original + ' '); expect(() => applyKnowledgeMigration(plan, plan.planDigest)).toThrow('changed');
    writeFileSync(f.itemPath, f.original); mkdirSync(f.targetRoot); writeFileSync(join(f.targetRoot, 'human'), 'keep');
    expect(() => prepare(f)).toThrow('empty'); expect(() => applyKnowledgeMigration(plan, plan.planDigest)).toThrow('not owned');
    writeFileSync(f.itemPath, JSON.stringify({ ...f.envelope, schemaVersion: 1 }));
    expect(inspectLegacyKnowledgeWorkspace(f.sourceRoot).unsupported).toHaveLength(1);
    expect(() => prepare(f)).toThrow(); expect(() => parseLegacyKnowledgeEnvelope({ ...f.envelope, schemaVersion: 3 })).toThrow();
  });
});
