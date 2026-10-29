import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { withWorkspaceWrite } from '../../evidence/storage/knowledge-workspace.js';
import { KnowledgeActorSchema, type KnowledgeActor } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { applyKnowledgeAssociationWrite, KnowledgeAssociationWriteSchema, validateKnowledgeAssociationReferences,
  type KnowledgeAssociationWrite } from '../associations.js';
import { parseLegacyAssociationEnvelope, qualifyLegacyAssociation } from '../migration/associations-v1.js';
import { inventoryFiles, assertSeparateRoots, assertEmptyTarget, type MigrationFile } from './knowledge-migration.js';
import { FileKnowledgeStore } from './knowledge-store.js';
import { FileEntityAnalysisStore } from './entity-store.js';
import { FileKnowledgeAssociationStore } from './association-store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';

const hash = (bytes: string | Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const digest = (value: unknown) => hash(canonicalJson(value));
type Append = Extract<KnowledgeAssociationWrite, { commandKind: 'append_revision' }>;
export interface AssociationMigrationPlan {
  migrationKind: 'knowledge-association-v1-to-v2'; schemaVersion: 1; migrationId: string;
  sourceRoot: string; targetRoot: string; namespace: string; actor: KnowledgeActor; at: string;
  inventory: MigrationFile[];
  mappings: { knowledgeId: string; oldRevisionId: string; revisionId: string }[];
  writes: Append[]; limitations: string[]; planDigest: string;
}
function oldAssociations(root: string, files: MigrationFile[], namespace: string) {
  const bodies = new FileKnowledgeStore(join(root, 'items'), namespace, root);
  bodies.list(); // Body schema, digest, history and retention must already be current and readable.
  const entities = new FileEntityAnalysisStore(join(root, 'entities'), root);
  return files.filter(file => file.path.split(/[\\/]/)[0] === 'associations').map(file => {
    if (dirname(file.path) !== 'associations' || !file.path.endsWith('.json')) throw new Error('Unexpected association migration path.');
    const history = parseLegacyAssociationEnvelope(JSON.parse(readFileSync(join(root, file.path), 'utf8')));
    if (history.namespace !== namespace || file.path !== join('associations', `${digest([namespace, history.knowledgeId]).slice(7)}.json`)) throw new Error('Legacy association filename identity mismatch.');
    const knowledge = bodies.read(history.knowledgeId);
    for (const revision of history.revisions) {
      const body = knowledge.revisions.find(item => item.revisionId === revision.bodyRef.revisionId);
      if (!body) throw new Error('Unknown migration body revision.');
      validateKnowledgeAssociationReferences({ ...qualifyLegacyAssociation(revision), revisionId: revision.revisionId,
        revisedAt: revision.revisedAt, revisedBy: revision.revisedBy, revisionReason: revision.revisionReason }, body);
      if (revision.entityAnalysisRef) {
        const catalog = entities.read(revision.entityAnalysisRef.analysisId);
        const exact = catalog.revisions.find(item => item.revisionId === revision.entityAnalysisRef!.revisionId);
        if (!exact) throw new Error('Unknown legacy association catalog revision.');
        for (const ref of revision.segmentEntityRefs) {
          if (!exact.entities.some(item => item.entityId === ref.entityId)
            || ref.mentionIds.some(id => !exact.mentions.some(item => item.mentionId === id && item.entityId === ref.entityId))
            || !body.content.segments.find(item => item.segmentId === ref.segmentId)!.evidence.some(item => item.source.snapshotId === catalog.snapshotId && item.source.sourceVersion === catalog.sourceVersion)) {
            throw new Error('Legacy association catalog/source mismatch.');
          }
        }
      }
    }
    return history;
  });
}
function project(history: ReturnType<typeof oldAssociations>[number], revisionIndex: number,
  plan: Pick<AssociationMigrationPlan, 'at' | 'actor'>, revisionId: string, parentRevisionId: string | undefined) {
  return { ...qualifyLegacyAssociation(history.revisions[revisionIndex]), revisionId,
    ...(parentRevisionId ? { parentRevisionId } : {}), revisedAt: plan.at, revisedBy: plan.actor,
    revisionReason: 'Explicit mechanical association Schema 1 to 2 migration; exact body/catalog bindings preserved, review reset to pending. Original history, actors, reviews and receipts remain in the migration archive.' };
}
/** No writes, models, profile reinterpretation or default workspace lookup. */
export function prepareAssociationMigration(input: {
  sourceRoot: string; targetRoot: string; namespace: string; actor: KnowledgeActor; at: string; migrationId: string;
}): AssociationMigrationPlan {
  const sourceRoot = resolve(input.sourceRoot), targetRoot = resolve(input.targetRoot);
  const actor = KnowledgeActorSchema.parse(input.actor); z.iso.datetime({ offset: true }).parse(input.at); z.string().uuid().parse(input.migrationId);
  z.string().min(1).max(256).parse(input.namespace); assertSeparateRoots(sourceRoot, targetRoot); assertEmptyTarget(targetRoot);
  const inventory = inventoryFiles(sourceRoot), histories = oldAssociations(sourceRoot, inventory, input.namespace);
  if (!histories.length) throw new Error('No Schema 1 associations to migrate.');
  const writes: Append[] = [], mappings: AssociationMigrationPlan['mappings'] = [];
  for (const history of histories) {
    let parent: string | undefined;
    for (const [index, old] of history.revisions.entries()) {
      const revisionId = randomUUID();
      writes.push({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: history.knowledgeId,
        expectedGeneration: index, expectedHeadRevisionId: parent ?? null, revision: project(history, index, { at: input.at, actor }, revisionId, parent) });
      mappings.push({ knowledgeId: history.knowledgeId, oldRevisionId: old.revisionId, revisionId }); parent = revisionId;
    }
  }
  const payload = { migrationKind: 'knowledge-association-v1-to-v2' as const, schemaVersion: 1 as const,
    migrationId: input.migrationId, sourceRoot, targetRoot, namespace: input.namespace, actor, at: input.at, inventory, mappings, writes,
    limitations: ['Mechanical projection conversion is pending; no old acceptance is inherited.',
      'Bodies, retention, sources, catalogs and historical measurements are copied byte-for-byte.',
      'Original association histories/reviews/receipts are archived; fresh projection and request identities are recorded in mappings.',
      'Old automatic extraction permissions, schedules and budgets are archived only; the new workspace has no inherited automatic authorization.',
      'Old generation journals and native outcomes retain their original bytes and unsupported workflow identity. They cannot resume with this version; use the preserved matching old binary/workspace for rollback.'],
  };
  return { ...payload, planDigest: digest(payload) };
}
function validatePlan(plan: AssociationMigrationPlan, expected: string) {
  const { planDigest, ...payload } = plan;
  if (plan.migrationKind !== 'knowledge-association-v1-to-v2' || plan.schemaVersion !== 1 || planDigest !== expected || digest(payload) !== expected) throw new Error('Migration plan digest mismatch.');
  z.string().uuid().parse(plan.migrationId); KnowledgeActorSchema.parse(plan.actor); z.iso.datetime({ offset: true }).parse(plan.at);
  assertSeparateRoots(plan.sourceRoot, plan.targetRoot);
  for (const file of plan.inventory) {
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => ['..', '', '.'].includes(part))) throw new Error('Invalid migration relative path.');
  }
  const current = inventoryFiles(plan.sourceRoot);
  if (canonicalJson(current) !== canonicalJson(plan.inventory)) throw new Error('Source workspace changed after preparation.');
  const histories = oldAssociations(plan.sourceRoot, current, plan.namespace);
  const expectedWrites: Append[] = []; const expectedMappings: AssociationMigrationPlan['mappings'] = [];
  const ids = new Set<string>(), requests = new Set<string>();
  for (const history of histories) {
    let parent: string | undefined;
    for (const [index, old] of history.revisions.entries()) {
      const write = plan.writes[expectedWrites.length];
      if (!write) throw new Error('Incomplete migration mapping.');
      KnowledgeAssociationWriteSchema.parse(write); z.string().uuid().parse(write.revision.revisionId); z.string().uuid().parse(write.requestId);
      if (ids.has(write.revision.revisionId) || requests.has(write.requestId)) throw new Error('Duplicate migration identity.');
      ids.add(write.revision.revisionId); requests.add(write.requestId);
      expectedWrites.push({ commandKind: 'append_revision', requestId: write.requestId, knowledgeId: history.knowledgeId,
        expectedGeneration: index, expectedHeadRevisionId: parent ?? null, revision: project(history, index, plan, write.revision.revisionId, parent) });
      expectedMappings.push({ knowledgeId: history.knowledgeId, oldRevisionId: old.revisionId, revisionId: write.revision.revisionId }); parent = write.revision.revisionId;
    }
  }
  if (canonicalJson(plan.writes) !== canonicalJson(expectedWrites) || canonicalJson(plan.mappings) !== canonicalJson(expectedMappings)) throw new Error('Migration projection or identity mapping changed.');
}
/** Exact plan replay only. Partial files are retained; later human edits are never overwritten. */
export function applyAssociationMigration(plan: AssociationMigrationPlan, expectedPlanDigest: string) {
  validatePlan(plan, expectedPlanDigest);
  const marker = join(plan.targetRoot, 'migration', plan.migrationId, 'plan.json'), markerBytes = JSON.stringify(plan, null, 2);
  if (existsSync(plan.targetRoot) && readdirSync(plan.targetRoot).length && (!existsSync(marker) || readFileSync(marker, 'utf8') !== markerBytes)) throw new Error('Migration target is not owned by this exact plan.');
  const completionPath = join(plan.targetRoot, 'migration', plan.migrationId, 'complete.json');
  const completed = existsSync(completionPath);
  const ensure = (path: string, bytes: string | Uint8Array) => {
    if (completed && !existsSync(path)) throw new Error('Completed migration target was edited or deleted.');
    if (existsSync(path)) {
      if (!readFileSync(path).equals(typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes))) throw new Error('Migration target was edited.');
      confirmKnowledgePublication(path, plan.targetRoot);
    } else publishKnowledgeBytes(path, bytes, plan.targetRoot, true);
  };
  const store = new FileKnowledgeAssociationStore(join(plan.targetRoot, 'associations'), plan.namespace,
    new FileKnowledgeStore(join(plan.targetRoot, 'items'), plan.namespace, plan.targetRoot),
    new FileEntityAnalysisStore(join(plan.targetRoot, 'entities'), plan.targetRoot), plan.targetRoot);
  const verifyAssociations = (complete: boolean) => {
    const entries = store.list();
    for (const entry of entries) {
      const planned = plan.writes.filter(write => write.knowledgeId === entry.knowledgeId);
      if (!planned.length || entry.reviews.length || (complete && entry.revisions.length !== planned.length)) throw new Error('Migrated associations were edited.');
      let expected: typeof entry | undefined;
      for (const write of planned.slice(0, entry.revisions.length)) expected = applyKnowledgeAssociationWrite(expected, write, plan.actor, plan.namespace, digest({ namespace: plan.namespace, actor: plan.actor, command: write }));
      if (canonicalJson(expected) !== canonicalJson(entry)) throw new Error('Migrated associations were edited.');
    }
    if (complete && entries.length !== new Set(plan.writes.map(write => write.knowledgeId)).size) throw new Error('Incomplete association publication.');
  };
  const result = { planDigest: expectedPlanDigest, migratedRevisions: plan.writes.length, pending: true as const };
  if (completed) return withWorkspaceWrite(plan.targetRoot, () => {
    const verify = (path: string, bytes: string | Uint8Array) => {
      if (!existsSync(path) || !readFileSync(path).equals(typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes))) throw new Error('Completed migration target was edited or deleted.');
      confirmKnowledgePublication(path, plan.targetRoot);
    };
    verify(marker, markerBytes); verify(completionPath, JSON.stringify(result, null, 2));
    for (const file of plan.inventory) {
      const bytes = readFileSync(join(plan.sourceRoot, file.path));
      verify(join(plan.targetRoot, 'migration', plan.migrationId, 'original', `${file.path}.base64`), bytes.toString('base64'));
      if (!['associations', 'auto-extraction'].includes(file.path.split(/[\\/]/)[0])) verify(join(plan.targetRoot, file.path), bytes);
    }
    verifyAssociations(true);
    for (const entry of store.list()) confirmKnowledgePublication(join(plan.targetRoot, 'associations', `${digest([plan.namespace, entry.knowledgeId]).slice(7)}.json`), plan.targetRoot);
    return result;
  });
  withWorkspaceWrite(plan.targetRoot, () => {
    ensure(marker, markerBytes);
    for (const file of plan.inventory) {
      const bytes = readFileSync(join(plan.sourceRoot, file.path));
      if (hash(bytes) !== file.digest || bytes.length !== file.bytes) throw new Error('Source changed during migration.');
      ensure(join(plan.targetRoot, 'migration', plan.migrationId, 'original', `${file.path}.base64`), bytes.toString('base64'));
      if (!['associations', 'auto-extraction'].includes(file.path.split(/[\\/]/)[0])) ensure(join(plan.targetRoot, file.path), bytes);
    }
    verifyAssociations(false);
  });
  for (const write of plan.writes) store.write(write, plan.actor);
  withWorkspaceWrite(plan.targetRoot, () => {
    validatePlan(plan, expectedPlanDigest); verifyAssociations(true);
    ensure(join(plan.targetRoot, 'migration', plan.migrationId, 'complete.json'), JSON.stringify(result, null, 2));
  });
  return result;
}
