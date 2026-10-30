import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { readProjectSource, readResolvedProjectSource } from '../../src/knowledge/adapters/project-source-reader.js';
import { SourceUpdatesError, SourceUpdatesService, type SourceCurrentReadResult, type SourceUpdateInventory,
  type SourceUpdatesPorts } from '../../src/knowledge/application/source-updates.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { sourceVersionPreimage, type SourceProjection, type SourceRef, type SourceResolution, type SourceSnapshot } from '../../src/knowledge/sources.js';

const sha = (text: string | Uint8Array) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const material = { materialType: 'unknown' as const, attributionBasis: 'unknown' as const, reason: 'Authored source comparison fixture.' };
const at = '2026-10-30T01:23:45.000Z';
const roots: string[] = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'omk-source-updates-')); roots.push(root); return root; };
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function file(text = 'original', fullContent = text, relativePath = 'docs/source.txt'): Extract<SourceProjection, { sourceKind: 'project_file' }> {
  const coordinate = { coordinateKind: 'file_range' as const, relativePath, startLine: 1, endLine: 1, startByte: 0, endByte: Buffer.byteLength(text) };
  return { sourceKind: 'project_file', projectionVersion: 'knowledge-window-v3', identity: { projectId: 'project', relativePath },
    selection: { lineRanges: [{ startLine: 1, endLine: 1 }] }, contentVersion: sha(fullContent), material,
    provenance: { attributions: [], times: [] }, limitations: [],
    rawUnits: [{ unitId: 0, text, coordinate, rawByteDigest: sha(text), rawByteLength: Buffer.byteLength(text) }],
    excerpts: [{ unitId: 0, text, coordinate, material }] };
}
function git(commitOid = '1'.repeat(40)): Extract<SourceProjection, { sourceKind: 'git_blob' }> {
  const input = file(), identity = { ...input.identity, objectHashAlgorithm: 'sha1' as const, commitOid, treeOid: '2'.repeat(40), blobOid: '3'.repeat(40) };
  if (input.rawUnits[0].coordinate.coordinateKind !== 'file_range') throw new Error('File fixture expected.');
  const coordinate = { ...input.rawUnits[0].coordinate, coordinateKind: 'git_blob_range' as const,
    objectHashAlgorithm: identity.objectHashAlgorithm, commitOid, treeOid: identity.treeOid, blobOid: identity.blobOid };
  return { ...input, sourceKind: 'git_blob', identity, rawUnits: [{ ...input.rawUnits[0], coordinate }], excerpts: [{ ...input.excerpts[0], coordinate }] };
}
function snapshot(projection: SourceProjection): SourceSnapshot {
  const snapshotId = randomUUID(); return { ...projection, snapshotId, sourceVersion: sha(canonicalJson(sourceVersionPreimage(projection))), capturedAt: at,
    excerpts: projection.excerpts.map((excerpt, ordinal) => ({ ...excerpt, evidenceRef: `${snapshotId}:${ordinal}` })) };
}
const ref = (source: SourceSnapshot): SourceRef => ({ snapshotId: source.snapshotId, sourceVersion: source.sourceVersion });
const emptyInventory = (): SourceUpdateInventory => ({ status: 'complete', bodies: [], catalogs: [], projections: [], limitations: [] });
function setup(original = snapshot(file()), reading: SourceCurrentReadResult = { status: 'available', projection: file() }, inventory = emptyInventory()) {
  const ports = { store: { read: vi.fn((): SourceResolution => ({ status: 'available', snapshot: original })) }, now: vi.fn(() => at),
    readCurrent: vi.fn<SourceUpdatesPorts['readCurrent']>(() => reading), readInventory: vi.fn(() => inventory) };
  return { original, sourceRef: ref(original), ports, service: new SourceUpdatesService(ports) };
}

