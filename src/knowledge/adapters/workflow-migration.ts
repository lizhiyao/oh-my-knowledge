import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertSourceMigrationComplete, assertSourceMigrationWriteContext, SOURCE_MIGRATION_STATE_FILE,
  SOURCE_MIGRATION_LOCK_FILE, WORKSPACE_LOCK_FILE, withSourceMigrationWorkspaceWrite,
  type SourceMigrationWriteContext } from '../../evidence/storage/knowledge-workspace.js';
import { KnowledgeActorSchema, type EvidenceSelection } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { validateKnowledgeAssociationCatalogReferences } from '../entities/association-references.js';
import { validateKnowledgeReviewReferences } from '../review-history.js';
import { FileKnowledgeAssociationStore } from './association-store.js';
import { confirmKnowledgePublication, publishKnowledgeBytes } from './durable-publication.js';
import { FileEntityAnalysisStore } from './entity-store.js';
import { FileKnowledgeTags } from './knowledge-tags.js';
import { FileKnowledgeStore } from './knowledge-store.js';
import { FileKnowledgeReviewStore } from './review-store.js';
import { FileSourceStore } from './source-store.js';

const KIND = 'knowledge-workflow3-to4' as const;
const MAX_FILES = 16_384, MAX_BYTES = 512 * 1024 * 1024, MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const activeRoots = new Set(['sources', 'items', 'entities', 'associations', 'reviews', 'tags']);
const archiveRoots = new Set(['generation-journals', 'auto-extraction', 'migration']);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const sha = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digest = (value: unknown) => sha(canonicalJson(value));
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const pathText = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const fileSchema = z.strictObject({ path: pathText, bytes: z.number().int().nonnegative().max(MAX_BYTES), digest: z.string().regex(digestPattern) });
const inputSchema = z.strictObject({ migrationId: z.string().uuid(), sourceRoot: pathText, targetRoot: pathText,
  namespace: z.string().min(1).max(256).refine(value => !!value.trim()), actor: KnowledgeActorSchema,
  at: z.iso.datetime({ offset: true }), matchingBuildArchivePath: pathText, matchingBuildId: z.string().min(1).max(512) });
const planSchema = inputSchema.extend({ migrationKind: z.literal(KIND), schemaVersion: z.literal(1), planDigest: z.string().regex(digestPattern),
  archiveRoot: pathText, inventory: z.array(fileSchema).max(MAX_FILES), directories: z.array(pathText).max(MAX_FILES),
  activePaths: z.array(pathText).max(MAX_FILES), matchingBuild: fileSchema.omit({ path: true }) });
const receiptSchema = z.strictObject({ migrationKind: z.literal(KIND), schemaVersion: z.literal(1), migrationId: z.string().uuid(),
  planDigest: z.string().regex(digestPattern), state: z.enum(['in_progress', 'complete']), generation: z.number().int().positive(),
  completedSteps: z.array(z.string().min(1).max(8192)).max(MAX_FILES * 2 + 3) });
