import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExperienceSessionSummary, ExperienceTraceRecordRange } from './contracts/experience.js';
import type {
  ObservationInboxReport,
  ObservationSourceRecord,
  ObservationSourceRecordArchive,
  ObservationSourceRecordArchiveRef,
  ObservationSourceRecordArchiveView,
} from './contracts/inbox.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { normalizeTraceTimestamp } from './trace-ir.js';
import { forEachNonEmptyUtf8Line } from './trace-source.js';

const ARCHIVE_SCHEMA_VERSION = 1;
const MAX_ARCHIVE_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_CHARS = 512 * 1024;

interface MergedRecordRange {
  start: number;
  end: number;
  traceId: string;
}

interface SessionArchiveBuilder {
  session: ExperienceSessionSummary;
  groupedRanges: Map<string, MergedRecordRange[]>;
  records: ObservationSourceRecord[];
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
  failure?: ObservationSourceRecordArchiveRef['reason'];
}

interface SourceArchiveTarget {
  builder: SessionArchiveBuilder;
  ranges: MergedRecordRange[];
  expectedCount: number;
  matchedCount: number;
  rangeIndex: number;
}

/**
 * Persist bounded source records beside a report. Absolute source paths are
 * consumed only during trusted ingest; Studio later reads relative sidecars.
 */
export function writeObservationSourceRecordArchives(
  report: ObservationInboxReport,
  outDir: string,
  reportPath: string,
): ObservationSourceRecordArchiveRef[] {
  const sessions = report.experience?.sessions ?? [];
  if (sessions.length === 0) return [];
  const reportStem = basename(reportPath).replace(/\.report\.json$/u, '');
  const archiveDir = join(outDir, 'source-records', reportStem);
  const builders = sessions.map((session): SessionArchiveBuilder => ({
    session,
    groupedRanges: groupRecordRanges(session.timelineScope.sessionRecordRanges),
    records: [],
    omittedRecordCount: 0,
    byteCount: 0,
    truncated: false,
  }));
  const targetsBySource = new Map<string, SourceArchiveTarget[]>();
  for (const builder of builders) {
    for (const [sourceTrace, ranges] of builder.groupedRanges) {
      const targets = targetsBySource.get(sourceTrace) ?? [];
      targets.push({
        builder,
        ranges,
        expectedCount: ranges.reduce((sum, range) => sum + range.end - range.start + 1, 0),
        matchedCount: 0,
        rangeIndex: 0,
      });
      targetsBySource.set(sourceTrace, targets);
    }
  }
  for (const [sourceTrace, targets] of targetsBySource) {
    collectSourceRecords(sourceTrace, targets);
  }
  return builders.map((builder) => persistSessionArchive(
    builder,
    archiveDir,
    outDir,
    report.meta.generatedAt,
  ));
}

export function loadObservationSourceRecordArchive(
  ref: ObservationSourceRecordArchiveRef | undefined,
  observationsDir: string,
): ObservationSourceRecordArchiveView {
  if (!ref || ref.status === 'unavailable' || !ref.relativePath) {
    return unavailableView(ref?.reason ?? 'no_record_ranges');
  }
  const path = safeArchivePath(observationsDir, ref.relativePath);
  if (!path || !existsSync(path)) return unavailableView('archive_invalid');

  try {
    if (statSync(path).size > MAX_ARCHIVE_FILE_BYTES) return unavailableView('archive_invalid');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObservationSourceRecordArchive(parsed, ref.experienceSessionId)) {
      return unavailableView('archive_invalid');
    }
    return {
      status: ref.status,
      recordCount: parsed.records.length,
      records: parsed.records,
      omittedRecordCount: parsed.omittedRecordCount,
      byteCount: parsed.byteCount,
      truncated: parsed.truncated,
      ...(ref.reason ? { reason: ref.reason } : {}),
    };
  } catch {
    return unavailableView('archive_invalid');
  }
}

/**
 * Build the page-safe archive metadata without reading the potentially large
 * sidecar. The source-record endpoint resolves the same ref on demand.
 */
export function summarizeObservationSourceRecordArchive(
  ref: ObservationSourceRecordArchiveRef | undefined,
): ObservationSourceRecordArchiveView {
  if (!ref) return unavailableView('no_record_ranges');
  return {
    status: ref.status,
    recordCount: ref.recordCount,
    records: [],
    omittedRecordCount: ref.omittedRecordCount,
    byteCount: ref.byteCount,
    truncated: ref.truncated,
    ...(ref.reason ? { reason: ref.reason } : {}),
  };
}

