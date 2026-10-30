import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../store.js';
import { ResolvedSourceSelectionSchema, SourceDigestSchema, SourceProjectionSchema, SourceSelectionSchema,
  normalizeLineRanges, normalizeRecordRanges, sourceVersionPreimage,
  type ResolvedSourceSelection, type SourceProjection, type SourceSelection } from '../sources.js';
import type { SourceCaptureOptions, SourceStore } from '../source-store.js';

export const SOURCE_CAPTURE_MAX_SOURCES = 256;
export const SOURCE_CAPTURE_MAX_READ_BYTES = 64 * 1024 * 1024;
export const SOURCE_CAPTURE_READ_RESERVATION_BYTES = 17 * 1024 * 1024;
export const SOURCE_CAPTURE_MAX_SELECTED_BYTES = 4 * 1024 * 1024;
export const SOURCE_CAPTURE_MAX_PROJECTION_BYTES = 16 * 1024 * 1024;
export const SOURCE_CAPTURE_MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_SELECTION_BYTES = 2 * 1024 * 1024;
const digest = (text: string) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
type ReadManifest = { contentBytes: number; metadataBytes: number; totalBytes: number; selectedTextBytes: number;
  selectedRawRanges?: { recordIndex: number; startByte: number; endByte: number }[] | null };
export interface SourceCaptureReading {
  projection: SourceProjection; sourceVersion: string; resolvedSelection: ResolvedSourceSelection; readManifest: ReadManifest;
}
/** Readers close over trusted project/trace bindings. The revision changes whenever those bindings or consent are changed/revoked. */
export interface SourceCapturePorts {
  read(selection: SourceSelection, signal?: AbortSignal): SourceCaptureReading;
  readResolved(selection: ResolvedSourceSelection, signal?: AbortSignal): SourceCaptureReading;
  currentScopeRevision(): string;
  store: Pick<SourceStore, 'captureBatch'>;
}
export type SourceCaptureErrorCode = 'capacity_exceeded' | 'invalid_selection' | 'invalid_reading' | 'preview_mismatch' | 'scope_changed' | 'source_changed';
export class SourceCaptureError extends Error {
  constructor(readonly code: SourceCaptureErrorCode, message: string) { super(message); this.name = 'SourceCaptureError'; }
}
function capacity(): never { throw new SourceCaptureError('capacity_exceeded', 'Source batch capacity exceeded; choose fewer sources or smaller selections.'); }

