import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { recoverStorageLock, SOURCE_MIGRATION_STATE_FILE, SOURCE_MIGRATION_LOCK_FILE, WORKSPACE_LOCK_FILE,
  assertSourceMigrationWriteContext, withSourceMigrationWorkspaceWrite, type SourceMigrationWriteContext } from '../../evidence/storage/knowledge-workspace.js';
import { KnowledgeActorSchema, KnowledgeRevisionSchema, type EvidenceSelection, type KnowledgeActor, type KnowledgeBodyRef, type KnowledgeRevision } from '../contracts.js';
import { KnowledgeAssociationRevisionSchema, applyKnowledgeAssociationWrite, validateKnowledgeAssociationReferences,
  type KnowledgeAssociationEnvelope, type KnowledgeAssociationRevision, type KnowledgeAssociationWrite } from '../associations.js';
import { validateKnowledgeAssociationCatalogReferences } from '../entities/association-references.js';
import { EntityAnalysisWriteSchema, type EntityAnalysisEnvelope, type EntityAnalysisWrite } from '../entities/contracts.js';
import { applyEntityAnalysisWrite } from '../entities/history.js';
import { mapEntityIdentity } from '../entities/identity.js';
// Historical decoder used only by this explicit migration; Source3 resolution never consumes Source2.
import { EvidenceWindowSchema, type EvidenceWindow } from '../extraction/evidence.js';
import { applyKnowledgeWrite } from '../history.js';
import { canonicalJson, type KnowledgeEnvelope, type KnowledgeWrite } from '../store.js';
import { SOURCE_PROJECTION_VERSION, SourceProjectionSchema, SourceSnapshotSchema, normalizeRecordRanges, sourceSnapshotProjection,
  sourceVersionPreimage, type SourceProjection, type SourceRef, type SourceSnapshot } from '../sources.js';
import { FileKnowledgeAssociationStore } from './association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from './body-digest.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';
import { FileEntityAnalysisStore } from './entity-store.js';
import { FileKnowledgeTags } from './knowledge-tags.js';
import { FileKnowledgeStore } from './knowledge-store.js';
import { FileSourceStore, SOURCE_SNAPSHOT_MAX_BYTES, SOURCE_STORAGE_MAX_BYTES } from './source-store.js';

export { SOURCE_MIGRATION_STATE_FILE } from '../../evidence/storage/knowledge-workspace.js';
export const SOURCE_MIGRATION_IN_PROGRESS = 'in_progress' as const;
export const SOURCE_MIGRATION_COMPLETE = 'complete' as const;
export const SOURCE_MIGRATION_PLAN_MAX_BYTES = 128 * 1024 * 1024;
const KIND = 'knowledge-source2-to3', MAX_FILES = 16_384, MAX_BYTES = 512 * 1024 * 1024;
const MAX_RECEIPT_ENTRIES = MAX_FILES * 3, MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const sha = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (value: unknown) => sha(canonicalJson(value));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sameSource = (a: SourceRef, b: SourceRef) => a.snapshotId === b.snapshotId && a.sourceVersion === b.sourceVersion;
const reason = 'Explicit Source2 to Source3 independent-copy migration; source references changed and require fresh review. Original history and approvals remain archived.';
type AppendBody = Extract<KnowledgeWrite, { commandKind: 'append_revision' }>;
type AppendAssociation = Extract<KnowledgeAssociationWrite, { commandKind: 'append_revision' }>;
export interface SourceMigrationFile { path: string; bytes: number; digest: string }
export interface SourceMigrationInput {
  migrationId: string; sourceRoot: string; targetRoot: string; namespace: string; actor: KnowledgeActor; at: string;
  matchingBuildArchivePath: string; matchingBuildId: string;
}
export interface SourceMigrationPlan extends SourceMigrationInput {
  migrationKind: typeof KIND; schemaVersion: 1; planDigest: string; archiveRoot: string;
  inventory: SourceMigrationFile[]; directories: string[]; matchingBuild: { bytes: number; digest: string };
  sources: { old: SourceRef; projection: SourceProjection; sourceVersion: string; archiveDigest: string }[];
  bodies: { old: KnowledgeBodyRef; revisionId: string; requestId: string }[];
  catalogs: { oldAnalysisId: string; analysisId: string; revisions: { oldRevisionId: string; revisionId: string; requestId: string }[];
    entityIds: [string, string][]; mentionIds: [string, string][] }[];
  associations: { knowledgeId: string; oldRevisionId: string; revisionId: string; requestId: string }[];
  archivedProjectionRefs: { knowledgeId: string; revisionId: string }[];
  organizationalTagPaths: string[]; limitations: string[];
}
type MigrationReceipt = { migrationKind: typeof KIND; schemaVersion: 1; migrationId: string; planDigest: string; state: typeof SOURCE_MIGRATION_IN_PROGRESS | typeof SOURCE_MIGRATION_COMPLETE;
  completedSteps: string[]; files: SourceMigrationFile[]; directories: string[] };