export type KnowledgeWorkflowMigrationInput = z.infer<typeof inputSchema>;
export type KnowledgeWorkflowMigrationPlan = z.infer<typeof planSchema>;
type FileEntry = z.infer<typeof fileSchema>;
type Receipt = z.infer<typeof receiptSchema>;
export class KnowledgeWorkflowMigrationError extends Error {
  constructor(readonly code: 'unsupported' | 'corrupt' | 'conflict' | 'capacity_exceeded', message: string) {
    super(message); this.name = 'KnowledgeWorkflowMigrationError';
  }
}
function refuse(message: string, code: KnowledgeWorkflowMigrationError['code'] = 'conflict'): never {
  throw new KnowledgeWorkflowMigrationError(code, message);
}
function encode(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) + 1 > MAX_DOCUMENT_BYTES) refuse('Workflow migration document capacity exceeded.', 'capacity_exceeded');
  return text;
}
function safeRelative(path: string) {
  if (!path || isAbsolute(path) || path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) refuse('Invalid workflow migration relative path.');
}
function rootPath(path: string, required: boolean): string {
  if (!isAbsolute(path)) refuse('Explicit absolute workflow migration paths are required.');
  const absolute = resolve(path);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (required) refuse('Workflow migration source root is missing.');
    return join(rootPath(dirname(absolute), false), basename(absolute));
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) refuse('Workflow migration roots refuse symbolic paths.');
  return absolute;
}
function separate(source: string, target: string) {
  for (const [a, b] of [[source, target], [target, source]]) {
    const local = relative(a, b);
    if (!local || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) refuse('Workflow migration roots must be separate.');
  }
  if (existsSync(target)) {
    const left = lstatSync(source), right = lstatSync(target);
    if (left.dev === right.dev && left.ino === right.ino) refuse('Workflow migration roots share an inode.');
  }
}
function bytes(path: string): Buffer {
  if (realpathSync(path) !== resolve(path)) refuse('Workflow migration reads refuse symbolic paths.');
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) refuse('Workflow migration requires ordinary files.');
  if (before.size > BigInt(MAX_BYTES)) refuse('Workflow migration file capacity exceeded.', 'capacity_exceeded');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true }), buffer = Buffer.allocUnsafe(Number(before.size) + 1); let count = 0;
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) refuse('Workflow migration input identity changed.');
    while (count < buffer.length) { const read = readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read; }
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (realpathSync(path) !== resolve(path) || count !== Number(before.size) || [opened, after, named].some(stat => !stat.isFile() || stat.isSymbolicLink()
      || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs)) refuse('Workflow migration input changed during read.');
    return buffer.subarray(0, count);
  } finally { closeSync(fd); }
}
function inventory(root: string, context?: SourceMigrationWriteContext, target = false) {
  if (context) assertSourceMigrationWriteContext(root, context);
  const files: FileEntry[] = [], directories: string[] = []; let total = 0;
  const walk = (directory: string) => {
    if (rootPath(directory, true) !== directory) refuse('Workflow migration directory identity changed.');
    for (const name of readdirSync(directory).sort()) {
      if (context && directory === root && [SOURCE_MIGRATION_LOCK_FILE, WORKSPACE_LOCK_FILE].includes(name)) continue;
      const path = join(directory, name), local = relative(root, path).split(sep).join('/'); safeRelative(local);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || name.endsWith('.lock') || name.endsWith('.tmp')) refuse('Workflow migration refuses symbolic or unfinished entries.');
      if (stat.isDirectory()) {
        if (directories.length >= MAX_FILES * (target ? 3 : 1)) refuse('Workflow migration directory capacity exceeded.', 'capacity_exceeded');
        directories.push(local); walk(path);
      } else {
        if (target && stat.nlink !== 1) refuse('Workflow migration target refuses shared file inodes.');
        const content = bytes(path); total += content.length;
        if (files.length >= MAX_FILES * (target ? 2 : 1) + (target ? 4 : 0) || total > MAX_BYTES * (target ? 3 : 1) + (target ? MAX_DOCUMENT_BYTES * 2 : 0)) refuse('Workflow migration inventory capacity exceeded.', 'capacity_exceeded');
        files.push({ path: local, bytes: content.length, digest: sha(content) });
      }
    }
  };
  walk(root); return { files, directories };
}
function validateCurrent(root: string, namespace: string, files: FileEntry[], directories: string[], context?: SourceMigrationWriteContext) {
  if (context) assertSourceMigrationWriteContext(root, context); else assertSourceMigrationComplete(root);
  for (const path of [...files.map(file => file.path), ...directories]) {
    const first = path.split('/')[0];
    if (activeRoots.has(first)) {
      if (path !== first && (dirname(path) !== first || !path.endsWith('.json') || directories.includes(path))) refuse('Unsupported active workflow migration entry.', 'unsupported');
    } else if (!archiveRoots.has(first) && path !== SOURCE_MIGRATION_STATE_FILE
      && !(directories.includes(path) && !files.some(file => file.path.startsWith(`${path}/`)))) refuse('Unsupported workflow migration entry.', 'unsupported');
  }
  const sources = new FileSourceStore(join(root, 'sources'), root); sources.assertCurrentFormat();
  const knowledge = new FileKnowledgeStore(join(root, 'items'), namespace, root), bodies = knowledge.list();
  const entities = new FileEntityAnalysisStore(join(root, 'entities'), root), catalogs = entities.list();
  if (catalogs.unavailable) refuse('Workflow migration entity history is unavailable.', 'corrupt');
  const selections = (source: { snapshotId: string; sourceVersion: string }, selection: EvidenceSelection) => {
    const found = sources.read(source.snapshotId, source.sourceVersion);
    const excerpt = found.status === 'available' && found.snapshot.excerpts.find(excerpt => excerpt.evidenceRef === selection.evidenceRef);
    if (!excerpt || selection.end - selection.start !== selection.quote.length || excerpt.text.slice(selection.start, selection.end) !== selection.quote) refuse('Workflow migration source evidence mismatch.', 'corrupt');
  };
  for (const history of bodies) for (const body of history.revisions) for (const segment of body.content.segments) for (const evidence of segment.evidence) selections(evidence.source, evidence.selection);
  for (const catalog of catalogs.histories) for (const revision of catalog.revisions) for (const mention of revision.mentions) selections(catalog, mention.selection);
  const associations = new FileKnowledgeAssociationStore(join(root, 'associations'), namespace, knowledge, entities, root).list();
  for (const history of associations) for (const revision of history.revisions) {
    const body = knowledge.read(history.knowledgeId).revisions.find(body => body.revisionId === revision.bodyRef.revisionId)!;
    for (const ref of revision.catalogRefs) validateKnowledgeAssociationCatalogReferences(revision, body, entities.read(ref.analysisId), ref.entityRevisionId);
  }
  for (const file of files.filter(file => ['reviews', 'tags'].includes(dirname(file.path)))) {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(join(root, file.path)))) as { knowledgeId?: unknown };
    const id = z.string().min(1).max(256).parse(value.knowledgeId);
    if (file.path !== `${dirname(file.path)}/${digest([namespace, id]).slice(7)}.json`) refuse('Workflow migration organization filename mismatch.', 'corrupt');
    const history = knowledge.read(id);
    if (dirname(file.path) === 'tags') { new FileKnowledgeTags(join(root, 'tags'), namespace, root).read(id); continue; }
    const reviews = new FileKnowledgeReviewStore(join(root, 'reviews'), namespace, root).read(id)!;
    for (const event of reviews.events) {
      const body = history.revisions.find(body => body.revisionId === event.bodyRef.revisionId);
      if (!body) refuse('Workflow migration review body is unavailable.', 'corrupt');
      const projection = event.eventKind === 'association_coverage' && event.projectionRevisionId !== null
        ? associations.find(value => value.knowledgeId === id)?.revisions.find(value => value.revisionId === event.projectionRevisionId) : undefined;
      validateKnowledgeReviewReferences(event, body, projection);
      if (event.eventKind === 'content_review') event.findings.flatMap(finding => finding.evidence).forEach(evidence => selections(evidence.source, evidence.selection));
      if (event.eventKind === 'task_use') event.evidence.forEach(evidence => selections(evidence.source, evidence.selection));
    }
  }
}
function layout(plan: KnowledgeWorkflowMigrationPlan) {
  const prefix = `migration/${plan.migrationId}`, entries = new Map<string, FileEntry & { step: string }>();
  const add = (path: string, entry: Omit<FileEntry, 'path'>, step: string) => entries.set(path, { ...entry, path, step });
  const planBytes = encode(plan); add(`${prefix}/plan.json`, { bytes: Buffer.byteLength(planBytes), digest: sha(planBytes) }, 'plan');
  for (const file of plan.inventory) add(`${prefix}/original/${file.path}`, file, `archive:${file.path}`);
  add(`${prefix}/matching-build/${basename(plan.matchingBuildArchivePath)}`, plan.matchingBuild, 'matching-build');
  for (const path of plan.activePaths) add(path, plan.inventory.find(file => file.path === path)!, `active:${path}`);
  const steps = ['plan', 'directories', ...plan.inventory.map(file => `archive:${file.path}`), 'matching-build', ...plan.activePaths.map(path => `active:${path}`)];
  const directories = new Set<string>([`${prefix}/original`]);
  for (const path of plan.directories) {
    directories.add(`${prefix}/original/${path}`);
    if (activeRoots.has(path.split('/')[0])) directories.add(path);
  }
  for (const path of [...entries.keys(), ...directories]) {
    let parent = path; while ((parent = dirname(parent)) !== '.') directories.add(parent);
  }
  return { entries, steps, directories };
}
function confirmDirectories(root: string, paths: Iterable<string>) {
  for (const path of [...paths].sort((a, b) => b.length - a.length).map(path => join(root, path)).concat(root)) {
    const before = lstatSync(path), fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isDirectory() || opened.ino !== before.ino || opened.dev !== before.dev) refuse('Workflow migration directory changed before confirmation.');
      fsyncSync(fd); const after = lstatSync(path);
      if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev) refuse('Workflow migration directory changed during confirmation.');
    } finally { closeSync(fd); }
  }
}
function checkedReceipt(plan: KnowledgeWorkflowMigrationPlan): Receipt {
  const raw = bytes(join(plan.targetRoot, SOURCE_MIGRATION_STATE_FILE));
  if (raw.length > MAX_DOCUMENT_BYTES) refuse('Workflow migration receipt capacity exceeded.', 'capacity_exceeded');
  const receipt = receiptSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))), { steps } = layout(plan);
  if (receipt.migrationId !== plan.migrationId || receipt.planDigest !== plan.planDigest
    || !same(receipt.completedSteps, steps.slice(0, receipt.completedSteps.length))
    || receipt.generation !== receipt.completedSteps.length + (receipt.state === 'complete' ? 2 : 1)
    || receipt.state === 'complete' && receipt.completedSteps.length !== steps.length) refuse('Workflow migration target belongs to another plan or invalid receipt.');
  return receipt;
}
function verifyTarget(plan: KnowledgeWorkflowMigrationPlan, receipt: Receipt, context?: SourceMigrationWriteContext) {
  const current = inventory(plan.targetRoot, context, true), shape = layout(plan), present = new Set(current.files.map(file => file.path));
  for (const file of current.files) {
    if (file.path === SOURCE_MIGRATION_STATE_FILE) continue;
    const expected = shape.entries.get(file.path);
    if (!expected || file.bytes !== expected.bytes || file.digest !== expected.digest) refuse('Workflow migration target was edited or contains unrelated data.');
  }
  for (const entry of shape.entries.values()) if ((receipt.state === 'complete' || receipt.completedSteps.includes(entry.step)) && !present.has(entry.path)) refuse('Acknowledged workflow migration output was deleted.');
  if (current.directories.some(path => !shape.directories.has(path))) refuse('Workflow migration target contains an unrelated directory.');
  if (receipt.completedSteps.includes('directories') && [...shape.directories].some(path => !current.directories.includes(path))) refuse('Acknowledged workflow migration directory was deleted.');
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
function prepare(input: KnowledgeWorkflowMigrationInput, checkTarget: boolean): KnowledgeWorkflowMigrationPlan {
  const fixed = inputSchema.parse(input);
  if (!fixed.actor.actorId.trim() || fixed.actor.actorKind === 'agent' && !fixed.actor.executionRef.trim()) refuse('An actual workflow migration actor is required.');
  const sourceRoot = rootPath(fixed.sourceRoot, true), targetRoot = rootPath(fixed.targetRoot, false); separate(sourceRoot, targetRoot);
  if (!isAbsolute(fixed.matchingBuildArchivePath) || !/\.(?:tgz|tar\.gz|tar|zip)$/iu.test(fixed.matchingBuildArchivePath)) refuse('An installable matching build archive is required.');
  const matchingBuildArchivePath = resolve(fixed.matchingBuildArchivePath), local = relative(targetRoot, matchingBuildArchivePath);
  if (!local || local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) refuse('Matching build archive must be outside the migration target.');
  const original = inventory(sourceRoot); validateCurrent(sourceRoot, fixed.namespace, original.files, original.directories);
  const build = bytes(matchingBuildArchivePath); if (!build.length) refuse('Matching build archive is empty.', 'unsupported');
  const payload = { ...fixed, sourceRoot, targetRoot, matchingBuildArchivePath, migrationKind: KIND, schemaVersion: 1 as const,
    archiveRoot: join(targetRoot, 'migration', fixed.migrationId), inventory: original.files, directories: original.directories,
    activePaths: original.files.filter(file => activeRoots.has(file.path.split('/')[0])).map(file => file.path),
    matchingBuild: { bytes: build.length, digest: sha(build) } };
  const plan = planSchema.parse({ ...payload, planDigest: digest(payload) }); encode(plan);
  const shape = layout(plan);
  encode(receiptSchema.parse({ migrationKind: KIND, schemaVersion: 1, migrationId: plan.migrationId, planDigest: plan.planDigest,
    state: 'complete', generation: shape.steps.length + 2, completedSteps: shape.steps }));
  if (!same(original, inventory(sourceRoot))) refuse('Workflow migration original changed during preflight.');
  if (checkTarget && existsSync(targetRoot) && readdirSync(targetRoot).length) {
    if (!existsSync(join(targetRoot, SOURCE_MIGRATION_STATE_FILE))) refuse('Workflow migration target contains unrelated data.');
    verifyTarget(plan, checkedReceipt(plan));
  }
  return freeze(plan);
}
/** Read-only, bounded preflight for current Source3; old execution records are never decoded or resumed. */
export function planKnowledgeWorkflowMigration(input: KnowledgeWorkflowMigrationInput): KnowledgeWorkflowMigrationPlan { return prepare(input, true); }
export interface KnowledgeWorkflowMigrationResult {
  migrationId: string; planDigest: string; state: 'complete'; archiveRoot: string; preservedFiles: number;
}
/** Exact-plan copy only. Completed or unknown native stages are immutable archive data, not new work. */
export function applyKnowledgeWorkflowMigration(input: KnowledgeWorkflowMigrationPlan, expectedPlanDigest: string,
  options: { signal?: AbortSignal } = {}): KnowledgeWorkflowMigrationResult {
  options.signal?.throwIfAborted();
  const supplied = planSchema.parse(input); encode(supplied);
  const { migrationKind: _kind, schemaVersion: _version, planDigest: _digest, archiveRoot: _archive, inventory: _inventory,
    directories: _directories, activePaths: _active, matchingBuild: _build, ...base } = supplied;
  void _kind; void _version; void _digest; void _archive; void _inventory; void _directories; void _active; void _build;
  const plan = prepare(base, false);
  if (plan.planDigest !== expectedPlanDigest || supplied.planDigest !== expectedPlanDigest || !same(supplied, plan)) refuse('Workflow migration plan or original input changed.');
  if (rootPath(plan.targetRoot, false) !== plan.targetRoot) refuse('Workflow migration target binding changed.');
  mkdirSync(plan.targetRoot, { recursive: true, mode: 0o700 });
  if (rootPath(plan.targetRoot, true) !== plan.targetRoot) refuse('Workflow migration target binding changed.');
  return withSourceMigrationWorkspaceWrite(plan.targetRoot, plan, context => {
    const statePath = join(plan.targetRoot, SOURCE_MIGRATION_STATE_FILE), shape = layout(plan);
    let receipt: Receipt;
    if (existsSync(statePath)) { receipt = checkedReceipt(plan); verifyTarget(plan, receipt, context); }
    else {
      if (readdirSync(plan.targetRoot).some(name => ![SOURCE_MIGRATION_LOCK_FILE, WORKSPACE_LOCK_FILE].includes(name))) refuse('Workflow migration target is not owned by this plan.');
      receipt = { migrationKind: KIND, schemaVersion: 1, migrationId: plan.migrationId, planDigest: plan.planDigest, state: 'in_progress', generation: 1, completedSteps: [] };
      publishKnowledgeBytes(statePath, encode(receipt), plan.targetRoot, true);
    }
    const ensure = (path: string, content: Uint8Array | string) => {
      options.signal?.throwIfAborted(); assertSourceMigrationWriteContext(plan.targetRoot, context);
      const output = join(plan.targetRoot, path), value = Buffer.from(content);
      if (existsSync(output)) { if (!bytes(output).equals(value)) refuse('Workflow migration target was edited.'); confirmKnowledgePublication(output, plan.targetRoot); }
      else publishKnowledgeBytes(output, value, plan.targetRoot, true);
    };
    const save = (next: Receipt) => {
      if (!same(checkedReceipt(plan), receipt)) refuse('Workflow migration receipt changed.');
      assertSourceMigrationWriteContext(plan.targetRoot, context);
      publishKnowledgeBytes(statePath, encode(receiptSchema.parse(next)), plan.targetRoot, false); receipt = next;
    };
    const checkpoint = (step: string, operation: () => void) => {
      options.signal?.throwIfAborted(); if (receipt.completedSteps.includes(step)) return;
      if (shape.steps[receipt.completedSteps.length] !== step) refuse('Workflow migration step ordering changed.');
      operation(); save({ ...receipt, generation: receipt.generation + 1, completedSteps: [...receipt.completedSteps, step] });
    };
    try {
      if (receipt.state !== 'complete') {
        checkpoint('plan', () => ensure(`migration/${plan.migrationId}/plan.json`, encode(plan)));
        checkpoint('directories', () => {
          for (const path of shape.directories) mkdirSync(join(plan.targetRoot, path), { recursive: true, mode: 0o700 });
          confirmDirectories(plan.targetRoot, shape.directories);
        });
        for (const file of plan.inventory) checkpoint(`archive:${file.path}`, () => {
          const original = bytes(join(plan.sourceRoot, file.path));
          if (original.length !== file.bytes || sha(original) !== file.digest) refuse('Workflow migration original changed during copy.');
          ensure(`migration/${plan.migrationId}/original/${file.path}`, original);
        });
        checkpoint('matching-build', () => {
          const build = bytes(plan.matchingBuildArchivePath);
          if (build.length !== plan.matchingBuild.bytes || sha(build) !== plan.matchingBuild.digest) refuse('Matching build archive changed.');
          ensure(`migration/${plan.migrationId}/matching-build/${basename(plan.matchingBuildArchivePath)}`, build);
        });
        for (const path of plan.activePaths) checkpoint(`active:${path}`, () => ensure(path, bytes(join(plan.targetRoot, 'migration', plan.migrationId, 'original', path))));
        verifyTarget(plan, receipt, context);
        if (!same(inventory(plan.sourceRoot), { files: plan.inventory, directories: plan.directories })) refuse('Workflow migration original changed before completion.');
        validateCurrent(plan.targetRoot, plan.namespace, plan.activePaths.map(path => plan.inventory.find(file => file.path === path)!), [...shape.directories].filter(path => activeRoots.has(path.split('/')[0])), context);
        save({ ...receipt, state: 'complete', generation: receipt.generation + 1 });
      }
      verifyTarget(plan, receipt, context);
      return { migrationId: plan.migrationId, planDigest: plan.planDigest, state: 'complete', archiveRoot: plan.archiveRoot, preservedFiles: plan.activePaths.length };
    } finally {
      let unchanged = false;
      try { unchanged = same(inventory(plan.sourceRoot), { files: plan.inventory, directories: plan.directories }); } catch { /* Unavailable originals also invalidate completion. */ }
      if (!unchanged) {
        if (receipt.state === 'complete') save({ ...receipt, state: 'in_progress', generation: receipt.generation - 1 });
        refuse('Workflow migration original changed during migration.');
      }
    }
  });
}
