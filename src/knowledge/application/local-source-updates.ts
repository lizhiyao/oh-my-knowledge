import { lstatSync, opendirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkStorageDirectory } from '../../evidence/storage/knowledge-workspace.js';
import { SourceUpdatesService, type SourceCurrentReadResult, type SourceUpdateInventory } from './source-updates.js';
import { canonicalJson, type KnowledgeEnvelope } from '../store.js';
import { ResolvedSourceSelectionSchema, type SourceRef, type SourceSnapshot } from '../sources.js';
import { FileSourceStore } from '../adapters/source-store.js';
import { createLocalSourceReader, LocalSourceScopeSchema, type LocalSourceScope } from './local-source-host.js';
import { ProjectSourceReadError } from '../adapters/project-source-reader.js';
import { TraceSourceReadError } from '../adapters/trace-source-reader.js';
import { FileKnowledgeStore } from '../adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../adapters/association-store.js';
import { knowledgeBodyRef } from '../adapters/body-digest.js';

const MAX_FILES = 4096, MAX_DIRECTORY_BYTES = 64 * 1024 * 1024, MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_REFS = 100_000;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const exactRefs = (refs: SourceRef[]) => [...new Map(refs.map(ref => [canonicalJson(ref), ref])).values()];
/** Scan only the three published primary directories, with explicit read bounds and no repair or discovery. */
function heads(workspace: string, directory: string) {
  checkStorageDirectory(workspace); checkStorageDirectory(directory);
  const workspaceStat = lstatSync(workspace, { bigint: true }), rootBinding = { device: workspaceStat.dev.toString(), inode: workspaceStat.ino.toString() };
  let handle, directoryStat;
  try { directoryStat = lstatSync(directory, { bigint: true }); handle = opendirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rootBinding, directoryBinding: null, files: [] }; throw error; }
  const directoryBinding = { device: directoryStat.dev.toString(), inode: directoryStat.ino.toString() };
  const files: { name: string; device: string; inode: string; bytes: string; modified: string; changed: string }[] = []; let bytes = 0, visited = 0;
  try {
    for (let entry; (entry = handle.readSync());) {
      if (++visited > MAX_FILES * 2) throw new Error('Source reference directory entry capacity exceeded.');
      if (!entry.name.endsWith('.json')) continue;
      const stat = lstatSync(join(directory, entry.name), { bigint: true }); bytes += Number(stat.size);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_FILE_BYTES) || files.length >= MAX_FILES || bytes > MAX_DIRECTORY_BYTES) throw new Error('Source reference directory capacity or format is unavailable.');
      files.push({ name: entry.name, device: stat.dev.toString(), inode: stat.ino.toString(), bytes: stat.size.toString(), modified: stat.mtimeNs.toString(), changed: stat.ctimeNs.toString() });
    }
  } finally { handle.closeSync(); }
  return { rootBinding, directoryBinding, files: files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
}
function inventory(workspace: string): SourceUpdateInventory {
  const result: SourceUpdateInventory = { status: 'complete', bodies: [], catalogs: [], projections: [], limitations: [] };
  const knowledge = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace), entities = new FileEntityAnalysisStore(join(workspace, 'entities'), workspace);
  const associations = new FileKnowledgeAssociationStore(join(workspace, 'associations'), 'local', knowledge, entities, workspace);
  const knownBodies = new Map<string, KnowledgeEnvelope['revisions'][number]>(); let readable = 0;
  const incomplete = (message: string) => { result.status = 'partial'; if (!result.limitations.includes(message)) result.limitations.push(message); };
  const initialHeads = new Map<string, ReturnType<typeof heads>>();
  for (const name of ['items', 'entities', 'associations']) {
    try { initialHeads.set(name, heads(workspace, join(workspace, name))); }
    catch { incomplete(`The ${name} reference inventory is unavailable or exceeds bounded read capacity; no complete zero-impact conclusion is available.`); }
  }
  const boundedRefs = (refs: SourceRef[]) => { const unique = exactRefs(refs); if (unique.length > 256) incomplete('One exact revision has more source references than this bounded report can include.'); return unique.slice(0, 256); };
  const append = <T>(target: T[], item: T) => { if (target.length < MAX_REFS) target.push(item); else incomplete('Exact revision reference inventory exceeds this report capacity.'); };
  const read = (name: string, operation: () => void) => {
    const directory = join(workspace, name);
    try { const before = initialHeads.get(name); if (!before) return; operation(); readable++;
      if (!same(before, heads(workspace, directory))) incomplete('Published reference heads changed during the read; known results are incomplete.');
    } catch { incomplete(`The ${name} reference inventory is unavailable or exceeds bounded read capacity; no complete zero-impact conclusion is available.`); }
  };
  read('items', () => {
    for (const history of knowledge.list()) for (const revision of history.revisions) {
      const bodyRef = knowledgeBodyRef(revision); knownBodies.set(canonicalJson(bodyRef), revision);
      append(result.bodies, { bodyRef, sourceRefs: boundedRefs(revision.content.segments.flatMap(segment => segment.evidence.map(evidence => evidence.source))) });
    }
  });
  read('entities', () => {
    const listed = entities.list(); if (listed.unavailable) incomplete('Some exact catalog histories could not be read; healthy catalog revisions remain listed.');
    for (const history of listed.histories) for (const revision of history.revisions) append(result.catalogs,
      { catalogRef: { analysisId: history.analysisId, entityRevisionId: revision.revisionId }, sourceRef: { snapshotId: history.snapshotId, sourceVersion: history.sourceVersion } });
  });
  const catalogKeys = new Set(result.catalogs.map(item => canonicalJson(item.catalogRef)));
  read('associations', () => {
    for (const history of associations.list()) for (const revision of history.revisions) {
      const body = knownBodies.get(canonicalJson(revision.bodyRef)) ?? knowledge.read(history.knowledgeId).revisions.find(body => same(knowledgeBodyRef(body), revision.bodyRef));
      if (!body) { incomplete('A projection exact body reference is unavailable.'); continue; }
      for (const ref of revision.catalogRefs) if (!catalogKeys.has(canonicalJson(ref))) incomplete('A projection exact catalog reference is unavailable.');
      append(result.projections, { projectionRef: { namespace: history.namespace, bodyRef: revision.bodyRef, projectionRevisionId: revision.revisionId },
        sourceRefs: boundedRefs([...body.content.segments.flatMap(segment => segment.evidence.map(evidence => evidence.source)),
          ...(revision.typedRelations ?? []).flatMap(relation => relation.evidence.map(evidence => evidence.source))]), catalogRefs: revision.catalogRefs.slice(0, 256) });
      if (revision.catalogRefs.length > 256) incomplete('A projection has more exact catalog references than this bounded report can include.');
    }
  });
  // A later directory read can coincide with a write to an earlier one. Per-directory checks alone
  // cannot establish one complete inventory window; verify every original head again at the end.
  for (const [name, before] of initialHeads) {
    try { if (!same(before, heads(workspace, join(workspace, name)))) incomplete('Published reference heads changed during the whole inventory read; known results are incomplete.'); }
    catch { incomplete('Published reference heads became unavailable during the whole inventory read; known results are incomplete.'); }
  }
  if (!readable) result.status = 'unavailable';
  return result;
}
function selectedMissing(snapshot: SourceSnapshot, scope: LocalSourceScope): boolean {
  if (snapshot.sourceKind !== 'project_file') return false;
  const project = scope.projects.find(value => value.projectId === snapshot.identity.projectId); if (!project) return false;
  try {
    const root = realpathSync(project.root), before = lstatSync(project.root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) return false;
    const directory = opendirSync(root); directory.closeSync();
    let path = root, missing = false;
    for (const part of snapshot.identity.relativePath.split('/')) {
      path = join(path, part);
      try { if (lstatSync(path).isSymbolicLink()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; missing = true; break; }
    }
    const after = lstatSync(project.root, { bigint: true }), checked = opendirSync(root); checked.closeSync();
    return missing && realpathSync(project.root) === root && before.dev === after.dev && before.ino === after.ino && after.isDirectory() && !after.isSymbolicLink();
  } catch { return false; }
}
/** Currentness composition is read-only: it never creates a capture service, snapshot, model, knowledge write or permission record. */
export function createLocalSourceUpdates(workspaceRoot: string, input: LocalSourceScope): SourceUpdatesService {
  if (!workspaceRoot.trim()) throw new Error('Explicit source workspace required.');
  const workspace = resolve(workspaceRoot), scope = LocalSourceScopeSchema.parse(input), reader = createLocalSourceReader(scope);
  return new SourceUpdatesService({ store: new FileSourceStore(join(workspace, 'sources'), workspace), now: () => new Date().toISOString(), readInventory: () => inventory(workspace),
    readCurrent(snapshot, replacement, signal): SourceCurrentReadResult {
      try {
        const resolved = ResolvedSourceSelectionSchema.parse({ sourceKind: snapshot.sourceKind, ...snapshot.identity, ...snapshot.selection });
        const reading = replacement ? reader.read(replacement, signal) : reader.readResolved(resolved, signal);
        return { status: 'available', projection: reading.projection };
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof ProjectSourceReadError || error instanceof TraceSourceReadError) return { status: 'unavailable',
          reason: error.reason === 'version_mismatch' ? 'corrupt' : error.reason,
          ...(error.reason === 'missing' && !replacement && selectedMissing(snapshot, scope) ? { missingScope: 'selected_source' as const } : { missingScope: 'binding' as const }) };
        return { status: 'unavailable', reason: 'corrupt', missingScope: 'binding' };
      }
    } });
}
