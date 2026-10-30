import { z } from 'zod';

export const SOURCE_PROJECTION_VERSION = 'knowledge-window-v3' as const;
export const SOURCE_VERSION_IDENTITY = 'knowledge-source-version/v1' as const;
export const SOURCE_SET_IDENTITY = 'knowledge-source-set/v1' as const;
const id = z.string().min(1).max(256).refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value));
const text = z.string().min(1).max(32_768).refine(value => value.trim().length > 0);
const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const SourceDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const SourceRefSchema = z.strictObject({ snapshotId: z.string().uuid(), sourceVersion: SourceDigestSchema });
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Identical to the historical trace-origin shape; source contracts do not import trace runtimes. */
export const TraceOriginSchema = z.strictObject({ threadId: z.string().min(1), turnId: z.string().min(1).optional(),
  title: z.string(), cwd: z.string().optional() });
export type TraceOrigin = z.infer<typeof TraceOriginSchema>;
export const SourceNamespaceSchema = id.refine(scalarText, 'Source namespaces must preserve valid Unicode scalar values.')
  .refine(value => !/^(?:[\/\\]|[A-Za-z]:|~[\/\\]|file:\/\/)/u.test(value.trim()),
  'Use a logical source namespace instead of an absolute host path.');
export const SourceRelativePathSchema = z.string().min(1).max(4096).refine(value =>
  !/^[A-Za-z]:/u.test(value) && !/[\\\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'), 'Expected a canonical relative slash path.')
  .refine(scalarText, 'Source paths must preserve valid Unicode scalar values.');
export const SourceRecordRangeSchema = z.strictObject({ startRecord: index, endRecord: index })
  .refine(range => range.startRecord <= range.endRecord, 'Record range is reversed.');
export const SourceLineRangeSchema = z.strictObject({ startLine: index.min(1), endLine: index.min(1) })
  .refine(range => range.startLine <= range.endLine, 'Line range is reversed.');
export type SourceRecordRange = z.infer<typeof SourceRecordRangeSchema>;
export type SourceLineRange = z.infer<typeof SourceLineRangeSchema>;
const records = z.array(SourceRecordRangeSchema).min(1).max(256);
const lines = z.array(SourceLineRangeSchema).min(1).max(256);

function normalizeRanges(ranges: readonly { start: number; end: number }[], lower: number, upper: number) {
  if (!Number.isSafeInteger(upper) || upper < lower || !ranges.length || ranges.length > 256) throw new Error('Invalid source range bounds.');
  const sorted = ranges.map(range => ({ ...range })).sort((a, b) => a.start - b.start || a.end - b.end);
  const result: { start: number; end: number }[] = [];
  for (const range of sorted) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
      || range.start < lower || range.end < range.start || range.end > upper) throw new Error('Source range is invalid or out of bounds.');
    const previous = result.at(-1);
    if (previous && (range.start <= previous.end || range.start - previous.end === 1)) previous.end = Math.max(previous.end, range.end);
    else result.push(range);
  }
  return result;
}
export function normalizeRecordRanges(ranges: readonly SourceRecordRange[], maxRecordIndex: number): SourceRecordRange[] {
  return normalizeRanges(ranges.map(range => ({ start: range.startRecord, end: range.endRecord })), 0, maxRecordIndex)
    .map(range => ({ startRecord: range.start, endRecord: range.end }));
}
export function normalizeLineRanges(ranges: readonly SourceLineRange[], totalLines: number): SourceLineRange[] {
  return normalizeRanges(ranges.map(range => ({ start: range.startLine, end: range.endLine })), 1, totalLines)
    .map(range => ({ startLine: range.start, endLine: range.end }));
}
/** null explicitly selects the entire file; an empty file contains no invented line or excerpt. */
export function resolveSourceLineRanges(ranges: readonly SourceLineRange[] | null, totalLines: number): SourceLineRange[] {
  if (!Number.isSafeInteger(totalLines) || totalLines < 0) throw new Error('Invalid source line count.');
  return ranges === null ? totalLines ? [{ startLine: 1, endLine: totalLines }] : [] : normalizeLineRanges(ranges, totalLines);
}
function canonicalRanges(value: unknown, normalize: () => unknown): boolean {
  try { return JSON.stringify(value) === JSON.stringify(normalize()); } catch { return false; }
}
const canonicalRecords = records.refine(value => canonicalRanges(value, () => normalizeRecordRanges(value,
  Math.max(...value.map(range => range.endRecord)))), 'Resolved record ranges must be canonical.');