function collectSourceRecords(
  sourceTrace: string,
  targets: SourceArchiveTarget[],
): void {
  if (extname(sourceTrace).toLowerCase() !== '.jsonl') {
    markSourceUnavailable(targets, 'unsupported_source');
    return;
  }
  if (!existsSync(sourceTrace)) {
    markSourceUnavailable(targets, 'source_missing');
    return;
  }

  const maxEnd = targets.reduce(
    (targetMax, target) => target.ranges.reduce(
      (rangeMax, range) => Math.max(rangeMax, range.end),
      targetMax,
    ),
    -1,
  );
  let sourceIndex = 0;
  try {
    forEachNonEmptyUtf8Line(sourceTrace, (line) => {
      const currentIndex = sourceIndex;
      sourceIndex += 1;
      const recordsByTraceId = new Map<string, ObservationSourceRecord>();
      for (const target of targets) {
        while (target.ranges[target.rangeIndex]
          && target.ranges[target.rangeIndex]!.end < currentIndex) {
          target.rangeIndex += 1;
        }
        const range = target.ranges[target.rangeIndex];
        if (!range || currentIndex < range.start || currentIndex > range.end) continue;
        target.matchedCount += 1;
        if (target.builder.byteCount >= MAX_ARCHIVE_SOURCE_BYTES) {
          target.builder.omittedRecordCount += 1;
          target.builder.truncated = true;
          target.builder.failure = 'archive_limit';
          continue;
        }
        let record = recordsByTraceId.get(range.traceId);
        if (!record) {
          record = observationSourceRecordFromLine(line, currentIndex, range.traceId, sourceTrace);
          recordsByTraceId.set(range.traceId, record);
        }
        if (target.builder.byteCount + record.byteCount > MAX_ARCHIVE_SOURCE_BYTES) {
          target.builder.omittedRecordCount += 1;
          target.builder.truncated = true;
          target.builder.failure = 'archive_limit';
          continue;
        }
        target.builder.records.push(record);
        target.builder.byteCount += record.byteCount;
        target.builder.truncated ||= record.truncated;
      }
      return currentIndex < maxEnd;
    });
  } catch {
    for (const target of targets) target.builder.failure ??= 'read_failed';
  }
  for (const target of targets) {
    target.builder.omittedRecordCount += Math.max(0, target.expectedCount - target.matchedCount);
  }
}

function markSourceUnavailable(
  targets: SourceArchiveTarget[],
  reason: NonNullable<ObservationSourceRecordArchiveRef['reason']>,
): void {
  for (const target of targets) {
    target.builder.omittedRecordCount += target.expectedCount;
    target.builder.failure ??= reason;
  }
}

function persistSessionArchive(
  builder: SessionArchiveBuilder,
  archiveDir: string,
  outDir: string,
  generatedAt: string,
): ObservationSourceRecordArchiveRef {
  const { session, records, omittedRecordCount, byteCount, failure } = builder;
  if (builder.groupedRanges.size === 0) return unavailableRef(session.id, 'no_record_ranges');
  if (records.length === 0) return unavailableRef(session.id, failure ?? 'read_failed', omittedRecordCount);
  const archive: ObservationSourceRecordArchive = {
    archiveKind: 'observe-source-records',
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    experienceSessionId: session.id,
    generatedAt,
    records,
    omittedRecordCount,
    byteCount,
    truncated: builder.truncated || omittedRecordCount > 0,
  };
  const fileName = `${createHash('sha256').update(session.id).digest('hex').slice(0, 24)}.json`;
  const archivePath = join(archiveDir, fileName);
  writeJsonFileAtomic(archivePath, archive);
  const relativePath = relative(outDir, archivePath).split('\\').join('/');
  const partial = archive.truncated || failure !== undefined;
  return {
    experienceSessionId: session.id,
    status: partial ? 'partial' : 'available',
    relativePath,
    recordCount: records.length,
    omittedRecordCount,
    byteCount,
    truncated: archive.truncated,
    ...(failure ? { reason: failure } : {}),
  };
}

