import { createHash } from 'node:crypto';
import type { SourceExcerpt, SourceMaterialAttribution, SourceRef, SourceSnapshot, TraceOrigin } from '../../../src/knowledge/sources';
import { normalizeRecordRanges } from '../../../src/knowledge/sources';
import { sourceSummary } from '../../../src/knowledge/application/source-summary';

const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const at = '2026-10-30T00:00:00Z';
type TraceExcerpt = { evidenceRef: string; text: string; recordIndex: number; eventKind: string; role?: string; timestamp?: string };
const material = (materialType: SourceMaterialAttribution['materialType']): SourceMaterialAttribution => ({ materialType,
  attributionBasis: 'host_declared', reason: 'Authored UI material classification; not semantic or execution acceptance.' });

/** Authored view data preserves the existing quote locators; storage admission has separate Source3 tests. */
export function traceSourceFixture(ref: SourceRef, excerpts: TraceExcerpt[], options: { origin?: TraceOrigin; limitations?: string[] } = {}): Extract<SourceSnapshot, { sourceKind: 'agent_trace' }> {
  const indexes = [...new Set(excerpts.map(excerpt => excerpt.recordIndex))].sort((a, b) => a - b);
  const rawUnits = indexes.map((recordIndex, unitId) => {
    const text = JSON.stringify(excerpts.filter(excerpt => excerpt.recordIndex === recordIndex));
    return { unitId, text, rawByteDigest: digest(text), rawByteLength: Buffer.byteLength(text), coordinate: { coordinateKind: 'trace_record' as const, recordIndex } };
  });
  return { ...ref, sourceKind: 'agent_trace', projectionVersion: 'knowledge-window-v3', contentVersion: digest(rawUnits.map(unit => unit.text).join('\n')),
    identity: { sourceId: 'ui-fixture:trace', traceKind: 'codex' }, selection: { recordRanges: normalizeRecordRanges(indexes.map(recordIndex => ({ startRecord: recordIndex, endRecord: recordIndex })), indexes.at(-1)!) },
    material: material('discussion'), provenance: { attributions: [], times: [] }, capturedAt: at, rawUnits,
    excerpts: excerpts.map((excerpt, index): SourceExcerpt => ({ evidenceRef: excerpt.evidenceRef, text: excerpt.text,
      unitId: indexes.indexOf(excerpt.recordIndex), coordinate: { coordinateKind: 'trace_event', recordIndex: excerpt.recordIndex,
        eventOrdinal: excerpts.slice(0, index).filter(value => value.recordIndex === excerpt.recordIndex).length, eventKind: excerpt.eventKind,
        ...(excerpt.role ? { role: excerpt.role } : {}), ...(excerpt.timestamp ? { timestamp: excerpt.timestamp } : {}) }, material: material('discussion') })),
    limitations: options.limitations ?? [], ...(options.origin ? { origin: options.origin } : {}) };
}

export function fileSourceFixture(ref: SourceRef, text: string, options: { sourceKind?: 'project_file' | 'git_blob'; relativePath?: string;
  materialType?: SourceMaterialAttribution['materialType']; startLine?: number; startByte?: number } = {}): SourceSnapshot {
  const sourceKind = options.sourceKind ?? 'project_file', relativePath = options.relativePath ?? 'docs/knowledge.md';
  const startLine = options.startLine ?? 3, startByte = options.startByte ?? 17;
  const identity = { projectId: 'project-alpha', relativePath }, git = { objectHashAlgorithm: 'sha1' as const, commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), blobOid: 'c'.repeat(40) };
  const endLine = startLine + Math.max(0, text.replace(/\n$/u, '').split('\n').length - 1), endByte = startByte + Buffer.byteLength(text);
  const coordinate = sourceKind === 'git_blob' ? { coordinateKind: 'git_blob_range' as const, relativePath, ...git, startLine, endLine, startByte, endByte }
    : { coordinateKind: 'file_range' as const, relativePath, startLine, endLine, startByte, endByte };
  const declared = material(options.materialType ?? 'design');
  const shared = { ...ref, projectionVersion: 'knowledge-window-v3' as const, contentVersion: digest(text), material: declared,
    provenance: { attributions: [], times: [] }, capturedAt: at, selection: { lineRanges: [{ startLine, endLine }] },
    rawUnits: [{ unitId: 0, text, rawByteDigest: digest(text), rawByteLength: Buffer.byteLength(text), coordinate }],
    excerpts: [{ unitId: 0, text, evidenceRef: `${ref.snapshotId}:0`, coordinate, material: declared }], limitations: ['Only the selected, fixed source range.'] };
  return sourceKind === 'git_blob' ? { ...shared, sourceKind, identity: { ...identity, ...git } } : { ...shared, sourceKind, identity };
}
export { sourceSummary as sourceSummaryFixture };
