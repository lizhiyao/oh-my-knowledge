import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/knowledge/store.js';
import {
  ResolvedSourceSelectionSchema, SourceCurrentStateSchema, SourceDeletionMarkerSchema, SourceIdentitySchema, SourceMaterialAttributionSchema,
  SourceProjectionSchema, SourceRelativePathSchema, SourceResolutionSchema, SourceSelectionSchema, SourceSnapshotSchema,
  TraceOriginSchema, normalizeLineRanges, normalizeRecordRanges, resolveSourceLineRanges, sourceSetPreimage,
  sourceSnapshotProjection, sourceVersionPreimage, type SourceProjection,
} from '../../src/knowledge/sources.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const firstId = '00000000-0000-4000-8000-000000000001', secondId = '00000000-0000-4000-8000-000000000002';
const material = { materialType: 'design' as const, attributionBasis: 'host_declared' as const, reason: 'Authored contract fixture; a design statement, not execution.' };
const unknownMaterial = { materialType: 'unknown' as const, attributionBasis: 'unknown' as const, reason: 'No material attribution is available.' };
function file(): Extract<SourceProjection, { sourceKind: 'project_file' }> {
  const text = '\ufeffA\r\n😀', coordinate = { coordinateKind: 'file_range' as const, relativePath: 'docs/A.md', startLine: 1, endLine: 2, startByte: 0, endByte: 10 };
  return { projectionVersion: 'knowledge-window-v3', sourceKind: 'project_file', identity: { projectId: 'project', relativePath: 'docs/A.md' },
    selection: { lineRanges: [{ startLine: 1, endLine: 2 }] }, contentVersion: digest(text), material,
    provenance: { attributions: [], times: [] }, rawUnits: [{ unitId: 0, text, rawByteDigest: digest(text), rawByteLength: 10, coordinate }],
    excerpts: [{ unitId: 0, coordinate, text, material }], limitations: [] };
}
function snapshot(snapshotId = firstId, capturedAt = '2026-10-30T00:00:00Z') {
  const projection = file();
  return { ...projection, snapshotId, capturedAt, sourceVersion: digest(canonicalJson(sourceVersionPreimage(projection))),
    excerpts: projection.excerpts.map((excerpt, ordinal) => ({ ...excerpt, evidenceRef: `${snapshotId}:${ordinal}` })) };
}
function trace(): Extract<SourceProjection, { sourceKind: 'agent_trace' }> {
  const raw = '{"message":"hello"}';
  return { projectionVersion: 'knowledge-window-v3', sourceKind: 'agent_trace', identity: { sourceId: 'trace-1', traceKind: 'codex' },
    selection: { recordRanges: [{ startRecord: 4, endRecord: 4 }] }, contentVersion: digest(raw), material: unknownMaterial,
    origin: { threadId: 'thread', title: 'Historical trace', cwd: '/host-only/root' }, provenance: { attributions: [], times: [] },
    rawUnits: [{ unitId: 0, text: raw, rawByteDigest: digest(raw), rawByteLength: Buffer.byteLength(raw), coordinate: { coordinateKind: 'trace_record', recordIndex: 4 } }],
    excerpts: [{ unitId: 0, text: 'hello', coordinate: { coordinateKind: 'trace_event', recordIndex: 4, eventOrdinal: 0, eventKind: 'message', role: 'user' }, material: unknownMaterial }], limitations: [] };
}