/** Count compact JSON in bounded slices before cloning, Schema traversal or full serialization. */
function jsonBytes(input: unknown, limit: number): number {
  let bytes = 0, nodes = 0; const active = new Set<object>();
  const add = (amount: number) => { bytes += amount; if (bytes > limit) capacity(); };
  const string = (value: string) => {
    add(2);
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + 16_384, value.length);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end])) end--;
      add(Buffer.byteLength(JSON.stringify(value.slice(start, end))) - 2); start = end;
    }
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 1_000_000 || depth > 32) capacity();
    if (typeof value === 'string') { string(value); return; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) { add(JSON.stringify(value).length); return; }
    if (!value || typeof value !== 'object' || active.has(value)) throw new SourceCaptureError('invalid_reading', 'Source material must be finite JSON data.');
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null || Object.getOwnPropertyDescriptor(value, 'toJSON')) throw new SourceCaptureError('invalid_reading', 'Source material must be plain JSON data.');
    if (array && value.length > 100_000) capacity();
    active.add(value); add(2); let count = 0;
    const keys = array ? Array.from({ length: value.length }, (_, index) => String(index)) : Object.keys(value);
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property)) throw new SourceCaptureError('invalid_reading', 'Source material contains an accessor or array hole.');
      if (property.value === undefined && !array) continue;
      if (count++) add(1);
      if (!array) { string(key); add(1); }
      visit(property.value, depth + 1);
    }
    active.delete(value);
  };
  visit(input, 0); return bytes;
}
function jsonData(input: unknown, limit: number): unknown { jsonBytes(input, limit); return JSON.parse(JSON.stringify(input)); }
function freeze<T>(input: T): T {
  if (input && typeof input === 'object' && !Object.isFrozen(input)) { Object.values(input).forEach(freeze); Object.freeze(input); }
  return input;
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const manifestSchema = z.strictObject({ contentBytes: count, metadataBytes: count, totalBytes: count, selectedTextBytes: count,
  selectedRawRanges: z.array(z.strictObject({ recordIndex: count, startByte: count, endByte: count })
    .refine(range => range.startByte <= range.endByte)).max(100_000).nullable().optional() });
type CheckedReading = SourceCaptureReading & { preimage: string; projectionBytes: number };
function checkedReading(input: SourceCaptureReading): CheckedReading {
  const projectionBytes = jsonBytes(input.projection, SOURCE_CAPTURE_MAX_PROJECTION_BYTES);
  const projection = SourceProjectionSchema.parse(jsonData(input.projection, SOURCE_CAPTURE_MAX_PROJECTION_BYTES));
  const resolvedSelection = ResolvedSourceSelectionSchema.parse(input.resolvedSelection);
  const derived = { sourceKind: projection.sourceKind, ...projection.identity, ...projection.selection };
  if (canonicalJson(derived) !== canonicalJson(resolvedSelection)) throw new SourceCaptureError('invalid_reading', 'Source projection does not match its resolved selection.');
  for (const unit of projection.rawUnits) if (digest(unit.text) !== unit.rawByteDigest) throw new SourceCaptureError('invalid_reading', 'Source raw-unit digest mismatch.');
  const preimage = canonicalJson(sourceVersionPreimage(projection));
  if (digest(preimage) !== SourceDigestSchema.parse(input.sourceVersion)) throw new SourceCaptureError('invalid_reading', 'Source version does not bind its exact material.');
  const readManifest = manifestSchema.parse(jsonData(input.readManifest, SOURCE_CAPTURE_MAX_PROJECTION_BYTES));
  if (readManifest.contentBytes + readManifest.metadataBytes !== readManifest.totalBytes
    || readManifest.totalBytes > SOURCE_CAPTURE_READ_RESERVATION_BYTES
    || readManifest.selectedTextBytes > readManifest.contentBytes
    || projection.rawUnits.reduce((sum, unit) => sum + unit.rawByteLength, 0) !== readManifest.selectedTextBytes) {
    throw new SourceCaptureError('invalid_reading', 'Source actual-read manifest does not match the retained material.');
  }
  if (readManifest.selectedRawRanges !== undefined && projection.sourceKind !== 'agent_trace') throw new SourceCaptureError('invalid_reading', 'File material cannot claim trace record offsets.');
  if (readManifest.selectedRawRanges) {
    if (readManifest.selectedRawRanges.length !== projection.rawUnits.length || readManifest.selectedRawRanges.some((range, ordinal) => {
      const unit = projection.rawUnits[ordinal]; return unit.coordinate.coordinateKind !== 'trace_record'
        || range.recordIndex !== unit.coordinate.recordIndex || range.endByte - range.startByte !== unit.rawByteLength;
    })) throw new SourceCaptureError('invalid_reading', 'Original trace byte ranges do not match retained records.');
  }
  return { projection, sourceVersion: input.sourceVersion, resolvedSelection, readManifest, preimage, projectionBytes };
}
function bindRequested(requested: SourceSelection, reading: CheckedReading): void {
  const resolved = reading.resolvedSelection;
  if (requested.sourceKind !== resolved.sourceKind) throw new SourceCaptureError('invalid_reading', 'Reader changed the selected source type.');
  if (requested.sourceKind === 'agent_trace' && resolved.sourceKind === 'agent_trace') {
    if (requested.sourceId !== resolved.sourceId || requested.traceKind !== resolved.traceKind
      || canonicalJson(normalizeRecordRanges(requested.recordRanges, Math.max(...requested.recordRanges.map(range => range.endRecord)))) !== canonicalJson(resolved.recordRanges)) {
      throw new SourceCaptureError('invalid_reading', 'Reader changed the selected original trace records.');
    }
  } else if (requested.sourceKind !== 'agent_trace' && resolved.sourceKind !== 'agent_trace') {
    if (requested.projectId !== resolved.projectId || requested.relativePath !== resolved.relativePath
      || requested.lineRanges !== null && canonicalJson(normalizeLineRanges(requested.lineRanges,
        Math.max(...requested.lineRanges.map(range => range.endLine)))) !== canonicalJson(resolved.lineRanges)) {
      throw new SourceCaptureError('invalid_reading', 'Reader changed the selected project path or lines.');
    }
  }
}
function materialSource(reading: CheckedReading, sourceOrdinal: number) {
  const { projection } = reading, origin = projection.sourceKind === 'agent_trace' ? projection.origin : undefined;
  return { sourceOrdinal, sourceKind: projection.sourceKind, sourceVersion: reading.sourceVersion, identity: projection.identity,
    selection: projection.selection, material: projection.material, provenance: projection.provenance, limitations: projection.limitations,
    ...(origin ? { origin: { threadId: origin.threadId, ...(origin.turnId === undefined ? {} : { turnId: origin.turnId }), title: origin.title } } : {}),
    excerpts: projection.excerpts.map((excerpt, excerptOrdinal) => ({ excerptOrdinal, ...excerpt })) };
}
export interface SourcePreviewOptions { afterDeletion?: 'new_snapshot'; signal?: AbortSignal; expectedDigest?: string }
type ReadReport = { items: { sourceOrdinal: number; actual: ReadManifest }[]; totalBytes: number; selectedTextBytes: number };
function readReport(readings: readonly CheckedReading[]): ReadReport {
  return { items: readings.map((reading, sourceOrdinal) => ({ sourceOrdinal, actual: reading.readManifest })),
    totalBytes: readings.reduce((sum, reading) => sum + reading.readManifest.totalBytes, 0),
    selectedTextBytes: readings.reduce((sum, reading) => sum + reading.readManifest.selectedTextBytes, 0) };
}

/** One bounded, in-memory preview per host instance; no authority registry, persisted grant or execution ledger. */
export class SourceCaptureService {
  private pending?: { previewId: string; previewDigest: string; scopeRevision: string; readings: CheckedReading[]; afterDeletion?: 'new_snapshot' };
  constructor(private readonly ports: SourceCapturePorts) {}
  private scope(): string {
    const value = this.ports.currentScopeRevision();
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new SourceCaptureError('scope_changed', 'A trusted host scope revision is required.');
    return value;
  }
  private assertScope(expected: string): void {
    if (this.scope() !== expected) throw new SourceCaptureError('scope_changed', 'Source scope changed or was revoked; create and confirm a new preview.');
  }
  private collect(selections: readonly (SourceSelection | ResolvedSourceSelection)[], resolved: boolean, scopeRevision: string, signal?: AbortSignal): CheckedReading[] {
    const readings: CheckedReading[] = []; let totalRead = 0, selected = 0, projectionBytes = 0;
    for (const selection of selections) {
      signal?.throwIfAborted(); this.assertScope(scopeRevision);
      // Existing readers cap one content read at 16 MiB; reserve another MiB for bounded Git metadata before starting it.
      if (totalRead + SOURCE_CAPTURE_READ_RESERVATION_BYTES > SOURCE_CAPTURE_MAX_READ_BYTES) capacity();
      const reading = checkedReading(resolved ? this.ports.readResolved(selection as ResolvedSourceSelection, signal) : this.ports.read(selection as SourceSelection, signal));
      this.assertScope(scopeRevision); signal?.throwIfAborted();
      if (resolved ? canonicalJson(selection) !== canonicalJson(reading.resolvedSelection) : false) throw new SourceCaptureError('source_changed', 'Reader changed a fixed preview selection.');
      if (!resolved) bindRequested(selection as SourceSelection, reading);
      totalRead += reading.readManifest.totalBytes; selected += reading.readManifest.selectedTextBytes; projectionBytes += reading.projectionBytes;
      if (totalRead > SOURCE_CAPTURE_MAX_READ_BYTES || selected > SOURCE_CAPTURE_MAX_SELECTED_BYTES || projectionBytes > SOURCE_CAPTURE_MAX_PROJECTION_BYTES) capacity();
      readings.push(reading);
    }
    return readings;
  }
  private prepare(input: readonly (SourceSelection | ResolvedSourceSelection)[], resolved: boolean, options: SourcePreviewOptions) {
    this.pending = undefined; options.signal?.throwIfAborted();
    if (options.afterDeletion !== undefined && options.afterDeletion !== 'new_snapshot') throw new SourceCaptureError('invalid_selection', 'Invalid after-deletion preview option.');
    if (options.expectedDigest !== undefined && !SourceDigestSchema.safeParse(options.expectedDigest).success) throw new SourceCaptureError('preview_mismatch', 'An exact semantic preview digest is required.');
    if (!Array.isArray(input) || !input.length) throw new SourceCaptureError('invalid_selection', 'Select at least one source.');
    if (input.length > SOURCE_CAPTURE_MAX_SOURCES) capacity();
    const data = jsonData(input, MAX_SELECTION_BYTES);
    const selections = resolved ? z.array(ResolvedSourceSelectionSchema).parse(data) : z.array(SourceSelectionSchema).parse(data);
    const scopeRevision = this.scope(), readings = this.collect(selections, resolved, scopeRevision, options.signal);
    const modelMaterial = { contentKind: 'knowledge-source-material/v1', sources: readings.map(materialSource) };
    jsonBytes(modelMaterial, SOURCE_CAPTURE_MAX_PREVIEW_BYTES);
    const json = JSON.stringify(modelMaterial), materialJsonBytes = Buffer.byteLength(json), materialDigest = digest(json);
    const excerptManifest = readings.flatMap((reading, sourceOrdinal) => reading.projection.excerpts.map((excerpt, excerptOrdinal) => ({ sourceOrdinal, excerptOrdinal,
      textDigest: digest(excerpt.text), textUtf8Bytes: Buffer.byteLength(excerpt.text), textJsonBytes: Buffer.byteLength(JSON.stringify(excerpt.text)) })));
    const sendDraft = { authorization: 'not_granted' as const, json, materialDigest, materialJsonBytes, excerpts: excerptManifest,
      neutralMetadataJsonBytes: materialJsonBytes - excerptManifest.reduce((sum, excerpt) => sum + excerpt.textJsonBytes, 0),
      scope: 'Selected excerpt material only; the final system, complete model input and network request require separate journal confirmation.' };
    const savePlan = { afterDeletion: options.afterDeletion ?? 'reject', projections: readings.map((reading, sourceOrdinal) => ({ sourceOrdinal,
      sourceVersion: reading.sourceVersion, projectionJsonBytes: reading.projectionBytes, selectedRawBytes: reading.readManifest.selectedTextBytes,
      rawUnitCount: reading.projection.rawUnits.length, excerptCount: reading.projection.excerpts.length })),
      actualSnapshotsWritten: 0, actualWrittenBytes: 0 };
    const semantic = { previewVersion: 'knowledge-source-preview/v1', scopeRevision,
      sources: readings.map(reading => ({ resolvedSelection: reading.resolvedSelection, preimage: JSON.parse(reading.preimage) })),
      sendMaterial: modelMaterial, saveOptions: { afterDeletion: options.afterDeletion ?? 'reject' } };
    jsonBytes(semantic, SOURCE_CAPTURE_MAX_PREVIEW_BYTES);
    const previewDigest = digest(canonicalJson(semantic)), previewId = randomUUID();
    if (options.expectedDigest !== undefined && options.expectedDigest !== previewDigest) throw new SourceCaptureError('preview_mismatch', 'Rebuilt preview differs from the confirmed semantic digest.');
    const preview = { previewId, previewDigest, scopeRevision, items: readings.map((reading, sourceOrdinal) => ({ sourceOrdinal,
      resolvedSelection: reading.resolvedSelection, sourceVersion: reading.sourceVersion, material: reading.projection.material,
      retainedUnits: reading.projection.rawUnits, excerpts: reading.projection.excerpts, limitations: reading.projection.limitations })),
      readManifest: readReport(readings), sendDraft, savePlan };
    jsonBytes(preview, SOURCE_CAPTURE_MAX_PREVIEW_BYTES); this.assertScope(scopeRevision); options.signal?.throwIfAborted();
    this.pending = { previewId, previewDigest, scopeRevision, readings, ...(options.afterDeletion ? { afterDeletion: options.afterDeletion } : {}) };
    return freeze(preview);
  }
  preview(selections: readonly SourceSelection[], options: SourcePreviewOptions = {}) { return this.prepare(selections, false, options); }
  /** A CLI can rebuild from fixed selections, compare the stable digest, then confirm its new local preview ID. */
  previewResolved(selections: readonly ResolvedSourceSelection[], options: SourcePreviewOptions = {}) { return this.prepare(selections, true, options); }
  capture(confirmation: { previewId: string; previewDigest: string }, options: { signal?: AbortSignal } = {}) {
    const pending = this.pending;
    if (!pending || confirmation.previewId !== pending.previewId || confirmation.previewDigest !== pending.previewDigest) throw new SourceCaptureError('preview_mismatch', 'Capture requires the exact active preview ID and semantic digest.');
    this.assertScope(pending.scopeRevision); options.signal?.throwIfAborted();
    const readings = this.collect(pending.readings.map(reading => reading.resolvedSelection), true, pending.scopeRevision, options.signal);
    if (readings.some((reading, ordinal) => reading.preimage !== pending.readings[ordinal].preimage)) throw new SourceCaptureError('source_changed', 'Selected source material changed; create and confirm a new preview.');
    this.assertScope(pending.scopeRevision); options.signal?.throwIfAborted();
    const captureOptions: SourceCaptureOptions = { ...(options.signal ? { signal: options.signal } : {}), ...(pending.afterDeletion ? { afterDeletion: pending.afterDeletion } : {}) };
    // The store preflights every item, deletion state, deduplication and directory capacity under one lock before publication.
    // An I/O interruption can still publish a prefix; retrying these identical inputs reuses that prefix.
    const saved = this.ports.store.captureBatch(readings.map(reading => reading.projection), captureOptions);
    return { previewDigest: pending.previewDigest, scopeRevision: pending.scopeRevision, sources: saved.sources,
      readManifest: readReport(readings), saveManifest: { actualWrittenBytes: saved.writtenBytes,
        items: saved.sources.map((source, sourceOrdinal) => ({ sourceOrdinal, snapshotId: source.snapshot.snapshotId,
          sourceVersion: source.snapshot.sourceVersion, reused: source.reused })) },
      sendAuthorization: 'not_granted' as const };
  }
}
