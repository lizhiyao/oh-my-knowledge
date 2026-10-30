import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import { KnowledgeOperationSchema } from '../../src/knowledge/application/operations.js';
import type { LocalSourceScope } from '../../src/knowledge/application/local-source-host.js';
import type { KnowledgeRevision } from '../../src/knowledge/contracts.js';
import type { SourceSelection, SourceSnapshot } from '../../src/knowledge/sources.js';
import ObserveKnowledge from '../../src/cli/commands/observe/knowledge.js';
import { sourceRef } from '../helpers/knowledge-source.js';
import { runCommand } from '../helpers/run-command.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function bytes(root: string) {
  const values: [string, string][] = [];
  const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const selected = join(path, entry.name); if (entry.isDirectory()) walk(selected); else if (!entry.isSymbolicLink()) values.push([relative(root, selected), createHash('sha256').update(readFileSync(selected)).digest('hex')]);
  } }; walk(root); return values;
}
function fixture(git = false) {
  const root = mkdtempSync(join(tmpdir(), 'omk-local-source-updates-')); roots.push(root);
  const workspace = join(root, 'knowledge'), project = join(root, 'project'); mkdirSync(project);
  const path = join(project, 'guide.txt'); writeFileSync(path, 'first\nselected evidence\nlast\n');
  const scope: LocalSourceScope = { scopeVersion: 'knowledge-source-scope/v1', projects: [{ projectId: 'project', root: project }], traces: [] };
  const app = createLocalKnowledgeApplication(workspace, { sourceScope: scope });
  const selection: SourceSelection = git ? { sourceKind: 'git_blob', projectId: 'project', relativePath: 'guide.txt', revision: 'HEAD', lineRanges: [{ startLine: 2, endLine: 2 }] }
    : { sourceKind: 'project_file', projectId: 'project', relativePath: 'guide.txt', lineRanges: [{ startLine: 2, endLine: 2 }] };
  const command = (args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=Authored Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${join(root, 'hooks')}`, ...args], { encoding: 'utf8',
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'no-global-config'),
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_DATE: '2026-10-30T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-30T00:00:01Z' }, stdio: 'pipe' }).trim();
  if (git) { mkdirSync(join(root, 'hooks')); mkdirSync(join(root, 'template')); command(['init', '--template', join(root, 'template')]); command(['add', '--', 'guide.txt']); command(['commit', '-m', 'authored initial source']); }
  const preview = app.previewSources([selection]), snapshot = app.captureSources(preview).sources[0].snapshot;
  return { root, workspace, project, path, scope, app, selection, snapshot, command };
}
function histories(f: ReturnType<typeof fixture>, snapshot: SourceSnapshot) {
  const actor = { actorKind: 'human' as const, actorId: 'authored-update-fixture' }, at = '2026-10-30T00:00:00Z';
  const knowledge = new FileKnowledgeStore(join(f.workspace, 'items'), 'local', f.workspace), entities = new FileEntityAnalysisStore(join(f.workspace, 'entities'), f.workspace);
  const associations = new FileKnowledgeAssociationStore(join(f.workspace, 'associations'), 'local', knowledge, entities, f.workspace);
  const draft = { title: 'Original user conditions', reuseRationale: 'Compare exact source evidence later.', content: { segments: [{ segmentId: 's1', text: 'Keep the complete original user condition; no claim of verified truth.',
    evidence: [{ source: sourceRef(snapshot), selection: { evidenceRef: snapshot.excerpts[0].evidenceRef, quote: snapshot.excerpts[0].text, start: 0, end: snapshot.excerpts[0].text.length }, basis: 'source_assertion' as const }] }] } };
  const knowledgeId = randomUUID(), analysisId = randomUUID(), bodies: KnowledgeRevision[] = [], catalogs: string[] = [], projections: string[] = [];
  for (let index = 0; index < 2; index++) {
    const body: KnowledgeRevision = { ...draft, title: index ? 'Human revised conditions' : draft.title, knowledgeId, revisionId: randomUUID(), bodyDigest: '',
      ...(index ? { parentRevision: { knowledgeId, revisionId: bodies[0].revisionId } } : {}), observationRefs: [], derivations: [], createdAt: at, revisedAt: at, createdBy: actor, revisedBy: actor, revisionReason: 'Authored exact revision.' };
    body.bodyDigest = knowledgeBodyDigest(body); knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: index,
      expectedHeadRevisionId: index ? bodies[0].revisionId : null, revision: body }, actor); bodies.push(body);
    const catalogId = randomUUID(); entities.write({ requestId: randomUUID(), analysisId, ...sourceRef(snapshot), expectedGeneration: index, expectedHeadRevisionId: index ? catalogs[0] : null,
      revision: { revisionId: catalogId, ...(index ? { parentRevisionId: catalogs[0] } : {}), entities: [], mentions: [], limitations: ['Authored empty catalog; not a recall evaluation.'], revisedAt: at, revisedBy: actor, revisionReason: 'Authored exact catalog.' } }, actor); catalogs.push(catalogId);
    const projectionId = randomUUID(); associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId, expectedGeneration: index, expectedHeadRevisionId: index ? projections[0] : null,
      revision: { revisionId: projectionId, ...(index ? { parentRevisionId: projections[0] } : {}), bodyRef: knowledgeBodyRef(body), status: 'available', reviewStatus: 'pending', catalogRefs: [{ analysisId, entityRevisionId: catalogId }],
        segmentEntityRefs: [], typedRelations: [], issues: ['Independent authored projection.'], revisedAt: at, revisedBy: actor, revisionReason: 'Authored exact projection.' } }, actor); projections.push(projectionId);
  }
  return { bodies, analysisId, catalogs, projections };
}

describe('trusted local source currentness and exact-impact wiring', () => {
  it('checks real file changes and all exact historical body/catalog/projection refs without writing or dispatching', async () => {
    const f = fixture(), linked = histories(f, f.snapshot), fetch = vi.fn(() => { throw new Error('No model authorized.'); }); vi.stubGlobal('fetch', fetch);
    const capture = vi.spyOn(FileSourceStore.prototype, 'captureBatch');
    writeFileSync(f.path, 'first\nselected evidence\nchanged outside selected line\n');
    const before = bytes(f.root), report = f.app.sourceUpdates(sourceRef(f.snapshot));
    expect(report.current.state).toBe('content_changed'); expect(report.changes).toMatchObject({ contentChanged: true, selectedBytesChanged: false, projectionTextChanged: false });
    expect(report.inventoryCompleteness).toBe('complete'); expect(report.affectedExactBodyRefs).toEqual(expect.arrayContaining(linked.bodies.map(knowledgeBodyRef)));
    expect(report.catalogRefs).toHaveLength(2); expect(report.projectionRefs.map(ref => ref.projectionRevisionId).sort()).toEqual([...linked.projections].sort());
    const scope = join(f.root, 'scope.json'), input = join(f.root, 'check.json'); writeFileSync(scope, JSON.stringify(f.scope)); writeFileSync(input, JSON.stringify({ source: sourceRef(f.snapshot) }));
    const cliBefore = bytes(f.root), result = JSON.parse((await runCommand(ObserveKnowledge, ['source-updates', '--workspace', f.workspace, '--scope', scope, '--input', input, '--json'], { cwd: f.root })).stdout);
    expect(result).toMatchObject({ current: { state: 'content_changed' }, inventoryCompleteness: 'complete' }); expect(bytes(f.root)).toEqual(cliBefore);
    expect(capture).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(before).toEqual(cliBefore.filter(([path]) => !['scope.json', 'check.json'].includes(path)));
  });

  it('distinguishes an upstream missing path, an inaccessible root, an explicit move candidate and a deleted capture', () => {
    const f = fixture(); histories(f, f.snapshot); const moved = join(f.project, 'moved.txt'); renameSync(f.path, moved);
    expect(f.app.sourceUpdates(sourceRef(f.snapshot))).toMatchObject({ current: { state: 'deleted' }, historicalSource: { status: 'available' } });
    const replacement: SourceSelection = { sourceKind: 'project_file', projectId: 'project', relativePath: 'moved.txt', lineRanges: [{ startLine: 2, endLine: 2 }] };
    expect(f.app.sourceUpdates(sourceRef(f.snapshot), replacement)).toMatchObject({ current: { state: 'possible_move' }, changes: { selectedBytesChanged: false } });
    renameSync(f.project, join(f.root, 'root-unavailable'));
    expect(f.app.sourceUpdates(sourceRef(f.snapshot))).toMatchObject({ current: { state: 'unavailable' }, inventoryCompleteness: 'complete', impactCompleteness: 'partial' });
    new FileSourceStore(join(f.workspace, 'sources'), f.workspace).delete(f.snapshot.snapshotId, f.snapshot.sourceVersion);
    const before = bytes(f.workspace), deleted = f.app.sourceUpdates(sourceRef(f.snapshot));
    expect(deleted).toMatchObject({ current: { state: 'unavailable' }, historicalSource: { status: 'unavailable', reason: 'deleted' } }); expect(bytes(f.workspace)).toEqual(before);
  });

  it('reports explicit host material changes separately and keeps known catalog impact incomplete on corrupt body inventory', () => {
    const f = fixture(); histories(f, f.snapshot); f.scope.projects[0].materials = [{ relativePath: 'guide.txt', materialType: 'design', reason: 'Explicit host reclassification.' }];
    const app = createLocalKnowledgeApplication(f.workspace, { sourceScope: f.scope }), metadata = app.sourceUpdates(sourceRef(f.snapshot));
    expect(metadata).toMatchObject({ current: { state: 'provenance_only_changed' }, changes: { contentChanged: false, metadataChanged: true, selectedBytesChanged: false } });
    writeFileSync(join(f.workspace, 'items', 'corrupt.json'), '{bad'); const before = bytes(f.workspace), partial = app.sourceUpdates(sourceRef(f.snapshot));
    expect(partial.inventoryCompleteness).toBe('partial'); expect(partial.impactCompleteness).toBe('partial'); expect(partial.catalogRefs).toHaveLength(2);
    expect(partial.reviewSuggestions.some(item => item.reviewKind === 'complete_inventory')).toBe(true); expect(bytes(f.workspace)).toEqual(before);
  });

  it('keeps captured Git pins fixed after a branch moves and refreshes only an explicit new selector', () => {
    const f = fixture(true); histories(f, f.snapshot); writeFileSync(f.path, 'first\nnew selected Git evidence\nlast\n'); f.command(['add', '--', 'guide.txt']); f.command(['commit', '-m', 'authored moved branch']);
    const before = bytes(f.root), pinned = f.app.sourceUpdates(sourceRef(f.snapshot));
    expect(pinned).toMatchObject({ current: { state: 'unchanged' }, changes: { comparisonScope: 'fixed_git_objects' } });
    expect(pinned.reviewSuggestions.some(item => item.reviewKind === 'refresh_git_selector')).toBe(true);
    const refreshed = f.app.sourceUpdates(sourceRef(f.snapshot), f.selection);
    expect(refreshed).toMatchObject({ current: { state: 'content_changed' }, changes: { comparisonScope: 'explicit_selection', selectedBytesChanged: true } }); expect(bytes(f.root)).toEqual(before);
  });

  it('marks bounded or concurrently changed inventories incomplete while preserving known exact catalog impact', () => {
    const f = fixture(); histories(f, f.snapshot);
    const path = join(f.workspace, 'items', 'oversized.json'); writeFileSync(path, '{}'); truncateSync(path, 16 * 1024 * 1024 + 1);
    const list = vi.spyOn(FileKnowledgeStore.prototype, 'list');
    expect(f.app.sourceUpdates(sourceRef(f.snapshot))).toMatchObject({ inventoryCompleteness: 'partial', catalogRefs: [expect.anything(), expect.anything()] }); expect(list).not.toHaveBeenCalled();
    list.mockRestore(); rmSync(path);
    const original = FileKnowledgeStore.prototype.list;
    vi.spyOn(FileKnowledgeStore.prototype, 'list').mockImplementationOnce(function (this: FileKnowledgeStore, ids) {
      const result = original.call(this, ids); writeFileSync(path, '{external-concurrent-write'); return result;
    });
    const changed = f.app.sourceUpdates(sourceRef(f.snapshot));
    expect(changed.inventoryCompleteness).toBe('partial'); expect(changed.affectedExactBodyRefs).toHaveLength(2);
    expect(changed.impactLimitations.some(text => text.includes('changed during the read'))).toBe(true);
  });

  it('detects a source-referencing body inserted by another writer during the later catalog scan', () => {
    const f = fixture(), linked = histories(f, f.snapshot), body = linked.bodies[0];
    rmSync(join(f.workspace, 'items'), { recursive: true }); rmSync(join(f.workspace, 'associations'), { recursive: true });
    const original = FileEntityAnalysisStore.prototype.list;
    vi.spyOn(FileEntityAnalysisStore.prototype, 'list').mockImplementationOnce(function (this: FileEntityAnalysisStore) {
      const result = original.call(this);
      // An authored external write occurs after the empty body inventory has already completed.
      new FileKnowledgeStore(join(f.workspace, 'items'), 'local', f.workspace).write({ commandKind: 'append_revision', requestId: randomUUID(),
        knowledgeId: body.knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null, revision: body }, body.createdBy);
      return result;
    });
    const report = f.app.sourceUpdates(sourceRef(f.snapshot));
    expect(report.inventoryCompleteness).toBe('partial'); expect(report.impactCompleteness).toBe('partial');
    expect(report.affectedExactBodyRefs).toEqual([]); expect(report.catalogRefs).toHaveLength(2);
    expect(report.impactLimitations.some(text => text.includes('whole inventory read'))).toBe(true);
    expect(new FileKnowledgeStore(join(f.workspace, 'items'), 'local', f.workspace).read(body.knowledgeId).revisions[0]).toEqual(body);
  });

  it('does not follow replaced source symlinks or permit request payloads to add host bindings', async () => {
    const f = fixture(), outside = join(f.root, 'outside.txt'); writeFileSync(outside, readFileSync(f.path)); rmSync(f.path); symlinkSync(outside, f.path);
    expect(f.app.sourceUpdates(sourceRef(f.snapshot)).current.state).toBe('unavailable');
    for (const input of [{ operation: 'source-updates', source: { snapshotId: f.snapshot.snapshotId } },
      { operation: 'source-updates', source: sourceRef(f.snapshot), replacementSelection: { ...f.selection, root: f.root } },
      { operation: 'source-updates', source: sourceRef(f.snapshot), scope: f.scope }]) expect(KnowledgeOperationSchema.safeParse(input).success).toBe(false);
    const request = join(f.root, 'bad-request.json'); writeFileSync(request, JSON.stringify({ source: sourceRef(f.snapshot), replacementSelection: { ...f.selection, relativePath: '../outside.txt' } }));
    await expect(runCommand(ObserveKnowledge, ['source-updates', '--workspace', f.workspace, '--input', request, '--scope', '/must-not-read'], { cwd: f.root })).rejects.toMatchObject({ code: 2 });
    expect(existsSync(join(f.workspace, 'generation-journals'))).toBe(false);
  });
});