type Data = { windows: EvidenceWindow[]; bodies: KnowledgeEnvelope[]; catalogs: EntityAnalysisEnvelope[]; associations: KnowledgeAssociationEnvelope[] };
export class SourceMigrationError extends Error {
  constructor(readonly code: 'unsupported' | 'corrupt' | 'conflict' | 'capacity_exceeded', message: string) { super(message); this.name = 'SourceMigrationError'; }
}
function refuse(message: string, code: SourceMigrationError['code'] = 'conflict'): never { throw new SourceMigrationError(code, message); }
function uuid(seed: string): string {
  const value = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`;
}
function safeRelative(path: string) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) refuse('Invalid migration relative path.');
}
function stableBytes(path: string): Buffer {
  const canonical = realpathSync(path); if (canonical !== resolve(path)) refuse('Migration reads refuse symbolic path components.');
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) refuse('Migration only reads ordinary files; symbolic links are refused.');
  if (before.size > BigInt(MAX_BYTES)) refuse('Migration file exceeds capacity.', 'capacity_exceeded');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) refuse('Migration file identity changed.');
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1); let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, null); if (!count) break; offset += count; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (realpathSync(path) !== canonical || offset !== Number(before.size) || [opened, after, named].some(stat => stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size
      || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || !stat.isFile() || stat.isSymbolicLink())) refuse('Migration input changed during read.');
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
function canonicalRoot(path: string, mustExist: boolean): string {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) refuse('Explicit absolute migration paths are required.');
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    const stat = lstatSync(absolute); if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('Migration roots must be ordinary directories.');
    return realpathSync(absolute);
  }
  if (mustExist) refuse('Migration source root is missing.');
  return join(canonicalRoot(dirname(absolute), false), relative(dirname(absolute), absolute));
}
function separate(source: string, target: string) {
  for (const [a, b] of [[source, target], [target, source]]) {
    const local = relative(a, b); if (!local || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) refuse('Migration roots must be separate, without ancestor relationships.');
  }
  if (existsSync(target)) { const a = lstatSync(source), b = lstatSync(target); if (a.ino === b.ino && a.dev === b.dev) refuse('Migration roots share an inode.'); }
}
function inventory(root: string, control = false, context?: SourceMigrationWriteContext): { files: SourceMigrationFile[]; directories: string[] } {
  if (context) assertSourceMigrationWriteContext(root, context);
  const files: SourceMigrationFile[] = [], directories: string[] = []; let total = 0;
  const walk = (directory: string) => {
    const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory) refuse('Migration inventory refuses symbolic links.');
    for (const name of readdirSync(directory).sort()) {
      if (control && directory === root && (name === SOURCE_MIGRATION_LOCK_FILE || context && name === WORKSPACE_LOCK_FILE)) continue;
      const path = join(directory, name), relativePath = relative(root, path).split(sep).join('/'); safeRelative(relativePath);
      const entry = lstatSync(path); if (entry.isSymbolicLink()) refuse('Migration inventory refuses symbolic links.');
      if (name.endsWith('.lock') || name.endsWith('.tmp') && (!control || !temporaryBase(relativePath))) refuse('Migration workspace contains unfinished or locked writes.');
      if (entry.isDirectory()) { if (directories.length >= MAX_FILES * (control ? 3 : 1)) refuse('Migration directory inventory exceeds capacity.', 'capacity_exceeded');
        directories.push(relativePath); walk(path); continue; }
      const bytes = stableBytes(path); total += bytes.length;
      if (files.length >= MAX_FILES * (control ? 3 : 1) || total > MAX_BYTES * (control ? 4 : 1)) refuse('Migration inventory exceeds capacity.', 'capacity_exceeded');
      files.push({ path: relativePath, bytes: bytes.length, digest: sha(bytes) });
    }
  };
  walk(root); return { files, directories };
}
function sourceProjection(window: EvidenceWindow): SourceProjection {
  const indexes = new Map(window.records.map((record, index) => [record.recordIndex, index]));
  if (indexes.size !== window.records.length || window.records.some((record, index) => index > 0 && record.recordIndex <= window.records[index - 1].recordIndex)
    || window.startRecord !== window.records[0].recordIndex || window.endRecord !== window.records.at(-1)!.recordIndex) refuse('Legacy original record coordinates are invalid.', 'corrupt');
  const material = { materialType: 'unknown' as const, attributionBasis: 'unknown' as const, reason: 'Legacy Source2 did not declare a source-neutral material type; original projection text is preserved without reinterpretation.' };
  const ordinals = new Map<number, number>(), evidenceRefs = new Set<string>();
  const excerpts = window.excerpts.map(excerpt => {
    const unitId = indexes.get(excerpt.recordIndex); if (unitId === undefined || evidenceRefs.has(excerpt.evidenceRef)) refuse('Legacy excerpt does not bind one original record.', 'corrupt');
    evidenceRefs.add(excerpt.evidenceRef); const eventOrdinal = ordinals.get(unitId) ?? 0; ordinals.set(unitId, eventOrdinal + 1);
    return { unitId, text: excerpt.text, material, coordinate: { coordinateKind: 'trace_event' as const, recordIndex: excerpt.recordIndex, eventOrdinal,
      eventKind: excerpt.eventKind, ...(excerpt.role === undefined ? {} : { role: excerpt.role }), ...(excerpt.timestamp === undefined ? {} : { timestamp: excerpt.timestamp }) } };
  });
  const ranges: { startRecord: number; endRecord: number }[] = [];
  for (const record of window.records) {
    const previous = ranges.at(-1);
    if (previous && previous.endRecord + 1 === record.recordIndex) previous.endRecord = record.recordIndex;
    else ranges.push({ startRecord: record.recordIndex, endRecord: record.recordIndex });
  }
  normalizeRecordRanges(ranges, window.endRecord);
  return SourceProjectionSchema.parse({ projectionVersion: SOURCE_PROJECTION_VERSION, sourceKind: 'agent_trace',
    identity: { sourceId: `source2:${window.snapshotId}`, traceKind: window.sourceKind }, selection: { recordRanges: ranges },
    contentVersion: digest(window.records), material, provenance: { attributions: [], times: [] },
    ...(window.origin ? { origin: { threadId: window.origin.threadId, ...(window.origin.turnId ? { turnId: window.origin.turnId } : {}), title: window.origin.title } } : {}),
    rawUnits: window.records.map((record, unitId) => ({ unitId, text: record.raw, rawByteDigest: sha(record.raw), rawByteLength: Buffer.byteLength(record.raw), coordinate: { coordinateKind: 'trace_record', recordIndex: record.recordIndex } })),
    excerpts, limitations: [...window.limitations, 'Legacy original record strings and fixed excerpt text are preserved exactly. Missing original file terminators and byte offsets are unavailable; no trace parser, model or measurement was replayed.'] });
}
function inspect(root: string, namespace: string, files: SourceMigrationFile[]): Data {
  const knowledge = new FileKnowledgeStore(join(root, 'items'), namespace, root), entityStore = new FileEntityAnalysisStore(join(root, 'entities'), root);
  const bodies = knowledge.list(), listed = entityStore.list(); if (listed.unavailable) refuse('A required entity catalog is corrupt or unsupported.', 'corrupt');
  const associations = new FileKnowledgeAssociationStore(join(root, 'associations'), namespace, knowledge, entityStore, root).list();
  const windows: EvidenceWindow[] = [];
  for (const file of files.filter(value => value.path.startsWith('sources/'))) {
    if (dirname(file.path) !== 'sources' || !file.path.endsWith('.json')) refuse('Unsupported legacy source path.', 'unsupported');
    if (file.bytes > SOURCE_SNAPSHOT_MAX_BYTES + 256) refuse('Legacy Source2 envelope exceeds its read capacity.', 'capacity_exceeded');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stableBytes(join(root, file.path))));
    const id = file.path.slice(8, -5); z.string().uuid().parse(id);
    if (value.deleted === true && value.snapshotId === id && Object.keys(value).every(key => ['snapshotId', 'deleted'].includes(key))) continue;
    const { windowDigest, ...data } = value;
    if (data.projectionVersion !== 'knowledge-window-v2') refuse('Only healthy Source2 windows are supported by this migration slice.', 'unsupported');
    const window = EvidenceWindowSchema.parse(data);
    if (window.snapshotId !== id || sha(JSON.stringify(window, null, 2)) !== windowDigest || sha(JSON.stringify(window.records)) !== window.sourceVersion) refuse('Legacy source integrity mismatch.', 'corrupt');
    sourceProjection(window); windows.push(window);
  }
  const checkSource = (source: SourceRef) => { const window = windows.find(value => value.snapshotId === source.snapshotId && value.sourceVersion === source.sourceVersion);
    if (!window) refuse('A required legacy source is missing, deleted or does not match its exact version.', 'corrupt'); return window; };
  const checkSelection = (source: SourceRef, selection: EvidenceSelection) => {
    const excerpt = checkSource(source).excerpts.find(value => value.evidenceRef === selection.evidenceRef);
    if (!excerpt || selection.end - selection.start !== selection.quote.length || excerpt.text.slice(selection.start, selection.end) !== selection.quote) refuse('Legacy evidence quote does not match exact UTF-16 source text.', 'corrupt');
  };
  for (const body of bodies) for (const segment of body.revisions.at(-1)!.content.segments) for (const evidence of segment.evidence) checkSelection(evidence.source, evidence.selection);
  for (const catalog of listed.histories) for (const revision of catalog.revisions) for (const mention of revision.mentions) checkSelection(catalog, mention.selection);
  for (const history of associations) for (const revision of history.revisions) {
    const body = bodies.find(value => value.knowledgeId === revision.bodyRef.knowledgeId)!.revisions.find(value => value.revisionId === revision.bodyRef.revisionId)!;
    for (const ref of revision.catalogRefs) validateKnowledgeAssociationCatalogReferences(revision, body, entityStore.read(ref.analysisId), ref.entityRevisionId);
  }
  for (const prefix of ['items', 'entities', 'associations']) for (const file of files.filter(value => value.path.startsWith(`${prefix}/`))) {
    if (dirname(file.path) !== prefix || !file.path.endsWith('.json')) refuse('Unsupported primary storage entry.', 'unsupported');
  }
  return { windows, bodies, catalogs: listed.histories, associations };
}

function planInput(input: SourceMigrationInput): SourceMigrationInput {
  z.string().uuid().parse(input.migrationId); z.string().min(1).max(256).parse(input.namespace);
  KnowledgeActorSchema.parse(input.actor); z.iso.datetime({ offset: true }).parse(input.at); z.string().min(1).max(512).parse(input.matchingBuildId);
  const sourceRoot = canonicalRoot(input.sourceRoot, true), targetRoot = canonicalRoot(input.targetRoot, false); separate(sourceRoot, targetRoot);
  if (!isAbsolute(input.matchingBuildArchivePath)) refuse('An explicit matching-build archive path is required.');
  if (lstatSync(input.matchingBuildArchivePath).isSymbolicLink()) refuse('Matching-build archive must not be a symbolic link.');
  const matchingBuildArchivePath = realpathSync(input.matchingBuildArchivePath);
  const build = stableBytes(matchingBuildArchivePath); if (!build.length) refuse('Matching-build archive is empty.', 'unsupported');
  if (!/\.(?:tgz|tar\.gz|tar|zip)$/iu.test(basename(matchingBuildArchivePath))) refuse('Preserve an installable matching-build archive filename.', 'unsupported');
  for (const root of [sourceRoot, targetRoot]) {
    const local = relative(root, matchingBuildArchivePath); if (!local || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) refuse('Matching-build archive must be independent of both workspaces.');
  }
  return { migrationId: input.migrationId, sourceRoot, targetRoot, namespace: input.namespace, actor: KnowledgeActorSchema.parse(input.actor),
    at: input.at, matchingBuildArchivePath, matchingBuildId: input.matchingBuildId };
}
function prepare(input: SourceMigrationInput, checkTarget = true): { plan: SourceMigrationPlan; data: Data } {
  const fixed = planInput(input), old = inventory(fixed.sourceRoot), data = inspect(fixed.sourceRoot, fixed.namespace, old.files);
  const ids = (...parts: unknown[]) => uuid(canonicalJson([fixed.migrationId, ...parts]));
  const sources = data.windows.map(window => { const projection = sourceProjection(window); return { old: { snapshotId: window.snapshotId, sourceVersion: window.sourceVersion }, projection,
    sourceVersion: digest(sourceVersionPreimage(projection)), archiveDigest: old.files.find(file => file.path === `sources/${window.snapshotId}.json`)!.digest }; });
  if (sources.length > 256) refuse('This slice supports at most 256 healthy source windows.', 'capacity_exceeded');
  const bodies = data.bodies.map(history => { const body = history.revisions.at(-1)!; return { old: knowledgeBodyRef(body),
    revisionId: ids('body', history.knowledgeId, body.revisionId), requestId: ids('body-request', history.knowledgeId) }; });
  const catalogs = data.catalogs.map(history => ({ oldAnalysisId: history.analysisId, analysisId: ids('analysis', history.analysisId),
    revisions: history.revisions.map(revision => ({ oldRevisionId: revision.revisionId, revisionId: ids('entity-revision', history.analysisId, revision.revisionId), requestId: ids('entity-request', history.analysisId, revision.revisionId) })),
    entityIds: [...new Set(history.revisions.flatMap(revision => revision.entities.map(entity => entity.entityId)))].sort().map(id => [id, ids('entity', history.analysisId, id)] as [string, string]),
    mentionIds: [...new Set(history.revisions.flatMap(revision => revision.mentions.map(mention => mention.mentionId)))].sort().map(id => [id, ids('mention', history.analysisId, id)] as [string, string]) }));
  const archivedProjectionRefs: SourceMigrationPlan['archivedProjectionRefs'] = [], associations: SourceMigrationPlan['associations'] = [];
  for (const history of data.associations) {
    const body = bodies.find(item => item.old.knowledgeId === history.knowledgeId)!;
    const selected = [...history.revisions].reverse().find(revision => same(revision.bodyRef, body.old));
    for (const revision of history.revisions) if (revision !== selected) archivedProjectionRefs.push({ knowledgeId: history.knowledgeId, revisionId: revision.revisionId });
    if (selected) associations.push({ knowledgeId: history.knowledgeId, oldRevisionId: selected.revisionId,
      revisionId: ids('association', history.knowledgeId, selected.revisionId), requestId: ids('association-request', history.knowledgeId) });
  }
  const organizationalTagPaths = old.files.filter(file => file.path.startsWith('tags/')).map(file => {
    const history = data.bodies.find(body => file.path === `tags/${digest([fixed.namespace, body.knowledgeId]).slice(7)}.json`);
    if (!history) refuse('Unsupported organization tag entry.', 'unsupported');
    new FileKnowledgeTags(join(fixed.sourceRoot, 'tags'), fixed.namespace, fixed.sourceRoot).read(history.knowledgeId); return file.path;
  });
  const buildBytes = stableBytes(fixed.matchingBuildArchivePath), payload = { ...fixed, migrationKind: KIND as typeof KIND, schemaVersion: 1 as const,
    archiveRoot: join(fixed.targetRoot, 'migration', fixed.migrationId), inventory: old.files, directories: old.directories,
    matchingBuild: { bytes: buildBytes.length, digest: sha(buildBytes) }, sources, bodies, catalogs, associations, archivedProjectionRefs, organizationalTagPaths,
    limitations: ['Only current body heads are copied into fresh pending revisions; all original user edits and history remain byte-for-byte in the archive.',
      'Legacy raw strings lack original file terminators/offsets; fixed excerpt text, quote offsets, roles and times are preserved without replay.',
      'Legacy sourcePath, origin.cwd and capture timestamps remain in the original archive only; portable snapshots omit host paths and record a new capture time.',
      'Retention, reviews, library confirmations, carriers, journals, measurements and automation permissions are archived only and are not enabled in the new workspace.',
      'Catalog and projection identities are fresh; no historical measurement or manual same-object confirmation is transferred.',
      'The matching build identity is host-declared and its archive is byte-verified; installation and rollback require separate real acceptance.',
      'A nonempty target without durable migration ownership is refused, including a crash before the first ownership receipt; automatic bootstrap recovery is unsupported.',
      'Migration is resumable per exact plan and CAS receipts, not a cross-file transaction.'] };
  // Digest and publication both serialize this complete plan; count its exact pretty JSON before either allocation.
  validatePlanCapacity({ ...payload, planDigest: `sha256:${'0'.repeat(64)}` });
  const plan: SourceMigrationPlan = { ...payload, planDigest: digest(payload) };
  validatePlannedCapacity(plan, data);
  if (existsSync(fixed.targetRoot) && readdirSync(fixed.targetRoot).length) {
    const marker = join(fixed.targetRoot, SOURCE_MIGRATION_STATE_FILE);
    if (!existsSync(marker)) refuse('Migration target contains unrelated existing data.');
    const receipt = JSON.parse(stableBytes(marker).toString('utf8'));
    if (receipt.migrationId !== plan.migrationId || receipt.planDigest !== plan.planDigest) refuse('Migration target belongs to a different plan.');
    if (checkTarget) verifyTarget(plan, data, receipt);
  }
  if (!same(old, inventory(fixed.sourceRoot))) refuse('Original workspace changed during preflight.');
  return { plan, data };
}
/** Explicit read-only preflight; never repairs originals, creates directories or dispatches historical work. */
export function prepareSourceMigration(input: SourceMigrationInput): SourceMigrationPlan {
  try { return prepare(input).plan; }
  catch (error) { if (error instanceof SourceMigrationError) throw error;
    throw new SourceMigrationError((error as { stateCode?: string }).stateCode === 'knowledge_storage_unsupported' ? 'unsupported' : 'corrupt', 'Migration preflight refused unsupported, corrupt or missing required data.'); }
}
type Captured = { old: SourceRef; snapshot: SourceSnapshot }[];
function mappedSelection(source: SourceRef, selection: EvidenceSelection, captured: Captured, data: Data): EvidenceSelection {
  const old = data.windows.find(window => sameSource(window, source));
  const replacement = captured.find(item => sameSource(item.old, source));
  const ordinal = old?.excerpts.findIndex(excerpt => excerpt.evidenceRef === selection.evidenceRef) ?? -1;
  const original = old?.excerpts[ordinal], current = replacement?.snapshot.excerpts[ordinal];
  if (!original || !current || original.text !== current.text || current.text.slice(selection.start, selection.end) !== selection.quote
    || selection.end - selection.start !== selection.quote.length) refuse('Exact UTF-16 migration quote mapping failed.', 'corrupt');
  return { ...selection, evidenceRef: current.evidenceRef };
}
function writes(plan: SourceMigrationPlan, data: Data, captured: Captured) {
  const newSource = (old: SourceRef) => { const value = captured.find(item => sameSource(item.old, old)); if (!value) refuse('Incomplete source mapping.', 'corrupt');
    return { snapshotId: value.snapshot.snapshotId, sourceVersion: value.snapshot.sourceVersion }; };
  const evidence = (value: KnowledgeRevision['content']['segments'][number]['evidence'][number]) => ({ ...value, source: newSource(value.source), selection: mappedSelection(value.source, value.selection, captured, data) });
  const bodies: AppendBody[] = data.bodies.map(history => {
    const old = history.revisions.at(-1)!, identity = plan.bodies.find(item => item.old.knowledgeId === old.knowledgeId)!;
    const content = { ...old.content, segments: old.content.segments.map(segment => ({ ...segment, evidence: segment.evidence.map(evidence) })) };
    const revision = KnowledgeRevisionSchema.parse({ ...old, content, revisionId: identity.revisionId, parentRevision: undefined,
      bodyDigest: knowledgeBodyDigest({ title: old.title, content, reuseRationale: old.reuseRationale }), createdAt: plan.at, revisedAt: plan.at,
      createdBy: plan.actor, revisedBy: plan.actor, revisionReason: reason });
    return { commandKind: 'append_revision', requestId: identity.requestId, knowledgeId: old.knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null, revision };
  });
  const entities: EntityAnalysisWrite[] = [];
  for (const history of data.catalogs) {
    const identity = plan.catalogs.find(item => item.oldAnalysisId === history.analysisId)!, entityIds = new Map(identity.entityIds), mentionIds = new Map(identity.mentionIds);
    for (const [index, old] of history.revisions.entries()) {
      const current = identity.revisions[index], parent = index ? identity.revisions[index - 1].revisionId : undefined;
      entities.push(EntityAnalysisWriteSchema.parse({ analysisId: identity.analysisId, ...newSource(history), requestId: current.requestId,
        expectedGeneration: index, expectedHeadRevisionId: parent ?? null, revision: { ...old, revisionId: current.revisionId, parentRevisionId: parent,
          entities: old.entities.map(entity => mapEntityIdentity(entity, entityIds, mentionIds)),
          mentions: old.mentions.map(mention => ({ ...mention, mentionId: mentionIds.get(mention.mentionId), entityId: entityIds.get(mention.entityId), selection: mappedSelection(history, mention.selection, captured, data) })),
          revisedAt: plan.at, revisedBy: plan.actor, revisionReason: reason } }));
    }
  }
  const endpoint = (old: KnowledgeAssociationRevision['segmentEntityRefs'][number]) => {
    const catalog = plan.catalogs.find(item => item.oldAnalysisId === old.analysisId), revision = catalog?.revisions.find(item => item.oldRevisionId === old.entityRevisionId);
    const entityId = catalog?.entityIds.find(([id]) => id === old.entityId)?.[1]; if (!catalog || !revision || !entityId) refuse('Unknown qualified catalog mapping.', 'corrupt');
    return { analysisId: catalog.analysisId, entityRevisionId: revision.revisionId, entityId };
  };
  const associations: AppendAssociation[] = plan.associations.map(identity => {
    const old = data.associations.find(history => history.knowledgeId === identity.knowledgeId)!.revisions.find(revision => revision.revisionId === identity.oldRevisionId)!;
    const body = bodies.find(item => item.knowledgeId === identity.knowledgeId)!.revision;
    const revision = KnowledgeAssociationRevisionSchema.parse({ ...old, revisionId: identity.revisionId, parentRevisionId: undefined, bodyRef: knowledgeBodyRef(body),
      reviewStatus: 'pending', catalogRefs: old.catalogRefs.map(ref => {
        const catalog = plan.catalogs.find(item => item.oldAnalysisId === ref.analysisId), revision = catalog?.revisions.find(item => item.oldRevisionId === ref.entityRevisionId);
        if (!catalog || !revision) refuse('Unknown catalog revision mapping.', 'corrupt'); return { analysisId: catalog.analysisId, entityRevisionId: revision.revisionId };
      }), segmentEntityRefs: old.segmentEntityRefs.map(ref => { const catalog = plan.catalogs.find(item => item.oldAnalysisId === ref.analysisId)!;
        return { ...ref, ...endpoint(ref), mentionIds: ref.mentionIds.map(id => { const mapped = catalog.mentionIds.find(([oldId]) => oldId === id)?.[1]; if (!mapped) refuse('Unknown mention mapping.', 'corrupt'); return mapped; }) }; }),
      typedRelations: old.typedRelations?.map(relation => ({ ...relation, subject: endpoint({ ...relation.subject, segmentId: '', mentionIds: [] }),
        ...(relation.object ? { object: endpoint({ ...relation.object, segmentId: '', mentionIds: [] }) } : {}), evidence: relation.evidence.map(evidence) })),
      revisedAt: plan.at, revisedBy: plan.actor, revisionReason: reason });
    return { commandKind: 'append_revision', requestId: identity.requestId, knowledgeId: identity.knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null, revision };
  });
  const result = { bodies, entities, associations };
  return JSON.parse(JSON.stringify(result)) as typeof result;
}
function expectedEnvelopes(plan: SourceMigrationPlan, commands: ReturnType<typeof writes>): Map<string, unknown[]> {
  const result = new Map<string, unknown[]>(), add = (path: string, value: unknown) => {
    if (Buffer.byteLength(JSON.stringify(value, null, 2)) > SOURCE_SNAPSHOT_MAX_BYTES) refuse('Migrated envelope exceeds capacity.', 'capacity_exceeded');
    result.set(path, [...(result.get(path) ?? []), value]);
  };
  for (const command of commands.bodies) add(`items/${digest([plan.namespace, command.knowledgeId]).slice(7)}.json`,
    applyKnowledgeWrite(undefined, command, plan.actor, plan.namespace, digest({ namespace: plan.namespace, actor: { actorKind: plan.actor.actorKind, actorId: plan.actor.actorId }, command })));
  for (const command of commands.entities) {
    const path = `entities/${command.analysisId}.json`, previous = result.get(path)?.at(-1) as EntityAnalysisEnvelope | undefined;
    add(path, applyEntityAnalysisWrite(previous, command, plan.actor, digest({ actor: plan.actor, command })));
  }
  for (const command of commands.associations) {
    const body = commands.bodies.find(item => item.knowledgeId === command.knowledgeId)!.revision;
    validateKnowledgeAssociationReferences(command.revision, body);
    for (const ref of command.revision.catalogRefs) {
      const catalog = result.get(`entities/${ref.analysisId}.json`)?.at(-1) as EntityAnalysisEnvelope | undefined;
      if (!catalog) refuse('Planned association has no qualified catalog.', 'corrupt');
      validateKnowledgeAssociationCatalogReferences(command.revision, body, catalog, ref.entityRevisionId);
    }
    add(`associations/${digest([plan.namespace, command.knowledgeId]).slice(7)}.json`,
      applyKnowledgeAssociationWrite(undefined, command, plan.actor, plan.namespace, digest({ namespace: plan.namespace, actor: plan.actor, command })));
  }
  const catalogs = [...result].filter(([path]) => path.startsWith('entities/'));
  if (catalogs.length > 4096 || catalogs.reduce((total, [, versions]) => total + Buffer.byteLength(JSON.stringify(versions.at(-1), null, 2)), 0) > 64 * 1024 * 1024) {
    refuse('Migrated entity catalog storage exceeds capacity.', 'capacity_exceeded');
  }
  return result;
}
function validatePlannedCapacity(plan: SourceMigrationPlan, data: Data) {
  const shape = layout(plan);
  if (shape.steps.length > MAX_RECEIPT_ENTRIES) refuse('Migration receipt step count exceeds capacity.', 'capacity_exceeded');
  let total = 0;
  const files = new Map<string, { bytes: number; digest: string }>(shape.entries);
  const captured = plan.sources.map(source => {
    const snapshotId = uuid(source.sourceVersion), snapshot = SourceSnapshotSchema.parse({ ...source.projection, snapshotId, sourceVersion: source.sourceVersion,
      capturedAt: '2000-01-01T00:00:00.000Z', excerpts: source.projection.excerpts.map((excerpt, index) => ({ ...excerpt, evidenceRef: `${snapshotId}:${index}` })) });
    const encoded = JSON.stringify({ storeKind: 'knowledge-source-snapshot', schemaVersion: 3, ...snapshot, snapshotDigest: digest(snapshot) }, null, 2), bytes = Buffer.byteLength(encoded);
    if (bytes > SOURCE_SNAPSHOT_MAX_BYTES || (total += bytes) > SOURCE_STORAGE_MAX_BYTES) refuse('Migrated sources exceed capacity.', 'capacity_exceeded');
    files.set(`sources/${snapshotId}.json`, { bytes, digest: sha(encoded) });
    return { old: source.old, snapshot };
  });
  for (const [path, versions] of expectedEnvelopes(plan, writes(plan, data, captured))) {
    const encoded = JSON.stringify(versions.at(-1), null, 2); files.set(path, { bytes: Buffer.byteLength(encoded), digest: sha(encoded) });
  }
  const directories = new Set<string>(), addParents = (path: string) => {
    let parent = path; while ((parent = dirname(parent)) !== '.') directories.add(parent);
  };
  for (const path of files.keys()) addParents(path);
  for (const path of plan.directories) { const archived = `${shape.prefix}/original/${path}`; directories.add(archived); addParents(archived); }
  // Random capture IDs and ISO times have the same encoded width as these placeholders. The final in-progress
  // receipt is the largest planned prefix; count and encode it before publishing even the ownership marker.
  encodeReceipt({ migrationKind: KIND, schemaVersion: 1, migrationId: plan.migrationId, planDigest: plan.planDigest, state: SOURCE_MIGRATION_IN_PROGRESS,
    completedSteps: shape.steps, files: [...files].map(([path, file]) => ({ path, bytes: file.bytes, digest: file.digest })), directories: [...directories] });
}

const receiptSchema = z.strictObject({ migrationKind: z.literal(KIND), schemaVersion: z.literal(1), migrationId: z.string().uuid(), planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  state: z.enum([SOURCE_MIGRATION_IN_PROGRESS, SOURCE_MIGRATION_COMPLETE]), completedSteps: z.array(z.string()).max(MAX_RECEIPT_ENTRIES),
  files: z.array(z.strictObject({ path: z.string(), bytes: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) })).max(MAX_RECEIPT_ENTRIES),
  directories: z.array(z.string()).max(MAX_RECEIPT_ENTRIES) });
function encodeReceipt(receipt: MigrationReceipt): string {
  if ([receipt.completedSteps, receipt.files, receipt.directories].some(entries => entries.length > MAX_RECEIPT_ENTRIES)) refuse('Migration receipt inventory exceeds capacity.', 'capacity_exceeded');
  const encoded = JSON.stringify(receiptSchema.parse(receipt), null, 2);
  if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) refuse('Migration receipt bytes exceed capacity.', 'capacity_exceeded');
  return encoded;
}
function temporaryBase(path: string): string | undefined {
  const match = /^(.*)\.([1-9][0-9]*)\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/u.exec(path);
  return match && Number.isSafeInteger(Number(match[2])) ? match[1] : undefined;
}
function validatePlanCapacity(plan: SourceMigrationPlan): void {
  // The complete CLI export has one trailing LF. Reserve it so every accepted plan can round-trip
  // through the same 128 MiB document reader; the archived plan keeps its original no-LF encoding.
  let bytes = 1; const active = new Set<object>();
  const add = (amount: number) => { bytes += amount; if (bytes > SOURCE_MIGRATION_PLAN_MAX_BYTES) refuse('Migration plan exceeds the 128 MiB capacity.', 'capacity_exceeded'); };
  const string = (value: string) => {
    add(2);
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16_384, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
      add(Buffer.byteLength(JSON.stringify(value.slice(start, end))) - 2); start = end;
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (typeof value === 'string') { string(value); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return; }
    if (!value || typeof value !== 'object' || active.has(value) || depth > 64) refuse('Migration plan must be finite plain JSON.', 'corrupt');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null || Object.getOwnPropertyDescriptor(value, 'toJSON')) refuse('Migration plan must be finite plain JSON.', 'corrupt');
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    active.add(value); add(2); let count = 0;
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property)) refuse('Migration plan must be finite plain JSON.', 'corrupt');
      if (!array && property.value === undefined) continue;
      add((count++ ? 2 : 1) + (depth + 1) * 2);
      if (!array) { string(key); add(2); }
      visit(property.value, depth + 1);
    }
    if (count) add(1 + depth * 2);
    active.delete(value);
  };
  visit(plan, 0);
}
function encodePlan(plan: SourceMigrationPlan): string {
  validatePlanCapacity(plan); return JSON.stringify(plan, null, 2);
}
function layout(plan: SourceMigrationPlan) {
  const prefix = `migration/${plan.migrationId}`, entries = new Map<string, { bytes: number; digest: string }>();
  const planBytes = Buffer.from(encodePlan(plan)); entries.set(`${prefix}/plan.json`, { bytes: planBytes.length, digest: sha(planBytes) });
  for (const file of plan.inventory) entries.set(`${prefix}/original/${file.path}`, file);
  entries.set(`${prefix}/matching-build/${basename(plan.matchingBuildArchivePath)}`, plan.matchingBuild);
  for (const path of plan.organizationalTagPaths) entries.set(path, plan.inventory.find(file => file.path === path)!);
  const steps = ['plan', 'directories', ...plan.inventory.map(file => `archive:${file.path}`), 'matching-build', ...plan.organizationalTagPaths.map(path => `tag:${path}`), 'sources',
    ...plan.bodies.map(item => `body:${item.requestId}`), ...plan.catalogs.flatMap(item => item.revisions.map(revision => `entity:${revision.requestId}`)),
    ...plan.associations.map(item => `association:${item.requestId}`)];
  return { prefix, entries, steps };
}
function discoverSources(plan: SourceMigrationPlan): Captured {
  const root = join(plan.targetRoot, 'sources'); if (!existsSync(root)) return [];
  const store = new FileSourceStore(root, plan.targetRoot), result: Captured = [];
  for (const name of readdirSync(root).filter(name => name.endsWith('.json')).sort()) {
    const resolution = store.read(name.slice(0, -5)); if (resolution.status !== 'available') refuse('Migrated source was deleted, edited or is unreadable.');
    const source = plan.sources.find(item => item.sourceVersion === resolution.snapshot.sourceVersion);
    if (!source || !same(source.projection, sourceSnapshotProjection(resolution.snapshot)) || result.some(item => same(item.old, source.old))) refuse('Target has unrelated or duplicate captured source data.');
    result.push({ old: source.old, snapshot: resolution.snapshot });
  }
  return result;
}
function verifyTarget(plan: SourceMigrationPlan, data: Data, input: unknown, context?: SourceMigrationWriteContext): { receipt: MigrationReceipt; captured: Captured } {
  const receipt = receiptSchema.parse(input), { entries, steps, prefix } = layout(plan);
  encodeReceipt(receipt);
  if (receipt.migrationId !== plan.migrationId || receipt.planDigest !== plan.planDigest
    || !same(receipt.completedSteps, steps.slice(0, receipt.completedSteps.length))) refuse('Migration receipt does not belong to this exact plan.');
  const current = inventory(plan.targetRoot, true, context), captured = discoverSources(plan), mapped = captured.length === plan.sources.length;
  if (receipt.completedSteps.includes('sources') && !mapped) refuse('A previously captured migration source was removed.');
  const expected = mapped ? expectedEnvelopes(plan, writes(plan, data, captured)) : new Map<string, unknown[]>();
  const sourcePaths = new Set(captured.map(item => `sources/${item.snapshot.snapshotId}.json`));
  const allowed = new Set([...entries.keys(), ...expected.keys(), ...sourcePaths, SOURCE_MIGRATION_STATE_FILE]);
  const allowedDirs = new Set<string>(['sources', 'items', 'entities', 'associations', 'tags', 'migration', prefix, `${prefix}/original`, `${prefix}/matching-build`]);
  for (const path of [...allowed, ...plan.directories.map(path => `${prefix}/original/${path}`)]) {
    let parent = path; if (plan.directories.some(directory => `${prefix}/original/${directory}` === path)) allowedDirs.add(path);
    while ((parent = dirname(parent)) !== '.') allowedDirs.add(parent);
  }
  const oldFiles = new Map(receipt.files.map(file => [file.path, file]));
  for (const file of current.files) {
    const temporary = temporaryBase(file.path);
    if (temporary) {
      const sourceTemporary = /^sources\/[a-f0-9-]{36}\.json$/u.test(temporary);
      if (!allowed.has(temporary) && !sourceTemporary) refuse('Target contains an unrelated temporary file.');
    } else if (!allowed.has(file.path)) refuse('Target contains unrelated user data.');
    const exact = entries.get(file.path);
    if (exact && (file.bytes !== exact.bytes || file.digest !== exact.digest)) refuse('Archived migration or organization bytes were edited.');
    const versions = expected.get(file.path);
    if (versions && !versions.some(value => sha(JSON.stringify(value, null, 2)) === file.digest)) refuse('Migrated body, catalog or projection has user changes.');
    const old = oldFiles.get(file.path);
    if (old && !versions && !same(old, file)) refuse('Previously acknowledged migration bytes were edited.');
  }
  const paths = new Set(current.files.map(file => file.path));
  for (const file of receipt.files) { safeRelative(file.path); if (!paths.has(file.path)) refuse('Previously acknowledged migration output was deleted.'); }
  for (const path of current.directories) if (!allowedDirs.has(path)) refuse('Target contains an unrelated directory.');
  for (const path of receipt.directories) { safeRelative(path); if (!current.directories.includes(path)) refuse('Previously acknowledged migration directory was deleted.'); }
  if (mapped) {
    const commands = writes(plan, data, captured);
    for (const [path, versions] of expected) {
      const file = current.files.find(file => file.path === path), index = file ? versions.findIndex(value => sha(JSON.stringify(value, null, 2)) === file.digest) : -1;
      const ids = path.startsWith('entities/') ? commands.entities.filter(command => `entities/${command.analysisId}.json` === path).map(command => `entity:${command.requestId}`)
        : path.startsWith('items/') ? commands.bodies.filter(command => `items/${digest([plan.namespace, command.knowledgeId]).slice(7)}.json` === path).map(command => `body:${command.requestId}`)
          : commands.associations.filter(command => `associations/${digest([plan.namespace, command.knowledgeId]).slice(7)}.json` === path).map(command => `association:${command.requestId}`);
      if (ids.some((id, ordinal) => receipt.completedSteps.includes(id) && index < ordinal)) refuse('An acknowledged CAS revision was removed or rolled back.');
      if (receipt.state === SOURCE_MIGRATION_COMPLETE && index !== versions.length - 1) refuse('Completed migration output was edited or deleted.');
    }
  }
  if (receipt.state === SOURCE_MIGRATION_COMPLETE && (!same(receipt.completedSteps, steps)
    || !same(receipt.files, current.files.filter(file => file.path !== SOURCE_MIGRATION_STATE_FILE)) || !same(receipt.directories, current.directories))) refuse('Completed migration inventory changed.');
  return { receipt, captured };
}
function recoverTargetLocks(plan: SourceMigrationPlan) {
  const paths = ['.knowledge-write.lock', 'sources/.write.lock',
    ...plan.bodies.map(item => `items/${digest([plan.namespace, item.old.knowledgeId]).slice(7)}.json.lock`),
    ...plan.catalogs.map(item => `entities/${item.analysisId}.json.lock`),
    ...plan.associations.map(item => `associations/${digest([plan.namespace, item.knowledgeId]).slice(7)}.json.lock`)];
  // Only locks used by this exact migration's stores can be recovered. Unrelated user locks remain untouched.
  for (const path of paths) {
    const selected = join(plan.targetRoot, path), parent = dirname(selected);
    if (!existsSync(parent)) continue;
    if (canonicalRoot(parent, true) !== parent) refuse('Migration lock parent binding changed.');
    recoverStorageLock(selected);
  }
}
export interface SourceMigrationResult {
  migrationId: string; planDigest: string; state: typeof SOURCE_MIGRATION_COMPLETE; pending: true;
  sources: { old: SourceRef; current: SourceRef; excerptMap: { oldEvidenceRef: string; evidenceRef: string; oldTextDigest: string; newTextDigest: string; utf16Exact: true }[] }[];
  bodies: { old: KnowledgeBodyRef; current: KnowledgeBodyRef }[];
  catalogs: SourceMigrationPlan['catalogs']; associations: SourceMigrationPlan['associations']; archiveRoot: string;
}
/** Writes only the independent target. Per-step receipts and underlying CAS make exact retries safe; publication is not batch-atomic. */
export function applySourceMigration(input: SourceMigrationPlan, expectedPlanDigest: string, options: { signal?: AbortSignal } = {}): SourceMigrationResult {
  options.signal?.throwIfAborted();
  encodePlan(input);
  const prepared = prepare(input, false), plan = prepared.plan, data = prepared.data;
  if (input.planDigest !== expectedPlanDigest || plan.planDigest !== expectedPlanDigest || !same(input, plan)) refuse('Migration plan digest or derived mapping changed.');
  if (canonicalRoot(plan.targetRoot, false) !== plan.targetRoot) refuse('Target root binding changed after preflight.');
  mkdirSync(plan.targetRoot, { recursive: true });
  if (canonicalRoot(plan.targetRoot, true) !== plan.targetRoot) refuse('Target root binding changed before migration locking.');
  return withSourceMigrationWorkspaceWrite(plan.targetRoot, { migrationId: plan.migrationId, planDigest: plan.planDigest }, context => {
    recoverTargetLocks(plan);
    const statePath = join(plan.targetRoot, SOURCE_MIGRATION_STATE_FILE), shape = layout(plan);
    let receipt: MigrationReceipt;
    if (existsSync(statePath)) receipt = verifyTarget(plan, data, JSON.parse(stableBytes(statePath).toString('utf8')), context).receipt;
    else {
      if (readdirSync(plan.targetRoot).some(name => name !== SOURCE_MIGRATION_LOCK_FILE && name !== WORKSPACE_LOCK_FILE)) refuse('Target acquired unrelated data after preflight.');
      receipt = { migrationKind: KIND, schemaVersion: 1, migrationId: plan.migrationId, planDigest: plan.planDigest, state: SOURCE_MIGRATION_IN_PROGRESS, completedSteps: [], files: [], directories: [] };
      publishKnowledgeBytes(statePath, encodeReceipt(receipt), plan.targetRoot, true);
    }
    assertSourceMigrationWriteContext(plan.targetRoot, context);
    const ensure = (relativePath: string, bytes: Uint8Array | string) => {
      options.signal?.throwIfAborted(); const path = join(plan.targetRoot, relativePath), expected = Buffer.from(bytes);
      if (existsSync(path)) { if (!stableBytes(path).equals(expected)) refuse('Target migration bytes were edited.'); confirmKnowledgePublication(path, plan.targetRoot); }
      else publishKnowledgeBytes(path, expected, plan.targetRoot, true);
    };
    const checkpoint = (step: string, operation: () => void) => {
      options.signal?.throwIfAborted(); if (receipt.completedSteps.includes(step)) return;
      if (shape.steps[receipt.completedSteps.length] !== step) refuse('Migration step ordering changed.');
      operation(); const current = inventory(plan.targetRoot, true, context);
      receipt = { ...receipt, completedSteps: [...receipt.completedSteps, step], files: current.files.filter(file => file.path !== SOURCE_MIGRATION_STATE_FILE), directories: current.directories };
      publishKnowledgeBytes(statePath, encodeReceipt(receipt), plan.targetRoot, false);
    };
    try {
      if (receipt.state !== SOURCE_MIGRATION_COMPLETE) {
        checkpoint('plan', () => ensure(`${shape.prefix}/plan.json`, encodePlan(plan)));
        checkpoint('directories', () => { for (const path of plan.directories) mkdirSync(join(plan.archiveRoot, 'original', path), { recursive: true }); });
        for (const file of plan.inventory) checkpoint(`archive:${file.path}`, () => {
          const bytes = stableBytes(join(plan.sourceRoot, file.path)); if (sha(bytes) !== file.digest || bytes.length !== file.bytes) refuse('Original bytes changed during migration.');
          ensure(`${shape.prefix}/original/${file.path}`, bytes);
        });
        checkpoint('matching-build', () => { const bytes = stableBytes(plan.matchingBuildArchivePath);
          if (sha(bytes) !== plan.matchingBuild.digest || bytes.length !== plan.matchingBuild.bytes) refuse('Matching-build archive changed.');
          ensure(`${shape.prefix}/matching-build/${basename(plan.matchingBuildArchivePath)}`, bytes);
        });
        for (const path of plan.organizationalTagPaths) checkpoint(`tag:${path}`, () => ensure(path, stableBytes(join(plan.sourceRoot, path))));
        checkpoint('sources', () => {
          if (plan.sources.length) new FileSourceStore(join(plan.targetRoot, 'sources'), plan.targetRoot, context).captureBatch(plan.sources.map(source => source.projection), { signal: options.signal });
        });
      }
      const captured = discoverSources(plan); if (captured.length !== plan.sources.length) refuse('Migration source publication is incomplete.');
      const commands = writes(plan, data, captured), knowledge = new FileKnowledgeStore(join(plan.targetRoot, 'items'), plan.namespace, plan.targetRoot, context);
      const entities = new FileEntityAnalysisStore(join(plan.targetRoot, 'entities'), plan.targetRoot, context);
      const associations = new FileKnowledgeAssociationStore(join(plan.targetRoot, 'associations'), plan.namespace, knowledge, entities, plan.targetRoot, context);
      if (receipt.state !== SOURCE_MIGRATION_COMPLETE) {
        for (const command of commands.bodies) checkpoint(`body:${command.requestId}`, () => { knowledge.write(command, plan.actor); });
        for (const command of commands.entities) checkpoint(`entity:${command.requestId}`, () => { entities.write(command, plan.actor); });
        for (const command of commands.associations) checkpoint(`association:${command.requestId}`, () => { associations.write(command, plan.actor); });
        verifyTarget(plan, data, receipt, context);
        if (!same(inventory(plan.sourceRoot), { files: plan.inventory, directories: plan.directories })) refuse('Original workspace fingerprint changed before completion.');
        receipt = { ...receipt, state: SOURCE_MIGRATION_COMPLETE };
        publishKnowledgeBytes(statePath, encodeReceipt(receipt), plan.targetRoot, false);
      }
      verifyTarget(plan, data, receipt, context);
      return { migrationId: plan.migrationId, planDigest: plan.planDigest, state: SOURCE_MIGRATION_COMPLETE, pending: true,
        sources: captured.map(item => { const old = data.windows.find(window => same({ snapshotId: window.snapshotId, sourceVersion: window.sourceVersion }, item.old))!;
          return { old: item.old, current: { snapshotId: item.snapshot.snapshotId, sourceVersion: item.snapshot.sourceVersion }, excerptMap: old.excerpts.map((excerpt, index) => ({ oldEvidenceRef: excerpt.evidenceRef,
            evidenceRef: item.snapshot.excerpts[index].evidenceRef, oldTextDigest: sha(excerpt.text), newTextDigest: sha(item.snapshot.excerpts[index].text), utf16Exact: true as const })) }; }),
        bodies: commands.bodies.map(command => ({ old: plan.bodies.find(body => body.old.knowledgeId === command.knowledgeId)!.old, current: knowledgeBodyRef(command.revision) })),
        catalogs: plan.catalogs, associations: plan.associations, archiveRoot: plan.archiveRoot };
    } finally { if (!same(inventory(plan.sourceRoot), { files: plan.inventory, directories: plan.directories })) {
      if (receipt.state === SOURCE_MIGRATION_COMPLETE) { receipt = { ...receipt, state: SOURCE_MIGRATION_IN_PROGRESS };
        publishKnowledgeBytes(statePath, encodeReceipt(receipt), plan.targetRoot, false); }
      refuse('Original workspace fingerprint changed during migration.');
    } }
  });
}
