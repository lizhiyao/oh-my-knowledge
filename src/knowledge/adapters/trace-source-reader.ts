import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { isAbsolute } from 'node:path';
import { detectJsonlTraceSource, type CcRecord } from '../../observability/trace/source.js';
import type { TraceEvent } from '../../observability/trace/trace-ir.js';
import { canonicalJson } from '../store.js';
import { ResolvedSourceSelectionSchema, SOURCE_PROJECTION_VERSION, SourceMaterialAttributionSchema,
  SourceProjectionSchema, SourceProvenanceSchema, SourceSelectionSchema, TraceOriginSchema, normalizeRecordRanges, sourceVersionPreimage,
  type ResolvedSourceSelection, type SourceMaterialAttribution, type SourceProjection, type SourceProvenance,
  type SourceSelection, type TraceOrigin } from '../sources.js';

export const TRACE_SOURCE_MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 100_000;
type TraceSelection = Extract<SourceSelection, { sourceKind: 'agent_trace' }>;
type TraceProjection = Extract<SourceProjection, { sourceKind: 'agent_trace' }>;
type TraceResolvedSelection = Extract<ResolvedSourceSelection, { sourceKind: 'agent_trace' }>;
type RawRecord = { recordIndex: number; raw: string };
type RawRange = { recordIndex: number; startByte: number; endByte: number };
type ReadFailure = 'missing' | 'permission_denied' | 'unsupported' | 'version_mismatch';

export class TraceSourceReadError extends Error {
  constructor(readonly reason: ReadFailure, message: string) { super(message); this.name = 'TraceSourceReadError'; }
}
/** Only the trusted host constructs source bindings; portable selectors cannot supply file paths or raw records. */
export interface TraceSourceReadContext {
  sourceId: string; traceKind: string;
  source: { sourceType: 'file'; approvedPath: string } | { sourceType: 'records'; records: readonly RawRecord[] };
  origin?: TraceOrigin; material?: SourceMaterialAttribution; signal?: AbortSignal;
}
export interface TraceSourceReading {
  projection: TraceProjection; sourceVersion: string; resolvedSelection: TraceResolvedSelection;
  readManifest: { contentBytes: number; metadataBytes: number; totalBytes: number; selectedTextBytes: number;
    selectedRawRanges: RawRange[] | null };
}
const hash = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function unsupported(message: string): never { throw new TraceSourceReadError('unsupported', message); }
function changed(): never { throw new TraceSourceReadError('version_mismatch', 'Trace source changed while being read; preview it again.'); }
const sameFile = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function exactText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return unsupported('Trace source is not valid UTF-8 text.'); }
}
function exactString(raw: unknown): raw is string {
  return typeof raw === 'string' && Buffer.from(raw, 'utf8').toString('utf8') === raw;
}