const canonicalLines = lines.refine(value => canonicalRanges(value, () => normalizeLineRanges(value,
  Math.max(...value.map(range => range.endLine)))), 'Resolved line ranges must be canonical.');
const resolvedLines = z.union([z.tuple([]), canonicalLines]);

const fileIdentity = { projectId: SourceNamespaceSchema, relativePath: SourceRelativePathSchema };
const gitIdentity = { ...fileIdentity, objectHashAlgorithm: z.enum(['sha1', 'sha256']),
  commitOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  treeOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  blobOid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u) };
type GitIdentity = { objectHashAlgorithm: 'sha1' | 'sha256'; commitOid: string; treeOid: string; blobOid: string };
const validGitOids = (value: GitIdentity) => [value.commitOid, value.treeOid, value.blobOid]
  .every(oid => oid.length === (value.objectHashAlgorithm === 'sha1' ? 40 : 64));
const traceIdentity = { sourceId: SourceNamespaceSchema, traceKind: id };
export const SourceIdentitySchema = z.discriminatedUnion('sourceKind', [
  z.strictObject({ sourceKind: z.literal('agent_trace'), ...traceIdentity }),
  z.strictObject({ sourceKind: z.literal('project_file'), ...fileIdentity }),
  z.strictObject({ sourceKind: z.literal('git_blob'), ...gitIdentity }).refine(validGitOids, 'Git OIDs must match their hash algorithm.'),
]);
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;
const traceSelection = z.strictObject({ sourceKind: z.literal('agent_trace'), ...traceIdentity, recordRanges: records });
const fileSelection = z.strictObject({ sourceKind: z.literal('project_file'), ...fileIdentity, lineRanges: lines.nullable() });
const gitSelection = z.strictObject({ sourceKind: z.literal('git_blob'), ...fileIdentity,
  revision: id.refine(scalarText, 'Git revisions must preserve valid Unicode scalar values.'), lineRanges: lines.nullable() });
export const SourceSelectionSchema = z.discriminatedUnion('sourceKind', [traceSelection, fileSelection, gitSelection]);
export type SourceSelection = z.infer<typeof SourceSelectionSchema>;
export const ResolvedSourceSelectionSchema = z.discriminatedUnion('sourceKind', [
  traceSelection.extend({ recordRanges: canonicalRecords }),
  fileSelection.extend({ lineRanges: resolvedLines }),
  z.strictObject({ sourceKind: z.literal('git_blob'), ...gitIdentity, lineRanges: resolvedLines })
    .refine(validGitOids, 'Git OIDs must match their hash algorithm.'),
]);
export type ResolvedSourceSelection = z.infer<typeof ResolvedSourceSelectionSchema>;

export const SourceMaterialAttributionSchema = z.strictObject({
  materialType: z.enum(['design', 'implementation', 'configuration', 'test_expectation', 'execution_record', 'discussion', 'unknown']),
  attributionBasis: z.enum(['host_declared', 'source_declared', 'source_structure', 'unknown']), reason: text,
}).refine(value => value.attributionBasis !== 'unknown' || value.materialType === 'unknown', 'Unknown attribution cannot establish a material type.');
export type SourceMaterialAttribution = z.infer<typeof SourceMaterialAttributionSchema>;
/** Source-declared times are provenance, never capture time or filesystem mtime and never fact-time verdicts. */
export const SourceProvenanceSchema = z.strictObject({
  attributions: z.array(z.strictObject({ role: z.enum(['author', 'producer']), name: text,
    basis: z.enum(['source_declared', 'host_observed']) })).max(256),
  times: z.array(z.strictObject({ timeKind: z.enum(['source_declared', 'git_author', 'git_committer', 'message']),
    at: timestamp, basis: z.enum(['source_declared', 'host_observed']) })).max(256),
});
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;
const byteRange = { startLine: index.min(1), endLine: index.min(1), startByte: index, endByte: index };
const validCoordinateRange = (value: { startLine: number; endLine: number; startByte: number; endByte: number }) =>
  value.startLine <= value.endLine && value.startByte <= value.endByte;
const fileCoordinate = z.strictObject({ coordinateKind: z.literal('file_range'), relativePath: SourceRelativePathSchema, ...byteRange })
  .refine(validCoordinateRange, 'Invalid source coordinate range.');
const gitCoordinate = z.strictObject({ coordinateKind: z.literal('git_blob_range'), relativePath: SourceRelativePathSchema,
  objectHashAlgorithm: gitIdentity.objectHashAlgorithm, commitOid: gitIdentity.commitOid, treeOid: gitIdentity.treeOid,
  blobOid: gitIdentity.blobOid, ...byteRange }).refine(value => validCoordinateRange(value) && validGitOids(value), 'Invalid Git coordinate.');
