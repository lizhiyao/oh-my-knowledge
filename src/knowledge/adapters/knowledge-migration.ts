import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { checkStorageDirectory, withWorkspaceWrite } from '../../evidence/storage/knowledge-workspace.js';
import { KnowledgeActorSchema, KnowledgeRevisionSchema, type KnowledgeActor } from '../contracts.js';
import { canonicalJson, type KnowledgeWrite } from '../store.js';
import { parseLegacyKnowledgeEnvelope, legacyRevisionToBodyDraft, type LegacyKnowledgeEnvelope } from '../migration/legacy-v2.js';
import { validateKnowledgeDraft } from '../validation.js';
import { FileKnowledgeStore } from './knowledge-store.js';
import { knowledgeBodyDigest } from './body-digest.js';
import { TraceEvidenceStore } from './trace-evidence.js';
import { FileEntityAnalysisStore } from './entity-store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';

const hash = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hashJson = (value: unknown) => hash(canonicalJson(value));
const MAX_FILES = 16_384, MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export interface MigrationFile { path: string; digest: string; bytes: number }
export interface LegacyWorkspaceInventory {
  files: MigrationFile[];
  items: { path: string; envelope: LegacyKnowledgeEnvelope }[];
  unsupported: { path: string; reason: string }[];
}
export function inventoryFiles(root: string): MigrationFile[] {
  checkStorageDirectory(root);
  if (!existsSync(root)) throw new Error('Legacy workspace is missing.');
  const files: MigrationFile[] = []; let total = 0;
  const walk = (directory: string) => {
    checkStorageDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('Migration does not follow symbolic links.');
      if (name.endsWith('.lock') || name.endsWith('.tmp')) throw new Error('Legacy workspace has unfinished or locked writes.');
      if (stat.isDirectory()) { walk(path); continue; }
      if (!stat.isFile()) throw new Error('Unsupported migration file.');
      total += stat.size;
      if (total > MAX_TOTAL_BYTES || files.length >= MAX_FILES) throw new Error('Migration inventory capacity exceeded.');
      const bytes = readFileSync(path);
      files.push({ path: relative(root, path), digest: hash(bytes), bytes: bytes.length });
    }
  };
  walk(root); return files;
}
/** Read-only inventory. Unsupported knowledge is explicit and blocks preparation; no current-reader fallback. */
export function inspectLegacyKnowledgeWorkspace(sourceRoot: string): LegacyWorkspaceInventory {
  const root = resolve(sourceRoot), files = inventoryFiles(root);
  const items: LegacyWorkspaceInventory['items'] = [], unsupported: LegacyWorkspaceInventory['unsupported'] = [];
  for (const file of files.filter(item => item.path.startsWith(`items${sep}`))) {
    try {
      if (dirname(file.path) !== 'items' || !file.path.endsWith('.json')) throw new Error('Unexpected legacy item path.');
      const envelope = parseLegacyKnowledgeEnvelope(JSON.parse(readFileSync(join(root, file.path), 'utf8')));
      if (file.path !== join('items', `${hashJson([envelope.namespace, envelope.knowledgeId]).slice(7)}.json`)) throw new Error('Legacy filename identity mismatch.');
      if (items.some(item => item.envelope.namespace === envelope.namespace && item.envelope.knowledgeId === envelope.knowledgeId)) throw new Error('Duplicate legacy knowledge identity.');
      items.push({ path: file.path, envelope });
    } catch (error) { unsupported.push({ path: file.path, reason: error instanceof Error ? error.message : 'Invalid legacy item.' }); }
  }
  return { files, items, unsupported };
}
function currentAncillaryCopies(sourceRoot: string, files: MigrationFile[]): string[] {
  return files.filter(file => {
      if (!file.path.endsWith('.json')) return false;
      const id = file.path.slice(file.path.lastIndexOf(sep) + 1, -5);
      try {
        const bytes = readFileSync(join(sourceRoot, file.path));
        if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) return false;
        if (dirname(file.path) === 'sources') {
          const source = new TraceEvidenceStore(join(sourceRoot, 'sources'), sourceRoot).read(id);
          return source.status === 'available' || source.reason === 'deleted';
        }
        if (dirname(file.path) === 'entities') { new FileEntityAnalysisStore(join(sourceRoot, 'entities'), sourceRoot).read(id); return true; }
      } catch { /* Invalid ancillary files remain byte-preserved only in the original archive. */ }
      return false;
    }).map(file => file.path);
}
export interface KnowledgeMigrationPlan {
  migrationKind: 'knowledge-body-v2-to-v3'; schemaVersion: 1; migrationId: string;
  sourceRoot: string; targetRoot: string; namespace: string; actor: KnowledgeActor; at: string;
  inventory: MigrationFile[];
  mappings: { oldNamespace: string; oldKnowledgeId: string; oldRevisionId: string; knowledgeId: string; revisionId: string; bodyDigest: string; segmentIds: string[] }[];
  writes: Extract<KnowledgeWrite, { commandKind: 'append_revision' }>[];
  activeCopies: string[];
  limitations: string[];
  planDigest: string;
}
export function assertSeparateRoots(source: string, target: string) {
  const absoluteSource = realpathSync(source);
  let ancestor = target; const missing: string[] = [];
  while (!existsSync(ancestor)) { missing.push(basename(ancestor)); ancestor = dirname(ancestor); }
  const absoluteTarget = resolve(realpathSync(ancestor), ...missing.reverse());
  const nested = (from: string, to: string) => { const path = relative(from, to); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)); };
  if (nested(absoluteSource, absoluteTarget) || nested(absoluteTarget, absoluteSource)) throw new Error('Migration requires a separate new workspace.');
}
export function assertEmptyTarget(target: string) {
  checkStorageDirectory(target);
  if (existsSync(target) && readdirSync(target).length) throw new Error('Migration target must be a new empty workspace.');
}
/** Freezes all UUIDs, actors, timestamps and exact original-file pins without creating the target. */
export function prepareKnowledgeMigration(input: {
  sourceRoot: string; targetRoot: string; namespace: string; actor: KnowledgeActor; at: string; migrationId: string;
}): KnowledgeMigrationPlan {
  const sourceRoot = resolve(input.sourceRoot), targetRoot = resolve(input.targetRoot);
  const actor = KnowledgeActorSchema.parse(input.actor); z.iso.datetime({ offset: true }).parse(input.at); z.string().uuid().parse(input.migrationId);
  z.string().min(1).max(256).parse(input.namespace); assertSeparateRoots(sourceRoot, targetRoot); assertEmptyTarget(targetRoot);
  const inventory = inspectLegacyKnowledgeWorkspace(sourceRoot);
  if (inventory.unsupported.length) throw new Error(`Unsupported legacy knowledge: ${inventory.unsupported.map(item => item.path).join(', ')}`);
  if (!inventory.items.length) throw new Error('No legacy v2 knowledge to migrate.');
  const writes: KnowledgeMigrationPlan['writes'] = [], mappings: KnowledgeMigrationPlan['mappings'] = [];
  for (const item of inventory.items) {
    const knowledgeId = randomUUID(); let previous: string | null = null;
    for (const [index, legacy] of item.envelope.revisions.entries()) {
      const draft = legacyRevisionToBodyDraft(item.envelope, legacy.revisionId);
      if (!validateKnowledgeDraft(draft).accepted) throw new Error('Legacy projection cannot form a valid pending body.');
      const revisionId = randomUUID(), bodyDigest = knowledgeBodyDigest(draft);
      const revision = KnowledgeRevisionSchema.parse({ ...draft, knowledgeId, revisionId, bodyDigest,
        ...(previous ? { parentRevision: { knowledgeId, revisionId: previous } } : {}),
        observationRefs: legacy.observationRefs, derivations: [], createdAt: input.at, createdBy: actor,
        revisedAt: input.at, revisedBy: actor, revisionReason: 'Explicit mechanical v2-to-v3 migration; semantic review remains pending. Original lineage and maintenance are preserved in the migration archive.',
      });
      writes.push({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: index, expectedHeadRevisionId: previous, revision });
      mappings.push({ oldNamespace: item.envelope.namespace, oldKnowledgeId: legacy.knowledgeId, oldRevisionId: legacy.revisionId, knowledgeId, revisionId, bodyDigest,
        segmentIds: draft.content.segments.map(segment => segment.segmentId) });
      previous = revisionId;
    }
  }
  const payload = { migrationKind: 'knowledge-body-v2-to-v3' as const, schemaVersion: 1 as const,
    migrationId: input.migrationId, sourceRoot, targetRoot, namespace: input.namespace, actor, at: input.at,
    inventory: inventory.files, mappings, writes,
    activeCopies: currentAncillaryCopies(sourceRoot, inventory.files),
    limitations: ['Mechanical legacy-field rendering is pending, not new extraction or semantic acceptance.',
      'Legacy maintenance, derivations and native histories remain byte-preserved in the archive; retain is not inherited.',
      'Existing library, carrier and cross-window exact references are archived only and are not retargeted.'],
  };
  return { ...payload, planDigest: hashJson(payload) };
}
function validatePlan(plan: KnowledgeMigrationPlan, expectedDigest: string) {
  const { planDigest, ...payload } = plan;
  if (plan.migrationKind !== 'knowledge-body-v2-to-v3' || plan.schemaVersion !== 1 || planDigest !== expectedDigest || hashJson(payload) !== expectedDigest) throw new Error('Migration plan digest mismatch.');
  z.string().uuid().parse(plan.migrationId); KnowledgeActorSchema.parse(plan.actor);
  for (const file of plan.inventory) {
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === '..' || part === '' || part === '.')) throw new Error('Invalid migration relative path.');
  }
  if (new Set(plan.inventory.map(file => file.path)).size !== plan.inventory.length
    || plan.activeCopies.some(path => !plan.inventory.some(file => file.path === path)
      || !['sources', 'entities'].includes(dirname(path)) || !path.endsWith('.json'))) throw new Error('Invalid migration copy inventory.');
  assertSeparateRoots(plan.sourceRoot, plan.targetRoot);
  const current = inspectLegacyKnowledgeWorkspace(plan.sourceRoot);
  if (current.unsupported.length || canonicalJson(current.files) !== canonicalJson(plan.inventory)) throw new Error('Legacy workspace changed after preparation.');
  if (canonicalJson(plan.activeCopies) !== canonicalJson(currentAncillaryCopies(plan.sourceRoot, current.files))) throw new Error('Migration active-copy inventory changed.');
  const oldRevisions = current.items.flatMap(item => item.envelope.revisions.map(revision => ({ envelope: item.envelope, revision })));
  if (plan.writes.length !== oldRevisions.length || plan.mappings.length !== oldRevisions.length) throw new Error('Incomplete migration revision mapping.');
  const newKnowledgeIds = new Map<string, string>(); const revisionIds = new Set<string>(); const requests = new Set<string>();
  for (const [index, old] of oldRevisions.entries()) {
    const write = plan.writes[index], mapping = plan.mappings[index], revision = KnowledgeRevisionSchema.parse(write.revision);
    const draft = legacyRevisionToBodyDraft(old.envelope, old.revision.revisionId);
    const prior = plan.writes.slice(0, index).filter(item => item.knowledgeId === write.knowledgeId);
    const oldKey = canonicalJson([old.envelope.namespace, old.envelope.knowledgeId]);
    if (!newKnowledgeIds.has(oldKey)) newKnowledgeIds.set(oldKey, write.knowledgeId);
    if (newKnowledgeIds.get(oldKey) !== write.knowledgeId || [...newKnowledgeIds].some(([key, id]) => key !== oldKey && id === write.knowledgeId)
      || write.commandKind !== 'append_revision' || write.expectedGeneration !== prior.length
      || write.expectedHeadRevisionId !== (prior.at(-1)?.revision.revisionId ?? null)
      || revision.knowledgeId !== write.knowledgeId || revisionIds.has(revision.revisionId) || requests.has(write.requestId)
      || canonicalJson({ title: revision.title, content: revision.content, reuseRationale: revision.reuseRationale }) !== canonicalJson(draft)
      || revision.bodyDigest !== knowledgeBodyDigest(draft)
      || revision.createdAt !== plan.at || revision.revisedAt !== plan.at
      || canonicalJson(revision.createdBy) !== canonicalJson(plan.actor) || canonicalJson(revision.revisedBy) !== canonicalJson(plan.actor)
      || canonicalJson(revision.observationRefs) !== canonicalJson(old.revision.observationRefs) || revision.derivations.length
      || canonicalJson(mapping) !== canonicalJson({ oldNamespace: old.envelope.namespace, oldKnowledgeId: old.revision.knowledgeId, oldRevisionId: old.revision.revisionId,
        knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest, segmentIds: draft.content.segments.map(segment => segment.segmentId) })) {
      throw new Error('Migration projection or identity mapping changed.');
    }
    revisionIds.add(revision.revisionId); requests.add(write.requestId);
  }
}
/** Explicit plan application; nontransactional across files. A retry resumes only the exact frozen plan and never overwrites edits. */
export function applyKnowledgeMigration(plan: KnowledgeMigrationPlan, expectedPlanDigest: string): { planDigest: string; migratedRevisions: number; pending: true } {
  validatePlan(plan, expectedPlanDigest);
  const marker = join(plan.targetRoot, 'migration', plan.migrationId, 'plan.json');
  if (existsSync(plan.targetRoot) && readdirSync(plan.targetRoot).length) {
    if (!existsSync(marker) || readFileSync(marker, 'utf8') !== JSON.stringify(plan, null, 2)) throw new Error('Migration target is not owned by this exact plan.');
  }
  const ensureUnlocked = (path: string, bytes: string) => {
      if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(bytes))) throw new Error('Migration target was edited.');
        confirmKnowledgePublication(path, plan.targetRoot);
      } else publishKnowledgeBytes(path, bytes, plan.targetRoot, true);
  };
  const ensureBytes = (path: string, bytes: string) => withWorkspaceWrite(plan.targetRoot, () => ensureUnlocked(path, bytes));
  // Archive bytes as base64 with the original-byte digest so arbitrary native files are retained exactly.
  ensureBytes(marker, JSON.stringify(plan, null, 2));
  for (const file of plan.inventory) {
    const bytes = readFileSync(join(plan.sourceRoot, file.path));
    if (hash(bytes) !== file.digest || bytes.length !== file.bytes) throw new Error('Legacy file changed during migration.');
    ensureBytes(join(plan.targetRoot, 'migration', plan.migrationId, 'original', `${file.path}.base64`), bytes.toString('base64'));
    if (plan.activeCopies.includes(file.path)) ensureBytes(join(plan.targetRoot, file.path), bytes.toString('utf8'));
  }
  const store = new FileKnowledgeStore(join(plan.targetRoot, 'items'), plan.namespace, plan.targetRoot);
  // Reject a human append/maintenance even though an individual receipt replay itself is idempotent.
  const verifyBodies = (complete: boolean) => {
    const entries = store.list();
    for (const entry of entries) {
      const planned = plan.writes.filter(write => write.knowledgeId === entry.knowledgeId);
      if (entry.maintenance.length || entry.generation !== entry.revisions.length || !planned.length
        || (complete && entry.revisions.length !== planned.length)
        || entry.revisions.some((revision, index) => canonicalJson(revision) !== canonicalJson(planned[index]?.revision))
        || entry.receipts.some((receipt, index) => {
          const command = planned[index];
          return !command || receipt.requestId !== command.requestId || receipt.commandDigest !== hashJson({ namespace: plan.namespace,
            actor: { actorKind: plan.actor.actorKind, actorId: plan.actor.actorId }, command });
        })) throw new Error('Migrated body was edited.');
    }
    if (complete && entries.length !== new Set(plan.writes.map(write => write.knowledgeId)).size) throw new Error('Incomplete migration body publication.');
  };
  verifyBodies(false);
  for (const write of plan.writes) store.write(write, plan.actor);
  withWorkspaceWrite(plan.targetRoot, () => {
    validatePlan(plan, expectedPlanDigest); verifyBodies(true);
    ensureUnlocked(join(plan.targetRoot, 'migration', plan.migrationId, 'complete.json'), JSON.stringify({ planDigest: expectedPlanDigest, migratedRevisions: plan.writes.length, pending: true }, null, 2));
  });
  return { planDigest: expectedPlanDigest, migratedRevisions: plan.writes.length, pending: true };
}