export function observationSourceRecordFromLine(
  line: string,
  sourceIndex: number,
  traceId: string,
  sourceTrace: string,
): ObservationSourceRecord {
  let record: Record<string, unknown> = {};
  let serialized = line;
  let redacted = false;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) {
      record = parsed;
      serialized = JSON.stringify(parsed, (key, value: unknown) => {
        if (key !== 'encrypted_content') return value;
        redacted = true;
        return '[opaque encrypted content omitted]';
      });
    }
  } catch {
    // Malformed source lines are still useful provenance.
  }
  const payload = isRecord(record.payload) ? record.payload : {};
  const recordType = textValue(record.type) ?? 'unknown';
  const payloadType = textValue(payload.type);
  const raw = serialized.length > MAX_RECORD_CHARS ? serialized.slice(0, MAX_RECORD_CHARS) : serialized;
  return {
    sourceIndex,
    traceId,
    sourceTrace,
    sourceType: `${recordType}:${payloadType ?? ''}`,
    sourceEventId: textValue(payload.id),
    timestamp: normalizeTraceTimestamp(record.timestamp),
    raw,
    byteCount: Buffer.byteLength(raw),
    truncated: raw.length < serialized.length,
    redacted,
  };
}

function groupRecordRanges(ranges: ExperienceTraceRecordRange[]): Map<string, MergedRecordRange[]> {
  const grouped = new Map<string, MergedRecordRange[]>();
  for (const range of ranges) {
    const current = grouped.get(range.sourceTrace) ?? [];
    current.push({ start: range.startRecordIndex, end: range.endRecordIndex, traceId: range.traceId });
    grouped.set(range.sourceTrace, current);
  }
  for (const [sourceTrace, sourceRanges] of grouped) {
    const sorted = sourceRanges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: MergedRecordRange[] = [];
    for (const range of sorted) {
      const previous = merged.at(-1);
      if (previous && previous.traceId === range.traceId && range.start <= previous.end + 1) {
        previous.end = Math.max(previous.end, range.end);
      } else {
        merged.push({ ...range });
      }
    }
    grouped.set(sourceTrace, merged);
  }
  return grouped;
}

function safeArchivePath(observationsDir: string, relativePath: string): string | undefined {
  if (!relativePath || isAbsolute(relativePath)) return undefined;
  const candidate = resolve(observationsDir, relativePath);
  const lexicalRelative = relative(resolve(observationsDir), candidate);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) return undefined;
  try {
    const root = realpathSync(observationsDir);
    const resolved = realpathSync(candidate);
    const resolvedRelative = relative(root, resolved);
    if (resolvedRelative.startsWith('..') || isAbsolute(resolvedRelative)) return undefined;
    return resolved;
  } catch {
    return undefined;
  }
}

function unavailableRef(
  experienceSessionId: string,
  reason: NonNullable<ObservationSourceRecordArchiveRef['reason']>,
  omittedRecordCount = 0,
): ObservationSourceRecordArchiveRef {
  return {
    experienceSessionId,
    status: 'unavailable',
    recordCount: 0,
    omittedRecordCount,
    byteCount: 0,
    truncated: omittedRecordCount > 0,
    reason,
  };
}

function unavailableView(reason: NonNullable<ObservationSourceRecordArchiveView['reason']>): ObservationSourceRecordArchiveView {
  return {
    status: 'unavailable',
    recordCount: 0,
    records: [],
    omittedRecordCount: 0,
    byteCount: 0,
    truncated: false,
    reason,
  };
}

function isObservationSourceRecordArchive(
  value: unknown,
  experienceSessionId: string,
): value is ObservationSourceRecordArchive {
  if (!isRecord(value)
    || value.archiveKind !== 'observe-source-records'
    || value.schemaVersion !== ARCHIVE_SCHEMA_VERSION
    || value.experienceSessionId !== experienceSessionId
    || typeof value.generatedAt !== 'string'
    || !Array.isArray(value.records)
    || !value.records.every(isObservationSourceRecord)
    || !isCount(value.omittedRecordCount)
    || !isCount(value.byteCount)
    || typeof value.truncated !== 'boolean') return false;
  return value.records.reduce((sum, record) => sum + record.byteCount, 0) === value.byteCount;
}

function isObservationSourceRecord(value: unknown): value is ObservationSourceRecord {
  return isRecord(value)
    && isCount(value.sourceIndex)
    && typeof value.traceId === 'string'
    && typeof value.sourceTrace === 'string'
    && typeof value.sourceType === 'string'
    && (value.sourceEventId === undefined || typeof value.sourceEventId === 'string')
    && (value.timestamp === undefined || typeof value.timestamp === 'string')
    && typeof value.raw === 'string'
    && isCount(value.byteCount)
    && Buffer.byteLength(value.raw) === value.byteCount
    && typeof value.truncated === 'boolean'
    && typeof value.redacted === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