describe('source-neutral contracts and stable identity', () => {
  it('normalizes explicit ranges without changing the caller and rejects empty, reversed or out-of-bounds selections', () => {
    const ranges = [{ startLine: 5, endLine: 6 }, { startLine: 1, endLine: 2 }, { startLine: 2, endLine: 4 }, { startLine: 5, endLine: 6 }];
    const original = structuredClone(ranges);
    expect(normalizeLineRanges(ranges, 8)).toEqual([{ startLine: 1, endLine: 6 }]);
    expect(ranges).toEqual(original);
    expect(normalizeRecordRanges([{ startRecord: 3, endRecord: 3 }, { startRecord: 0, endRecord: 1 }], 4))
      .toEqual([{ startRecord: 0, endRecord: 1 }, { startRecord: 3, endRecord: 3 }]);
    for (const invalid of [[], [{ startLine: 0, endLine: 1 }], [{ startLine: 2, endLine: 1 }], [{ startLine: 1, endLine: 9 }], [{ startLine: NaN, endLine: 1 }]]) {
      expect(() => normalizeLineRanges(invalid, 8)).toThrow();
    }
    expect(() => normalizeRecordRanges([{ startRecord: 0, endRecord: 1 }], 0)).toThrow();
    expect(() => normalizeLineRanges([], 0)).toThrow();
  });

  it('requires explicit whole-file selection and retains an empty file without inventing a line or excerpt', () => {
    expect(SourceSelectionSchema.parse({ sourceKind: 'project_file', projectId: 'project', relativePath: 'empty.txt', lineRanges: null })).toMatchObject({ lineRanges: null });
    expect(SourceSelectionSchema.safeParse({ sourceKind: 'project_file', projectId: 'project', relativePath: 'empty.txt', lineRanges: [] }).success).toBe(false);
    expect(resolveSourceLineRanges(null, 3)).toEqual([{ startLine: 1, endLine: 3 }]);
    expect(resolveSourceLineRanges(null, 0)).toEqual([]);
    const empty = { ...file(), identity: { projectId: 'project', relativePath: 'empty.txt' }, selection: { lineRanges: [] },
      rawUnits: [], excerpts: [], contentVersion: digest('') };
    expect(SourceProjectionSchema.parse(empty)).toEqual(empty);
    expect(SourceProjectionSchema.safeParse({ ...empty, contentVersion: digest('not empty') }).success).toBe(false);
    const raw = { unitId: 0, text: '', rawByteDigest: digest(''), rawByteLength: 0,
      coordinate: { coordinateKind: 'file_range' as const, relativePath: 'empty.txt', startLine: 1, endLine: 1, startByte: 0, endByte: 0 } };
    const invalidFile = { ...empty, selection: { lineRanges: [{ startLine: 1, endLine: 1 }] }, rawUnits: [raw],
      excerpts: [{ unitId: 0, text: '', coordinate: raw.coordinate, material }] };
    expect(SourceProjectionSchema.safeParse(invalidFile).success).toBe(false);
    expect(SourceProjectionSchema.safeParse({ ...invalidFile, contentVersion: digest('nonempty upstream') }).success).toBe(false);
    const identity = { ...empty.identity, objectHashAlgorithm: 'sha1' as const, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), blobOid: 'c'.repeat(40) };
    const { projectId: _projectId, ...fixedLocation } = identity;
    void _projectId;
    const coordinate = { ...raw.coordinate, ...fixedLocation, coordinateKind: 'git_blob_range' as const };
    const emptyGit = { ...empty, sourceKind: 'git_blob' as const, identity };
    expect(SourceProjectionSchema.parse(emptyGit)).toEqual(emptyGit);
    const invalidGit = { ...invalidFile, sourceKind: 'git_blob' as const, identity,
      rawUnits: [{ ...raw, coordinate }], excerpts: [{ ...invalidFile.excerpts[0], coordinate }] };
    expect(SourceProjectionSchema.safeParse(invalidGit).success).toBe(false);
    expect(SourceProjectionSchema.safeParse({ ...invalidGit, contentVersion: digest('nonempty upstream') }).success).toBe(false);
  });

  it.each(['/root/a', '../a', './a', 'a/../b', 'a//b', 'a/', 'C:/a', 'a\\b', 'a\0b', 'a\nb', 'a\ud800', 'a\udfff'])('rejects noncanonical relative path %j', path => {
    expect(SourceRelativePathSchema.safeParse(path).success).toBe(false);
  });

  it('uses logical namespaces rather than POSIX, Windows, UNC or home paths while retaining namespaced IDs', () => {
    expect(SourceIdentitySchema.parse({ sourceKind: 'agent_trace', sourceId: 'codex:thread-1', traceKind: 'codex' }))
      .toMatchObject({ sourceId: 'codex:thread-1' });
    for (const path of ['/Users/private/project', 'C:/project', 'C:\\project', '\\\\server\\share', '~/project', 'file:///project']) {
      expect(SourceIdentitySchema.safeParse({ sourceKind: 'agent_trace', sourceId: path, traceKind: 'codex' }).success).toBe(false);
      expect(SourceIdentitySchema.safeParse({ sourceKind: 'project_file', projectId: path, relativePath: 'a.md' }).success).toBe(false);
    }
    const relativePath = ' docs/e\u0301 😀.md ', projectId = 'project:😀', revision = 'branch-😀';
    expect(SourceRelativePathSchema.parse(relativePath)).toBe(relativePath);
    expect(SourceSelectionSchema.parse({ sourceKind: 'git_blob', projectId, relativePath, revision, lineRanges: null }))
      .toEqual({ sourceKind: 'git_blob', projectId, relativePath, revision, lineRanges: null });
    for (const invalid of ['x\ud800', 'x\udfff']) {
      expect(SourceIdentitySchema.safeParse({ sourceKind: 'agent_trace', sourceId: invalid, traceKind: 'codex' }).success).toBe(false);
      expect(SourceIdentitySchema.safeParse({ sourceKind: 'project_file', projectId: invalid, relativePath: 'a.md' }).success).toBe(false);
      expect(SourceSelectionSchema.safeParse({ sourceKind: 'git_blob', projectId, relativePath, revision: invalid, lineRanges: null }).success).toBe(false);
    }
  });

  it('keeps source selection discriminants strict and resolves Git selectors to matching fixed OIDs', () => {
    const selector = { sourceKind: 'git_blob', projectId: 'project', relativePath: 'a.ts', revision: 'main~1', lineRanges: null };
    expect(SourceSelectionSchema.parse(selector)).toEqual(selector);
    expect(ResolvedSourceSelectionSchema.safeParse(selector).success).toBe(false);
    for (const [objectHashAlgorithm, length] of [['sha1', 40], ['sha256', 64]] as const) {
      const resolved = { sourceKind: 'git_blob', projectId: 'project', relativePath: 'a.ts', objectHashAlgorithm,
        commitOid: 'a'.repeat(length), treeOid: 'b'.repeat(length), blobOid: 'c'.repeat(length), lineRanges: [{ startLine: 1, endLine: 1 }] };
      expect(ResolvedSourceSelectionSchema.parse(resolved)).toEqual(resolved);
      expect(ResolvedSourceSelectionSchema.safeParse({ ...resolved, blobOid: 'c'.repeat(length === 40 ? 64 : 40) }).success).toBe(false);
    }
    expect(SourceSelectionSchema.safeParse({ sourceKind: 'project_file', projectId: 'project', relativePath: 'a', lineRanges: null, startRecord: 1 }).success).toBe(false);
    expect(ResolvedSourceSelectionSchema.safeParse({ sourceKind: 'project_file', projectId: 'project', relativePath: 'a', lineRanges: [{ startLine: 2, endLine: 2 }, { startLine: 1, endLine: 1 }] }).success).toBe(false);
    expect(ResolvedSourceSelectionSchema.safeParse({ sourceKind: 'agent_trace', sourceId: 't', traceKind: 'codex', recordRanges: [] }).success).toBe(false);
    expect(ResolvedSourceSelectionSchema.safeParse({ sourceKind: 'project_file', projectId: 'project', relativePath: 'a', lineRanges: [{ startLine: 2, endLine: 1 }] }).success).toBe(false);
  });

  it('preserves BOM, CRLF, astral text, byte coordinates and host-owned snapshot evidence identities', () => {
    const saved = snapshot();
    expect(SourceSnapshotSchema.parse(saved)).toEqual(saved);
    expect(saved.excerpts[0].text).toBe('\ufeffA\r\n😀');
    expect(saved.excerpts[0].text.length).toBe(6);
    const invalid = [
      { ...saved, origin: { threadId: 'fake-file-thread', title: '' } },
      { ...saved, excerpts: [{ ...saved.excerpts[0], evidenceRef: `${secondId}:0` }] },
      { ...saved, rawUnits: [{ ...saved.rawUnits[0], unitId: 99 }] },
      { ...saved, rawUnits: [{ ...saved.rawUnits[0], rawByteLength: 6 }] },
      { ...saved, excerpts: [{ ...saved.excerpts[0], text: 'A\n😀' }] },
      { ...saved, excerpts: [] },
      { ...saved, rawUnits: [{ ...saved.rawUnits[0], text: '\ud800', rawByteLength: 3 }] },
    ];
    for (const value of invalid) expect(SourceSnapshotSchema.safeParse(value).success).toBe(false);
  });

  it('validates trace source coordinates without fabricating trace fields on files', () => {
    const projection = trace();
    expect(SourceProjectionSchema.parse(projection)).toEqual(projection);
    expect(TraceOriginSchema.parse({ threadId: 'thread', turnId: 'turn', title: '', cwd: '/project' }))
      .toEqual({ threadId: 'thread', turnId: 'turn', title: '', cwd: '/project' });
    expect(SourceProjectionSchema.safeParse({ ...projection, selection: { recordRanges: [{ startRecord: 4, endRecord: 5 }] } }).success).toBe(false);
    expect(SourceProjectionSchema.safeParse({ ...projection, excerpts: [{ ...projection.excerpts[0], coordinate: { ...projection.excerpts[0].coordinate, recordIndex: 5 } }] }).success).toBe(false);
    expect(SourceProjectionSchema.safeParse({ ...projection, excerpts: [projection.excerpts[0], projection.excerpts[0]] }).success).toBe(false);
  });

  it('freezes a complete canonical preimage independent of capture IDs, capture time and trace host paths', () => {
    const first = snapshot(), second = snapshot(secondId, '2026-10-31T09:30:00+08:00');
    const preimage = sourceVersionPreimage(sourceSnapshotProjection(first));
    expect(preimage).toEqual({ identityVersion: 'knowledge-source-version/v1', projectionVersion: 'knowledge-window-v3',
      sourceKind: 'project_file', identity: { projectId: 'project', relativePath: 'docs/A.md' }, selection: { lineRanges: [{ startLine: 1, endLine: 2 }] },
      contentVersion: digest('\ufeffA\r\n😀'), material, provenance: { attributions: [], times: [] },
      selectedUnits: [{ coordinate: file().rawUnits[0].coordinate, rawByteDigest: digest('\ufeffA\r\n😀'), rawByteLength: 10 }],
      excerpts: [{ coordinate: file().excerpts[0].coordinate, text: '\ufeffA\r\n😀', material }], limitations: [] });
    expect(sourceVersionPreimage(sourceSnapshotProjection(second))).toEqual(preimage);
    for (const excluded of ['snapshotId', 'capturedAt', 'evidenceRef', 'unitId', '/host-only/root']) expect(canonicalJson(preimage)).not.toContain(excluded);
    const oldTrace = { ...trace(), origin: { threadId: 'thread', turnId: 'turn', title: 'Historical trace', cwd: '/host-only/root' } };
    const tracePreimage = sourceVersionPreimage(oldTrace);
    expect(tracePreimage).toMatchObject({ origin: { threadId: 'thread', turnId: 'turn', title: 'Historical trace' } });
    expect(canonicalJson(tracePreimage)).not.toContain('cwd');
    expect(sourceVersionPreimage({ ...oldTrace, origin: { ...oldTrace.origin, cwd: '/other/root' } })).toEqual(tracePreimage);
    for (const origin of [
      { ...oldTrace.origin, threadId: 'other-thread' },
      { ...oldTrace.origin, turnId: 'other-turn' },
      { ...oldTrace.origin, title: 'Other original title' },
    ]) expect(sourceVersionPreimage({ ...oldTrace, origin })).not.toEqual(tracePreimage);
    expect(SourceProjectionSchema.safeParse({ ...file(), provenance: { attributions: [], times: [
      { timeKind: 'captured_at', at: '2026-10-30T00:00:00Z', basis: 'host_observed' },
    ] } }).success).toBe(false);
  });

  it('includes material, fixed Git provenance and projected text in version identity', () => {
    const projection = file(), baseline = canonicalJson(sourceVersionPreimage(projection));
    expect(canonicalJson(sourceVersionPreimage({ ...projection, material: { ...material, materialType: 'implementation' } }))).not.toBe(baseline);
    expect(canonicalJson(sourceVersionPreimage({ ...projection, provenance: { attributions: [{ role: 'author', name: 'A', basis: 'source_declared' }], times: [] } }))).not.toBe(baseline);
    const raw = trace();
    expect(canonicalJson(sourceVersionPreimage({ ...raw, excerpts: [{ ...raw.excerpts[0], text: 'different projection' }] })))
      .not.toBe(canonicalJson(sourceVersionPreimage(raw)));
    const identity = { ...projection.identity, objectHashAlgorithm: 'sha256' as const, commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64), blobOid: 'c'.repeat(64) };
    const { projectId: _projectId, ...fixedLocation } = identity;
    void _projectId;
    const fileCoordinate = projection.rawUnits[0].coordinate;
    if (fileCoordinate.coordinateKind !== 'file_range') throw new Error('Expected file coordinate fixture.');
    const coordinate = { ...fileCoordinate, ...fixedLocation, coordinateKind: 'git_blob_range' as const };
    const git: Extract<SourceProjection, { sourceKind: 'git_blob' }> = { ...projection, sourceKind: 'git_blob', identity,
      rawUnits: [{ ...projection.rawUnits[0], coordinate }], excerpts: [{ ...projection.excerpts[0], coordinate }] };
    const nextIdentity = { ...identity, commitOid: 'd'.repeat(64) }, nextCoordinate = { ...coordinate, commitOid: nextIdentity.commitOid };
    const later = { ...git, identity: nextIdentity, rawUnits: [{ ...git.rawUnits[0], coordinate: nextCoordinate }], excerpts: [{ ...git.excerpts[0], coordinate: nextCoordinate }] };
    expect(sourceVersionPreimage(later)).not.toEqual(sourceVersionPreimage(git));
    expect(SourceMaterialAttributionSchema.safeParse({ ...material, attributionBasis: 'file_extension' }).success).toBe(false);
    expect(SourceMaterialAttributionSchema.safeParse({ ...material, attributionBasis: 'unknown' }).success).toBe(false);
  });

  it('canonicalizes a source set without mutating callers and rejects contradictory versions of one snapshot', () => {
    const first = { snapshotId: firstId, sourceVersion: digest('one') }, second = { snapshotId: secondId, sourceVersion: digest('two') };
    const refs = [second, first, second], original = structuredClone(refs);
    expect(sourceSetPreimage(refs)).toEqual({ sourceSetVersion: 'knowledge-source-set/v1', sources: [first, second] });
    expect(refs).toEqual(original);
    expect(() => sourceSetPreimage([first, { ...first, sourceVersion: digest('other') }])).toThrow('One immutable snapshot');
    expect(() => sourceSetPreimage([])).toThrow();
  });

  it('distinguishes unavailable captured content from an upstream deletion and keeps tombstones content-free', () => {
    const saved = snapshot(), sourceRef = { snapshotId: saved.snapshotId, sourceVersion: saved.sourceVersion };
    expect(SourceResolutionSchema.parse({ status: 'available', snapshot: saved }).status).toBe('available');
    expect(SourceResolutionSchema.safeParse({ status: 'available', window: saved }).success).toBe(false);
    expect(SourceCurrentStateSchema.parse({ sourceRef, checkedAt: '2026-10-31T00:00:00Z', state: 'deleted', limitations: [] }).state).toBe('deleted');
    expect(SourceResolutionSchema.parse({ status: 'unavailable', reason: 'permission_denied', detail: 'Read scope was not granted.' }).status).toBe('unavailable');
    const marker = { ...sourceRef, projectionVersion: 'knowledge-window-v3', deleted: true };
    expect(SourceDeletionMarkerSchema.parse(marker)).toEqual(marker);
    expect(SourceDeletionMarkerSchema.safeParse({ ...marker, rawUnits: saved.rawUnits }).success).toBe(false);
    expect(SourceSnapshotSchema.safeParse(marker).success).toBe(false);
  });
});
