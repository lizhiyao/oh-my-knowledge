import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { seedKnowledgeWorkspace } from '../cli/knowledge-fixtures.js';
import { prepareAssociationMigration, applyAssociationMigration } from '../../src/knowledge/adapters/association-migration.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { FileGenerationJournalStore } from '../../src/knowledge/adapters/generation-journal-store.js';
import { inventoryFiles } from '../../src/knowledge/adapters/knowledge-migration.js';
import { canonicalJson } from '../../src/knowledge/store.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const actor = { actorKind: 'agent' as const, actorId: 'migration-test', executionRef: 'authored-migration-regression' }, at = '2026-10-29T00:00:00Z';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omk-association-migration-')); roots.push(root);
  const sourceRoot = join(root, 'old'), targetRoot = join(root, 'new'); mkdirSync(sourceRoot);
  const seeded = seedKnowledgeWorkspace(sourceRoot, 'migration');
  const knowledge = new FileKnowledgeStore(join(sourceRoot, 'items'), 'local', sourceRoot), body = knowledge.read(seeded.body.knowledgeId);
  knowledge.write({ commandKind: 'record_maintenance', requestId: randomUUID(), knowledgeId: body.knowledgeId, expectedGeneration: body.generation,
    maintenance: { revisionId: body.writeHeadRevisionId, choice: 'retain', actor, at, reason: 'Fixture retention, not truth.' } }, actor);
  const path = join(sourceRoot, 'associations', readdirSync(join(sourceRoot, 'associations'))[0]);
  const history = JSON.parse(readFileSync(path, 'utf8'));
  history.schemaVersion = 1;
  for (const revision of history.revisions) {
    revision.entityAnalysisRef = { analysisId: revision.catalogRefs[0].analysisId, revisionId: revision.catalogRefs[0].entityRevisionId }; delete revision.catalogRefs;
    revision.segmentEntityRefs = revision.segmentEntityRefs.map(({ analysisId: _analysis, entityRevisionId: _revision, ...ref }: { analysisId: string; entityRevisionId: string }) => ref);
  }
  // Original acceptance stays in the archive, never on the fresh projection.
  history.reviews.push({ projectionRevisionId: history.writeHeadRevisionId, choice: 'accept', actor, at, reason: 'Original review.' });
  history.generation++; history.receipts.push({ requestId: 'old-review', commandDigest: 'old-review-digest', committedGeneration: 2, revisionId: history.writeHeadRevisionId });
  writeFileSync(path, JSON.stringify(history, null, 1) + '\n');
  mkdirSync(join(sourceRoot, 'generation-journals')); const oldRunId = randomUUID();
  writeFileSync(join(sourceRoot, 'generation-journals', `${oldRunId}.json`), JSON.stringify({ storeKind: 'knowledge-generation-journal', schemaVersion: 1, runId: oldRunId, status: 'active', unknownDispatch: 'Never replay this original.' }));
  mkdirSync(join(sourceRoot, 'auto-extraction')); writeFileSync(join(sourceRoot, 'auto-extraction', 'old-permission.json'), '{"workflowId":"knowledge-body-first/v1","enabled":true}');
  writeFileSync(join(sourceRoot, 'native.bin'), Buffer.from([0, 255, 13, 10]));
  const inventory = inventoryFiles(sourceRoot);
  const plan = prepareAssociationMigration({ sourceRoot, targetRoot, namespace: 'local', actor, at, migrationId: randomUUID() });
  return { root, sourceRoot, targetRoot, seeded, path, history, inventory, plan, oldRunId };
}
describe('explicit association Schema 1 to 2 workspace migration', () => {
  it('preserves bodies/retention/sources/native bytes and exact catalog revisions, resets reviews and records original identity mappings', () => {
    const f = fixture(); expect(existsSync(f.targetRoot)).toBe(false);
    expect(createLocalKnowledgeApplication(f.sourceRoot).detail(f.seeded.body.knowledgeId).derivedAssociations.status).toBe('failed');
    const result = applyAssociationMigration(f.plan, f.plan.planDigest); expect(result).toMatchObject({ migratedRevisions: 1, pending: true });
    expect(inventoryFiles(f.sourceRoot)).toEqual(f.inventory);
    const detail = createLocalKnowledgeApplication(f.targetRoot).detail(f.seeded.body.knowledgeId);
    expect(detail.revision).toEqual(f.seeded.body); expect(detail.maintenance?.choice).toBe('retain');
    expect(detail.derivedAssociations).toMatchObject({ status: 'available', reviewStatus: 'pending', revision: { catalogRefs: [{ analysisId: f.seeded.analysis.history.analysisId, entityRevisionId: f.seeded.analysis.revision.revisionId }], revisedBy: actor } });
    expect(detail.derivedAssociations.revision!.revisionId).not.toBe(f.history.writeHeadRevisionId);
    for (const file of f.inventory) {
      const original = readFileSync(join(f.sourceRoot, file.path));
      expect(Buffer.from(readFileSync(join(f.targetRoot, 'migration', f.plan.migrationId, 'original', `${file.path}.base64`), 'utf8'), 'base64')).toEqual(original);
      if (!file.path.startsWith('associations/') && !file.path.startsWith('auto-extraction/')) expect(readFileSync(join(f.targetRoot, file.path))).toEqual(original);
    }
    expect(existsSync(join(f.targetRoot, 'auto-extraction'))).toBe(false);
    expect(new FileGenerationJournalStore(join(f.targetRoot, 'generation-journals'), f.targetRoot).list().unsupported).toEqual([expect.objectContaining({ runId: f.oldRunId })]);
    const before = inventoryFiles(f.targetRoot); applyAssociationMigration(f.plan, f.plan.planDigest); expect(inventoryFiles(f.targetRoot)).toEqual(before);
  });
  it('replays only its frozen plan after durable-write acknowledgement loss and refuses later user edits', () => {
    const f = fixture(), original = FileKnowledgeAssociationStore.prototype.write;
    vi.spyOn(FileKnowledgeAssociationStore.prototype, 'write').mockImplementationOnce(function (this: FileKnowledgeAssociationStore, command, author) {
      original.call(this, command, author); throw new Error('acknowledgement interrupted');
    });
    expect(() => applyAssociationMigration(f.plan, f.plan.planDigest)).toThrow('acknowledgement interrupted'); vi.restoreAllMocks();
    applyAssociationMigration(f.plan, f.plan.planDigest);
    const path = join(f.targetRoot, 'items', readdirSync(join(f.targetRoot, 'items'))[0]); writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    expect(() => applyAssociationMigration(f.plan, f.plan.planDigest)).toThrow('edited'); expect(inventoryFiles(f.sourceRoot)).toEqual(f.inventory);
  });
  it.each(['sources', 'associations'])('never resurrects a %s file deleted after completed migration', directory => {
    const f = fixture(); applyAssociationMigration(f.plan, f.plan.planDigest);
    const removed = join(f.targetRoot, directory, readdirSync(join(f.targetRoot, directory))[0]); rmSync(removed);
    expect(() => applyAssociationMigration(f.plan, f.plan.planDigest)).toThrow(); expect(existsSync(removed)).toBe(false);
  });
  it('blocks forged projections, source drift, nested targets and unknown schemas without changing the source', () => {
    const f = fixture(), changed = structuredClone(f.plan); changed.writes[0].revision.segmentEntityRefs = [];
    const payload = { ...changed } as Partial<typeof changed>; delete payload.planDigest; changed.planDigest = `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
    expect(() => applyAssociationMigration(changed, changed.planDigest)).toThrow('projection'); expect(existsSync(f.targetRoot)).toBe(false);
    expect(() => prepareAssociationMigration({ ...f.plan, targetRoot: join(f.sourceRoot, 'nested') })).toThrow('separate');
    writeFileSync(f.path, readFileSync(f.path, 'utf8') + ' '); expect(() => applyAssociationMigration(f.plan, f.plan.planDigest)).toThrow('changed');
    writeFileSync(f.path, JSON.stringify({ ...f.history, schemaVersion: 99 })); expect(() => prepareAssociationMigration({ ...f.plan })).toThrow();
  });
});