function fileRecords(approvedPath: string, selectedRanges: TraceSelection['recordRanges'], signal?: AbortSignal): { records: RawRecord[]; ranges: RawRange[]; contentBytes: number } {
  if (!isAbsolute(approvedPath) || /[\u0000-\u001f\u007f]/u.test(approvedPath)) unsupported('An explicit absolute trace file binding is required.');
  const before = lstatSync(approvedPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) unsupported('Select one regular trace file; symbolic links are unsupported.');
  const path = realpathSync(approvedPath); let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    if (!sameFile(before, opened)) changed();
    const records: RawRecord[] = [], ranges: RawRange[] = [];
    const finalRecord = Math.max(...selectedRanges.map(range => range.endRecord));
    const chunk = Buffer.allocUnsafe(64 * 1024); let pending = Buffer.alloc(0), startByte = 0, contentBytes = 0;
    let recordIndex = 0, finished = false;
    const collect = (bytes: Buffer) => {
      signal?.throwIfAborted();
      const raw = exactText(bytes), endByte = startByte + bytes.length;
      // Match the existing trace index convention: only nonempty JSONL lines count as records.
      if (raw.trim()) {
        if (selectedRanges.some(range => recordIndex >= range.startRecord && recordIndex <= range.endRecord)) {
          if (records.length >= MAX_RECORDS) unsupported('Selected trace exceeds record capacity.');
          records.push({ recordIndex, raw }); ranges.push({ recordIndex, startByte, endByte });
        }
        finished = recordIndex++ >= finalRecord;
      }
      startByte = endByte;
    };
    while (!finished) {
      signal?.throwIfAborted();
      const remaining = TRACE_SOURCE_MAX_READ_BYTES - contentBytes;
      if (!remaining) unsupported('Trace selection exceeds the 16 MiB actual-read capacity; use a smaller host-bound original record set.');
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), null);
      if (!count) { if (pending.length) collect(pending); break; }
      contentBytes += count; pending = Buffer.concat([pending, chunk.subarray(0, count)]);
      let position = pending.indexOf(10);
      while (position >= 0 && !finished) {
        collect(pending.subarray(0, position + 1)); pending = pending.subarray(position + 1); position = pending.indexOf(10);
      }
      // A final unterminated record can end exactly at the actual-read capacity.
      if (!finished && contentBytes === Number(opened.size) && pending.length) { collect(pending); pending = Buffer.alloc(0); }
      if (!finished && contentBytes === Number(opened.size)) break;
    }
    signal?.throwIfAborted();
    if (!sameFile(opened, fstatSync(fd, { bigint: true }))
      || realpathSync(approvedPath) !== path || !sameFile(opened, lstatSync(approvedPath, { bigint: true }))) changed();
    return { records, ranges, contentBytes };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function suppliedRecords(records: readonly RawRecord[], signal?: AbortSignal): { records: RawRecord[]; ranges: null; contentBytes: number } {
  if (!Array.isArray(records) || !records.length || records.length > MAX_RECORDS) unsupported('Host-bound original trace records are required within capacity.');
  let contentBytes = 0, previous = -1;
  const copied: RawRecord[] = [];
  for (const record of records) {
    signal?.throwIfAborted();
    if (!record || !Number.isSafeInteger(record.recordIndex) || record.recordIndex < 0 || record.recordIndex <= previous
      || !exactString(record.raw) || !record.raw.trim()) unsupported('Host-bound trace records must retain unique ordered original indexes and exact UTF-8 text.');
    contentBytes += Buffer.byteLength(record.raw, 'utf8');
    if (contentBytes > TRACE_SOURCE_MAX_READ_BYTES) unsupported('Host-bound trace records exceed the 16 MiB read capacity.');
    previous = record.recordIndex; copied.push({ recordIndex: record.recordIndex, raw: record.raw });
  }
  return { records: copied, ranges: null, contentBytes };
}
function eventText(event: TraceEvent): string | undefined {
  if ('text' in event && typeof event.text === 'string') return event.text;
  if (event.eventKind === 'tool_result') return event.output;
  if (event.eventKind === 'tool_call') return JSON.stringify(event.input);
  return undefined;
}
const unknownMaterial: SourceMaterialAttribution = { materialType: 'unknown', attributionBasis: 'unknown',
  reason: 'A trace can contain discussion and reported execution; its format alone does not establish the material type of every record.' };
function eventMaterial(event: TraceEvent, declared?: SourceMaterialAttribution): SourceMaterialAttribution {
  if (declared) return declared;
  if (event.eventKind === 'message') return { materialType: 'discussion', attributionBasis: 'source_structure',
    reason: 'The source protocol declares this event to be a conversation message; its claims are not independently verified.' };
  if (event.eventKind === 'tool_result') return { materialType: 'execution_record', attributionBasis: 'source_structure',
    reason: 'The source protocol records a tool result; this is a source-reported observation, not independent verification of its claims.' };
  return unknownMaterial;
}