describe('read-only source changes and exact-reference impact', () => {
  it('checks real files without modifying captured history and distinguishes outside-selection changes, deletion and a missing binding root', () => {
    const project = temp(), workspace = temp(), path = join(project, 'source.txt'); writeFileSync(path, 'kept\nold\n');
    const context = { projectId: 'project', approvedRoot: project };
    const input = { sourceKind: 'project_file' as const, projectId: 'project', relativePath: 'source.txt', lineRanges: [{ startLine: 1, endLine: 1 }] };
    const store = new FileSourceStore(join(workspace, 'sources'), workspace), captured = store.capture(readProjectSource(input, context).projection);
    const savedPath = join(workspace, 'sources', `${captured.snapshot.snapshotId}.json`), saved = readFileSync(savedPath);
    const readCurrent: SourceUpdatesPorts['readCurrent'] = source => {
      if (source.sourceKind !== 'project_file') throw new Error('Wrong fixture source type.');
      try { return { status: 'available', projection: readResolvedProjectSource({ sourceKind: source.sourceKind, ...source.identity, ...source.selection }, context).projection }; }
      catch { return { status: 'unavailable', reason: 'missing', missingScope: existsSync(project) ? 'selected_source' : 'binding' }; }
    };
    const service = new SourceUpdatesService({ store, readCurrent, now: () => at, readInventory: emptyInventory });
    writeFileSync(path, 'kept\nnew\n'); const changed = service.check(ref(captured.snapshot));
    expect(changed.current).toMatchObject({ state: 'content_changed', selectedBytesChanged: false, checkedAt: at });
    expect(changed.changes).toMatchObject({ contentChanged: true, selectedBytesChanged: false, projectionTextChanged: false });
    expect(changed.current.limitations.some(text => text.includes('选中字节保持相同'))).toBe(true);
    rmSync(path); const deleted = service.check(ref(captured.snapshot));
    expect(deleted.current.state).toBe('deleted'); expect(deleted.historicalSource.status).toBe('available');
    expect(store.read(captured.snapshot.snapshotId)).toMatchObject({ status: 'available' });
    rmSync(project, { recursive: true }); const missingBinding = service.check(ref(captured.snapshot));
    expect(missingBinding).toMatchObject({ current: { state: 'unavailable' }, inventoryCompleteness: 'complete', impactCompleteness: 'partial' });
    expect(missingBinding.reviewSuggestions.some(item => item.reviewKind === 'complete_inventory')).toBe(false);
    expect(missingBinding.reviewSuggestions.some(item => item.reviewKind === 'verify_availability')).toBe(true);
    expect(readFileSync(savedPath)).toEqual(saved); expect(readdirSync(workspace)).toEqual(['sources']);
  });

  it('reports metadata changes separately from content and selected raw bytes', () => {
    const observed = file(); observed.material = { ...material, reason: 'Updated host material attribution.' };
    const { service, sourceRef } = setup(undefined, { status: 'available', projection: observed });
    const result = service.check(sourceRef);
    expect(result.current).toMatchObject({ state: 'provenance_only_changed', selectedBytesChanged: false });
    expect(result.changes).toMatchObject({ contentChanged: false, metadataChanged: true, projectionTextChanged: false });
    expect(result.reviewSuggestions.map(item => item.reviewKind)).toEqual(['compare_evidence']);
  });

  it('finds exact source/body/catalog dependents without widening identity by name, digest similarity or newer revisions', () => {
    const original = snapshot(file()), sourceRef = ref(original), otherSource = { ...sourceRef, sourceVersion: sha('different version') };
    const bodyRef = { knowledgeId: 'same-name', revisionId: 'body1', bodyDigest: sha('exact body') };
    const otherBody = { ...bodyRef, bodyDigest: sha('different exact body') };
    const catalogRef = { analysisId: randomUUID(), entityRevisionId: randomUUID() }, otherCatalog = { ...catalogRef, entityRevisionId: randomUUID() };
    const projectionRef = (name: string, body = otherBody) => ({ namespace: 'namespace', bodyRef: body, projectionRevisionId: name });
    const inventory: SourceUpdateInventory = { status: 'complete', limitations: [], bodies: [
      { bodyRef, sourceRefs: [sourceRef] }, { bodyRef, sourceRefs: [sourceRef] }, { bodyRef: otherBody, sourceRefs: [otherSource] }],
    catalogs: [{ catalogRef, sourceRef }, { catalogRef: otherCatalog, sourceRef: otherSource }], projections: [
      { projectionRef: projectionRef('via-body', bodyRef), sourceRefs: [], catalogRefs: [] },
      { projectionRef: projectionRef('via-catalog'), sourceRefs: [], catalogRefs: [catalogRef] },
      { projectionRef: projectionRef('direct-evidence'), sourceRefs: [sourceRef], catalogRefs: [] },
      { projectionRef: projectionRef('unrelated-revision'), sourceRefs: [otherSource], catalogRefs: [otherCatalog] }] };
    const { service } = setup(original, { status: 'available', projection: file('changed!') }, inventory), result = service.check(sourceRef);
    expect(result.current).toMatchObject({ state: 'content_changed', selectedBytesChanged: true }); expect(result.changes.metadataChanged).toBe(false);
    expect(result.affectedExactBodyRefs).toEqual([bodyRef]); expect(result.catalogRefs).toEqual([catalogRef]);
    expect(result.projectionRefs.map(value => value.projectionRevisionId).sort()).toEqual(['direct-evidence', 'via-body', 'via-catalog']);
    expect(result.impactCompleteness).toBe('complete');
    expect(result.reviewSuggestions.filter(item => item.reviewKind === 'review_body')).toEqual([{ reviewKind: 'review_body', target: { targetKind: 'body', bodyRef }, reason: expect.any(String) }]);
    expect(inventory.bodies).toHaveLength(3);
  });

  it('keeps unchanged currentness separate from any verdict about a referenced knowledge claim', () => {
    const { service, sourceRef } = setup(), result = service.check(sourceRef);
    expect(result.current.state).toBe('unchanged'); expect(result.changes).toMatchObject({ contentChanged: false, metadataChanged: false, selectedBytesChanged: false });
    expect(result.reviewSuggestions).toEqual([]); expect(result).not.toHaveProperty('verified');
  });

  it('checks Git pins by default and requires an explicit revision selector before comparing branch-refresh provenance', () => {
    const original = snapshot(git()), pinned = setup(original, { status: 'available', projection: git() });
    expect(pinned.service.check(pinned.sourceRef).current.state).toBe('unchanged');
    expect(pinned.ports.readCurrent).toHaveBeenCalledWith(original, undefined, undefined);
    const fixed = pinned.service.check(pinned.sourceRef);
    expect(fixed.changes.comparisonScope).toBe('fixed_git_objects'); expect(fixed.current.limitations.some(text => text.includes('最新状态'))).toBe(true);
    const movedPin = git('4'.repeat(40)), refreshed = setup(original, { status: 'available', projection: movedPin });
    expect(refreshed.service.check(refreshed.sourceRef).current.state).toBe('unknown');
    const replacementSelection = { sourceKind: 'git_blob' as const, projectId: 'project', relativePath: 'docs/source.txt', revision: 'main', lineRanges: [{ startLine: 1, endLine: 1 }] };
    const result = refreshed.service.check(refreshed.sourceRef, { replacementSelection });
    expect(result.current).toMatchObject({ state: 'provenance_only_changed', selectedBytesChanged: false, observedIdentity: { commitOid: movedPin.identity.commitOid } });
    expect(result.changes).toMatchObject({ comparisonScope: 'explicit_selection', contentChanged: false, metadataChanged: true });
    expect(refreshed.ports.readCurrent).toHaveBeenLastCalledWith(original, replacementSelection, undefined);
  });

  it('treats only an explicit replacement position as a possible move even when the selected bytes are identical', () => {
    const original = snapshot(file()), observed = file('original', 'original', 'moved/source.txt');
    const { service, sourceRef } = setup(original, { status: 'available', projection: observed });
    expect(service.check(sourceRef).current.state).toBe('unknown');
    const result = service.check(sourceRef, { replacementSelection: { sourceKind: 'project_file', projectId: 'project', relativePath: 'moved/source.txt', lineRanges: [{ startLine: 1, endLine: 1 }] } });
    expect(result.current).toMatchObject({ state: 'possible_move', selectedBytesChanged: false });
    expect(result.reviewSuggestions[0].reviewKind).toBe('confirm_replacement');
    expect(result.current.limitations.some(text => text.includes('人工确认来源身份'))).toBe(true);
  });

  it('leaves changed selections and interpretation-only text changes explicitly unknown', () => {
    const original = snapshot(file()), observed = file(); observed.selection.lineRanges = [{ startLine: 2, endLine: 2 }];
    for (const unit of observed.rawUnits) if (unit.coordinate.coordinateKind === 'file_range') { unit.coordinate.startLine = 2; unit.coordinate.endLine = 2; }
    for (const excerpt of observed.excerpts) if (excerpt.coordinate.coordinateKind === 'file_range') { excerpt.coordinate.startLine = 2; excerpt.coordinate.endLine = 2; }
    const current = setup(original, { status: 'available', projection: observed });
    const changed = current.service.check(current.sourceRef, { replacementSelection: { sourceKind: 'project_file', projectId: 'project', relativePath: 'docs/source.txt', lineRanges: [{ startLine: 2, endLine: 2 }] } });
    expect(changed.current.state).toBe('unknown'); expect(changed.current).not.toHaveProperty('selectedBytesChanged');
    // A trace can acquire a different adapter interpretation while retaining its original raw record bytes.
    const raw = '{"message":"original"}', trace: SourceProjection = { sourceKind: 'agent_trace', projectionVersion: 'knowledge-window-v3',
      identity: { sourceId: 'trace', traceKind: 'codex' }, selection: { recordRanges: [{ startRecord: 0, endRecord: 0 }] },
      contentVersion: sha(raw), material, provenance: { attributions: [], times: [] }, limitations: [],
      rawUnits: [{ unitId: 0, text: raw, rawByteDigest: sha(raw), rawByteLength: Buffer.byteLength(raw), coordinate: { coordinateKind: 'trace_record', recordIndex: 0 } }],
      excerpts: [{ unitId: 0, text: 'original', material, coordinate: { coordinateKind: 'trace_event', recordIndex: 0, eventOrdinal: 0, eventKind: 'message', role: 'user' } }] };
    const reinterpreted = { ...trace, excerpts: [{ ...trace.excerpts[0], text: 'new interpretation' }] };
    const comparison = setup(snapshot(trace), { status: 'available', projection: reinterpreted });
    expect(comparison.service.check(comparison.sourceRef)).toMatchObject({ current: { state: 'unknown' }, changes: { contentChanged: false, selectedBytesChanged: false, projectionTextChanged: true } });
  });

  it.each(['deleted', 'permission_denied'] as const)('keeps a historical %s source unavailable without reading upstream or claiming complete zero impact', reason => {
    const { service, ports, sourceRef } = setup(); ports.store.read.mockReturnValue({ status: 'unavailable', reason, detail: 'Authored unavailability.' });
    const result = service.check(sourceRef, { replacementSelection: { sourceKind: 'project_file', projectId: 'project', relativePath: 'new.txt', lineRanges: null } });
    expect(result.current.state).toBe('unavailable'); expect(result.historicalSource).toEqual({ status: 'unavailable', reason });
    expect(ports.readCurrent).not.toHaveBeenCalled(); expect(result.impactCompleteness).toBe('partial'); expect(result.affectedExactBodyRefs).toEqual([]);
    expect(result.impactLimitations.some(text => text.includes('零影响'))).toBe(true);
  });

  it.each([undefined, 'binding', 'selected_source'] as const)('requires host-confirmed selected-source absence rather than %s scope to report upstream deletion', missingScope => {
    const { service, sourceRef } = setup(undefined, { status: 'unavailable', reason: 'missing', ...(missingScope ? { missingScope } : {}) });
    expect(service.check(sourceRef).current.state).toBe(missingScope === 'selected_source' ? 'deleted' : 'unavailable');
    const pinned = setup(snapshot(git()), { status: 'unavailable', reason: 'missing', missingScope: 'selected_source' });
    expect(pinned.service.check(pinned.sourceRef).current.state).toBe('unavailable');
  });

  it('returns only known impacts from partial inventories and reports failed/invalid inventories as unavailable', () => {
    const original = snapshot(file()), sourceRef = ref(original), bodyRef = { knowledgeId: 'body', revisionId: 'revision', bodyDigest: sha('body') };
    const inventory: SourceUpdateInventory = { ...emptyInventory(), status: 'partial', bodies: [{ bodyRef, sourceRefs: [sourceRef] }], limitations: ['One catalog was unreadable.'] };
    const { service, ports } = setup(original, { status: 'available', projection: file() }, inventory), partial = service.check(sourceRef);
    expect(partial.affectedExactBodyRefs).toEqual([bodyRef]); expect(partial.impactCompleteness).toBe('partial'); expect(partial.impactLimitations).toContain('One catalog was unreadable.');
    ports.readInventory.mockImplementation(() => { throw new Error('Inventory unavailable.'); });
    expect(service.check(sourceRef)).toMatchObject({ impactCompleteness: 'unavailable', affectedExactBodyRefs: [], catalogRefs: [], projectionRefs: [] });
    ports.readInventory.mockReturnValue({ ...emptyInventory(), bodies: [{ bodyRef, sourceRefs: [{ snapshotId: 'invalid', sourceVersion: sha('bad') }] }] });
    expect(service.check(sourceRef).impactCompleteness).toBe('unavailable');
  });

  it('refuses an unrelated historical reference and invalid current bytes without guessing a change', () => {
    const original = snapshot(file()), { service, ports, sourceRef } = setup(original);
    ports.store.read.mockReturnValue({ status: 'available', snapshot: snapshot(file()) });
    expect(service.check(sourceRef)).toMatchObject({ current: { state: 'unavailable' }, historicalSource: { reason: 'version_mismatch' }, impactCompleteness: 'partial' });
    expect(ports.readCurrent).not.toHaveBeenCalled();
    const invalid = file(); invalid.rawUnits[0].rawByteDigest = sha('different');
    const reading = setup(undefined, { status: 'available', projection: invalid });
    expect(reading.service.check(reading.sourceRef)).toMatchObject({ current: { state: 'unavailable' }, inventoryCompleteness: 'complete', impactCompleteness: 'partial' });
  });

  it('propagates cancellation and rejects invalid references, selectors or host time before dependent reads', () => {
    const { service, ports, sourceRef } = setup(), controller = new AbortController(); controller.abort(new Error('authored cancellation'));
    expect(() => service.check(sourceRef, { signal: controller.signal })).toThrow('authored cancellation'); expect(ports.store.read).not.toHaveBeenCalled();
    expect(() => service.check({ ...sourceRef, snapshotId: 'invalid' })).toThrow(SourceUpdatesError);
    ports.now.mockReturnValue('not ISO'); expect(() => service.check(sourceRef)).toThrow('ISO'); expect(ports.store.read).not.toHaveBeenCalled();
    ports.now.mockReturnValue(at); const duringRead = new AbortController();
    ports.readCurrent.mockImplementation(() => { duringRead.abort(new Error('cancel during read')); return { status: 'available', projection: file() }; });
    expect(() => service.check(sourceRef, { signal: duringRead.signal })).toThrow('cancel during read'); expect(ports.readInventory).not.toHaveBeenCalled();
  });
});