const recordCoordinate = z.strictObject({ coordinateKind: z.literal('trace_record'), recordIndex: index });
const eventCoordinate = z.strictObject({ coordinateKind: z.literal('trace_event'), recordIndex: index,
  eventOrdinal: index, eventKind: id, role: z.string().optional(), timestamp: z.string().optional() });
export const SourceUnitCoordinateSchema = z.discriminatedUnion('coordinateKind', [recordCoordinate, fileCoordinate, gitCoordinate]);
export const SourceExcerptCoordinateSchema = z.discriminatedUnion('coordinateKind', [eventCoordinate, fileCoordinate, gitCoordinate]);
export type SourceUnitCoordinate = z.infer<typeof SourceUnitCoordinateSchema>;
export type SourceExcerptCoordinate = z.infer<typeof SourceExcerptCoordinateSchema>;

function scalarText(value: string): boolean {
  for (let position = 0; position < value.length; position++) {
    const unit = value.charCodeAt(position);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++position);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
const sourceText = z.string().max(16 * 1024 * 1024).refine(scalarText, 'Source text must preserve valid Unicode scalar values.');
export const SourceRawUnitSchema = z.strictObject({ unitId: index, text: sourceText,
  rawByteDigest: SourceDigestSchema, rawByteLength: index.max(16 * 1024 * 1024), coordinate: SourceUnitCoordinateSchema });
export type SourceRawUnit = z.infer<typeof SourceRawUnitSchema>;
export const SourceProjectedExcerptSchema = z.strictObject({ unitId: index, text: sourceText,
  coordinate: SourceExcerptCoordinateSchema, material: SourceMaterialAttributionSchema });
export type SourceProjectedExcerpt = z.infer<typeof SourceProjectedExcerptSchema>;
export const SourceExcerptSchema = SourceProjectedExcerptSchema.extend({ evidenceRef: id });
export type SourceExcerpt = z.infer<typeof SourceExcerptSchema>;

const projection = { projectionVersion: z.literal(SOURCE_PROJECTION_VERSION), contentVersion: SourceDigestSchema,
  material: SourceMaterialAttributionSchema, provenance: SourceProvenanceSchema,
  rawUnits: z.array(SourceRawUnitSchema).max(100_000),
  excerpts: z.array(SourceProjectedExcerptSchema).max(100_000), limitations: z.array(text).max(1024) };
const traceProjection = z.strictObject({ ...projection, sourceKind: z.literal('agent_trace'),
  identity: z.strictObject(traceIdentity), rawUnits: projection.rawUnits.min(1),
  selection: z.strictObject({ recordRanges: canonicalRecords }), origin: TraceOriginSchema.optional() });
const fileProjection = z.strictObject({ ...projection, sourceKind: z.literal('project_file'),
  identity: z.strictObject(fileIdentity), selection: z.strictObject({ lineRanges: resolvedLines }) });
const gitProjection = z.strictObject({ ...projection, sourceKind: z.literal('git_blob'),
  identity: z.strictObject(gitIdentity).refine(validGitOids, 'Git OIDs must match their hash algorithm.'),
  selection: z.strictObject({ lineRanges: resolvedLines }) });
const projectionUnion = z.discriminatedUnion('sourceKind', [traceProjection, fileProjection, gitProjection]);
type Projection = z.infer<typeof projectionUnion>;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function checkProjection(value: Projection, context: z.RefinementCtx): void {
  const issue = (path: PropertyKey[], message: string) => context.addIssue({ code: 'custom', path, message });
  const recordIndexes = new Set<number>();
  for (const [ordinal, unit] of value.rawUnits.entries()) {
    if (unit.unitId !== ordinal) issue(['rawUnits', ordinal, 'unitId'], 'Unit IDs must be deterministic source-local ordinals.');
    if (new TextEncoder().encode(unit.text).length !== unit.rawByteLength) issue(['rawUnits', ordinal, 'rawByteLength'], 'Raw byte length does not match exact UTF-8 text.');
    const coordinate = unit.coordinate;
    if (value.sourceKind === 'agent_trace') {
      if (coordinate.coordinateKind !== 'trace_record') issue(['rawUnits', ordinal, 'coordinate'], 'Trace sources require record coordinates.');
      else {
        const previous = value.rawUnits[ordinal - 1]?.coordinate;
        if (recordIndexes.has(coordinate.recordIndex) || previous?.coordinateKind === 'trace_record' && previous.recordIndex >= coordinate.recordIndex
          || !value.selection.recordRanges.some(range => coordinate.recordIndex >= range.startRecord && coordinate.recordIndex <= range.endRecord)) {
          issue(['rawUnits', ordinal, 'coordinate'], 'Trace record is duplicated or outside the selected ranges.');
        }
        recordIndexes.add(coordinate.recordIndex);
      }
    } else {
      if (unit.rawByteLength === 0) issue(['rawUnits', ordinal, 'rawByteLength'], 'Selected file ranges must retain at least one byte.');
      const expectedKind = value.sourceKind === 'project_file' ? 'file_range' : 'git_blob_range';
      if (coordinate.coordinateKind !== expectedKind) issue(['rawUnits', ordinal, 'coordinate'], 'Source coordinate kind mismatch.');
      else {
        if (coordinate.relativePath !== value.identity.relativePath || coordinate.endByte - coordinate.startByte !== unit.rawByteLength
          || !same(value.selection.lineRanges[ordinal], { startLine: coordinate.startLine, endLine: coordinate.endLine })) {
          issue(['rawUnits', ordinal, 'coordinate'], 'File unit does not match its exact selected range.');
        }
        if (value.sourceKind === 'git_blob' && coordinate.coordinateKind === 'git_blob_range'
          && !(['objectHashAlgorithm', 'commitOid', 'treeOid', 'blobOid'] as const).every(key => coordinate[key] === value.identity[key])) {
          issue(['rawUnits', ordinal, 'coordinate'], 'Git coordinate does not match the fixed source identity.');
        }
      }
    }
  }
  if (value.sourceKind === 'agent_trace' && value.selection.recordRanges.reduce((count, range) => count + range.endRecord - range.startRecord + 1, 0) !== value.rawUnits.length) {
    issue(['rawUnits'], 'Selected trace ranges must match the retained original record indexes exactly.');
  }
  if (value.sourceKind !== 'agent_trace' && value.rawUnits.length !== value.selection.lineRanges.length) issue(['rawUnits'], 'Each selected file range requires one exact raw unit.');
  if (value.sourceKind !== 'agent_trace' && value.rawUnits.length !== value.excerpts.length) issue(['excerpts'], 'Each selected file unit requires one complete excerpt.');
  if (value.sourceKind !== 'agent_trace' && value.contentVersion === 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    && (value.selection.lineRanges.length || value.rawUnits.length || value.excerpts.length)) {
    issue(['selection'], 'An empty file source must have no selected ranges, raw units or excerpts.');
  }
  if (!value.rawUnits.length && (value.excerpts.length || value.contentVersion !== 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')) {
    issue(['rawUnits'], 'Only an empty source may have no selected units.');
  }
  const events = new Set<string>();
  for (const [ordinal, excerpt] of value.excerpts.entries()) {
    const unit = value.rawUnits[excerpt.unitId], coordinate = excerpt.coordinate;
    if (!unit) { issue(['excerpts', ordinal, 'unitId'], 'Excerpt references an unknown raw unit.'); continue; }
    if (value.sourceKind === 'agent_trace') {
      if (coordinate.coordinateKind !== 'trace_event' || unit.coordinate.coordinateKind !== 'trace_record'
        || coordinate.recordIndex !== unit.coordinate.recordIndex) issue(['excerpts', ordinal, 'coordinate'], 'Trace excerpt does not bind its original record.');
      else {
        const key = JSON.stringify([coordinate.recordIndex, coordinate.eventOrdinal]);
        if (events.has(key)) issue(['excerpts', ordinal, 'coordinate'], 'Duplicate trace event coordinate.');
        const previous = value.excerpts[ordinal - 1];
        if (previous && (previous.unitId > excerpt.unitId || previous.unitId === excerpt.unitId
          && previous.coordinate.coordinateKind === 'trace_event' && previous.coordinate.eventOrdinal >= coordinate.eventOrdinal)) {
          issue(['excerpts', ordinal, 'coordinate'], 'Trace excerpts must retain original event order.');
        }
        events.add(key);
      }
    } else if (excerpt.unitId !== ordinal || !same(coordinate, unit.coordinate) || excerpt.text !== unit.text) issue(['excerpts', ordinal], 'File excerpts must retain exact contiguous selected units in source order.');
  }
}
export const SourceProjectionSchema = projectionUnion.superRefine(checkProjection);
export type SourceProjection = z.infer<typeof SourceProjectionSchema>;
const snapshot = { snapshotId: z.string().uuid(), sourceVersion: SourceDigestSchema, capturedAt: timestamp,
  excerpts: z.array(SourceExcerptSchema).max(100_000) };
export const SourceSnapshotSchema = z.discriminatedUnion('sourceKind', [
  traceProjection.extend(snapshot), fileProjection.extend(snapshot), gitProjection.extend(snapshot),
]).superRefine((value, context) => {
  checkProjection(value, context);
  value.excerpts.forEach((excerpt, ordinal) => {
    if (excerpt.evidenceRef !== `${value.snapshotId}:${ordinal}`) context.addIssue({ code: 'custom',
      path: ['excerpts', ordinal, 'evidenceRef'], message: 'Evidence references must bind the snapshot and excerpt ordinal.' });
  });
});
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

export function sourceSnapshotProjection(input: SourceSnapshot): SourceProjection {
  const { snapshotId: _snapshotId, sourceVersion: _sourceVersion, capturedAt: _capturedAt, excerpts, ...projectionValue } = SourceSnapshotSchema.parse(input);
  void _snapshotId; void _sourceVersion; void _capturedAt;
  return SourceProjectionSchema.parse({ ...projectionValue, excerpts: excerpts.map(({ evidenceRef: _evidenceRef, ...excerpt }) => excerpt) });
}

/** Returns plain JSON for adapter-owned canonical serialization and hashing; never reads clocks, files or Node APIs. */
export function sourceVersionPreimage(input: SourceProjection) {
  const value = SourceProjectionSchema.parse(input);
  const origin = value.sourceKind === 'agent_trace' ? value.origin : undefined;
  return { identityVersion: SOURCE_VERSION_IDENTITY, projectionVersion: value.projectionVersion,
    sourceKind: value.sourceKind, identity: value.identity, selection: value.selection, contentVersion: value.contentVersion,
    ...(origin ? { origin: { threadId: origin.threadId, ...(origin.turnId === undefined ? {} : { turnId: origin.turnId }), title: origin.title } } : {}),
    material: value.material, provenance: value.provenance,
    selectedUnits: value.rawUnits.map(unit => ({ coordinate: unit.coordinate, rawByteDigest: unit.rawByteDigest, rawByteLength: unit.rawByteLength })),
    excerpts: value.excerpts.map(excerpt => ({ coordinate: excerpt.coordinate, text: excerpt.text, material: excerpt.material })),
    limitations: value.limitations };
}
export function sourceSetPreimage(input: readonly SourceRef[]) {
  const sources = z.array(SourceRefSchema).min(1).max(256).parse([...input]);
  const sorted = sources.sort((a, b) => a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1
    : a.sourceVersion < b.sourceVersion ? -1 : a.sourceVersion > b.sourceVersion ? 1 : 0);
  if (sorted.some((source, position) => position > 0 && source.snapshotId === sorted[position - 1].snapshotId
    && source.sourceVersion !== sorted[position - 1].sourceVersion)) throw new Error('One immutable snapshot cannot have multiple source versions.');
  return { sourceSetVersion: SOURCE_SET_IDENTITY,
    sources: sorted.filter((source, position) => position === 0 || !same(source, sorted[position - 1])) };
}
export const SourceDeletionMarkerSchema = z.strictObject({ snapshotId: z.string().uuid(), sourceVersion: SourceDigestSchema,
  projectionVersion: z.literal(SOURCE_PROJECTION_VERSION), deleted: z.literal(true) });
export type SourceDeletionMarker = z.infer<typeof SourceDeletionMarkerSchema>;
export const SourceResolutionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('available'), snapshot: SourceSnapshotSchema }),
  z.strictObject({ status: z.literal('unavailable'), reason: z.enum(['missing', 'deleted', 'corrupt', 'version_mismatch', 'permission_denied', 'unsupported']), detail: text }),
]);
export type SourceResolution = z.infer<typeof SourceResolutionSchema>;
export const SourceCurrentStateSchema = z.strictObject({ sourceRef: SourceRefSchema, checkedAt: timestamp,
  state: z.enum(['unchanged', 'content_changed', 'provenance_only_changed', 'deleted', 'unavailable', 'possible_move', 'unknown']),
  observedIdentity: SourceIdentitySchema.optional(), observedContentVersion: SourceDigestSchema.optional(),
  selectedBytesChanged: z.boolean().optional(), limitations: z.array(text).max(1024) });
export type SourceCurrentState = z.infer<typeof SourceCurrentStateSchema>;