/** Read exact original records and derive trace events without summary, transcript or filesystem fallback. */
export function readTraceSource(input: TraceSelection, context: TraceSourceReadContext): TraceSourceReading {
  context.signal?.throwIfAborted();
  try {
    const selection = SourceSelectionSchema.parse(input);
    if (selection.sourceKind !== 'agent_trace' || context.sourceId !== selection.sourceId || context.traceKind !== selection.traceKind) {
      unsupported('Selected trace does not match the trusted host source binding.');
    }
    const declared = context.material === undefined ? undefined : SourceMaterialAttributionSchema.parse(context.material);
    const requestedRanges = normalizeRecordRanges(selection.recordRanges, Math.max(...selection.recordRanges.map(range => range.endRecord)));
    const source = context.source.sourceType === 'file' ? fileRecords(context.source.approvedPath, requestedRanges, context.signal)
      : suppliedRecords(context.source.records, context.signal);
    if (!source.records.length) unsupported('Selected trace has no original records.');
    const ranges = normalizeRecordRanges(selection.recordRanges, source.records.at(-1)!.recordIndex);
    const selected = source.records.filter(record => ranges.some(range => record.recordIndex >= range.startRecord && record.recordIndex <= range.endRecord));
    if (ranges.reduce((count, range) => count + range.endRecord - range.startRecord + 1, 0) !== selected.length) {
      unsupported('Selected trace range contains unavailable original records.');
    }
    let malformed = 0, ignoredValues = 0;
    const parsed = selected.map(record => {
      try {
        const value: unknown = JSON.parse(record.raw.trim());
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as CcRecord;
        ignoredValues++; return undefined;
      }
      catch { malformed++; return undefined; }
    });
    // A stable virtual filename is used only for parser bookkeeping. Host paths never influence projection identity.
    const detected = detectJsonlTraceSource('source.jsonl', parsed);
    if (!detected || detected.sourceKind !== selection.traceKind) unsupported('Selected records do not uniquely identify the declared supported agent log format.');
    const material = declared ?? unknownMaterial;
    const rawUnits = selected.map((record, unitId) => ({ unitId, text: record.raw, rawByteDigest: hash(record.raw),
      rawByteLength: Buffer.byteLength(record.raw, 'utf8'), coordinate: { coordinateKind: 'trace_record' as const, recordIndex: record.recordIndex } }));
    const ordinals = new Map<number, number>();
    const excerpts = detected.session.events.flatMap(event => {
      const unit = rawUnits[event.sourceIndex];
      if (!unit) unsupported('Trace parser returned an event outside its original source records.');
      const eventOrdinal = ordinals.get(unit.unitId) ?? 0; ordinals.set(unit.unitId, eventOrdinal + 1);
      const text = eventText(event);
      if (text === undefined) return [];
      return [{ unitId: unit.unitId, text, material: eventMaterial(event, declared),
        coordinate: { coordinateKind: 'trace_event' as const, recordIndex: unit.coordinate.recordIndex, eventOrdinal,
          eventKind: event.eventKind, ...('role' in event ? { role: event.role } : {}),
          ...(event.timestamp ? { timestamp: event.timestamp } : {}) } }];
    });
    const limitations = ['Only explicitly selected original trace records are retained; unselected context is omitted. Message times are source provenance, not verified fact occurrence times.'];
    if (context.source.sourceType === 'records') limitations.push('Host-supplied raw record text is preserved exactly; original file byte offsets and missing line terminators are unavailable and are not reconstructed.');
    if (malformed) limitations.push(`${malformed} malformed original records are retained as raw evidence without invented events.`);
    if (ignoredValues) limitations.push(`${ignoredValues} non-object JSON original records are retained as raw evidence without invented events.`);
    if (detected.session.events.some(event => event.eventKind === 'context_compaction')) limitations.push('Selected source contains a compaction boundary; omitted context is not recovered from its summary.');
    if (detected.session.events.some(event => event.eventKind === 'unknown')) limitations.push('Some original source events could not be interpreted; their raw records remain available.');
    const times = new Map(excerpts.flatMap(excerpt => excerpt.coordinate.timestamp ? [[JSON.stringify([
      excerpt.coordinate.eventKind === 'message' ? 'message' : 'source_declared', excerpt.coordinate.timestamp]), {
      timeKind: excerpt.coordinate.eventKind === 'message' ? 'message' as const : 'source_declared' as const,
      at: excerpt.coordinate.timestamp, basis: 'source_declared' as const }]] : []));
    // Coordinates use the shared parser's normalized timestamps; original timestamp bytes remain in rawUnits.
    const provenance: SourceProvenance = { attributions: [{ role: 'producer', name: detected.sourceKind, basis: 'host_observed' }], times: [] };
    for (const time of times.values()) {
      const parsed = SourceProvenanceSchema.shape.times.element.safeParse(time);
      if (parsed.success && provenance.times.length < 256) provenance.times.push(parsed.data);
    }
    if (times.size > provenance.times.length) limitations.push('The provenance time index is bounded to 256 valid ISO timestamps; event coordinates retain all source-projected timestamps.');
    const suppliedOrigin = context.origin === undefined ? undefined : TraceOriginSchema.parse(context.origin);
    const origin = suppliedOrigin ? { threadId: suppliedOrigin.threadId, ...(suppliedOrigin.turnId === undefined ? {} : { turnId: suppliedOrigin.turnId }), title: suppliedOrigin.title } : undefined;
    const projection = SourceProjectionSchema.parse({ sourceKind: 'agent_trace', projectionVersion: SOURCE_PROJECTION_VERSION,
      identity: { sourceId: selection.sourceId, traceKind: selection.traceKind }, selection: { recordRanges: ranges },
      contentVersion: hash(canonicalJson(selected)), material, provenance, rawUnits, excerpts, limitations,
      ...(origin ? { origin } : {}) });
    if (projection.sourceKind !== 'agent_trace') unsupported('Invalid trace projection.');
    const resolvedSelection = ResolvedSourceSelectionSchema.parse({ ...selection, recordRanges: ranges });
    if (resolvedSelection.sourceKind !== 'agent_trace') unsupported('Invalid resolved trace selection.');
    context.signal?.throwIfAborted();
    return { projection, resolvedSelection, sourceVersion: hash(canonicalJson(sourceVersionPreimage(projection))),
      readManifest: { contentBytes: source.contentBytes, metadataBytes: 0, totalBytes: source.contentBytes,
        selectedTextBytes: rawUnits.reduce((sum, unit) => sum + unit.rawByteLength, 0),
        selectedRawRanges: source.ranges } };
  } catch (error) {
    if (error instanceof TraceSourceReadError || context.signal?.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TraceSourceReadError('missing', 'The host-bound trace source is missing.');
    if (code === 'EACCES' || code === 'EPERM') throw new TraceSourceReadError('permission_denied', 'Trace source permission was denied.');
    return unsupported('Invalid or unsupported original trace source selection.');
  }
}
