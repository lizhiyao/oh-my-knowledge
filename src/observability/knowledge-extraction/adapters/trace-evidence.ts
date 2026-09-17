import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createJsonFileAtomic, writeJsonFileAtomic } from '../../../shared/atomic-json.js';
import { withFileLock } from '../../../shared/file-lock.js';
import { detectJsonlTraceSource, forEachNonEmptyUtf8Line, type CcRecord } from '../../trace/source.js';
import type { TraceEvent } from '../../trace/trace-ir.js';
import {
  EVIDENCE_PROJECTION_VERSION,
  EvidenceWindowSchema, type EvidenceStore, type EvidenceWindow,
  type SourceResolution, type SourceSelection,
} from '../evidence.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const hash = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function eventText(event: TraceEvent): string | undefined {
  if ('text' in event && typeof event.text === 'string') return event.text;
  if (event.eventKind === 'tool_result') return event.output;
  if (event.eventKind === 'tool_call') return JSON.stringify(event.input);
  return undefined;
}

/** 归档用户显式选中的记录；格式归因复用 Trace 层的同源判定。 */
export class TraceEvidenceStore implements EvidenceStore {
  private readonly root: string;
  constructor(root: string) {
    if (!root.trim()) throw new Error('Explicit evidence root required.');
    this.root = resolve(root);
  }
  private path(snapshotId: string): string {
    if (!/^[0-9a-f-]{36}$/.test(snapshotId)) throw new Error('Invalid snapshot identity.');
    return join(this.root, `${snapshotId}.json`);
  }
  capture(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow {
    const window = projectTraceEvidence(selection, signal);
    const stored = EvidenceWindowSchema.parse(window);
    const serialized = JSON.stringify(stored, null, 2);
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Projected source exceeds capacity; choose a smaller range.');
    withFileLock(join(this.root, '.write.lock'), () => {
      const total = readdirSync(this.root).filter((name) => name.endsWith('.json'))
        .reduce((sum, name) => sum + lstatSync(join(this.root, name)).size, 0);
      if (total + Buffer.byteLength(serialized) + 256 > MAX_TOTAL_BYTES) throw new Error('Evidence storage capacity exceeded; delete unneeded snapshots.');
      signal?.throwIfAborted();
      createJsonFileAtomic(this.path(stored.snapshotId), { ...stored, windowDigest: hash(serialized) });
    }, { recoverStale: false });
    return stored;
  }
  read(snapshotId: string, expectedVersion?: string): SourceResolution {
    const path = this.path(snapshotId);
    if (!existsSync(path)) return { status: 'unavailable', reason: 'missing', detail: 'Source snapshot is missing.' };
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES + 256) throw new Error('Invalid source file.');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      if (value?.deleted === true && value.snapshotId === snapshotId) return { status: 'unavailable', reason: 'deleted', detail: 'Source snapshot was deleted.' };
      const { windowDigest, ...data } = value;
      const window = EvidenceWindowSchema.parse(data);
      if (window.snapshotId !== snapshotId || hash(JSON.stringify(window, null, 2)) !== windowDigest
        || hash(JSON.stringify(window.records)) !== window.sourceVersion) throw new Error('Source integrity mismatch.');
      if (expectedVersion && window.sourceVersion !== expectedVersion) return { status: 'unavailable', reason: 'version_mismatch', detail: 'Snapshot does not match the bound source version.' };
      return { status: 'available', window };
    } catch {
      return { status: 'unavailable', reason: 'invalid_source', detail: 'Source snapshot is invalid or unreadable.' };
    }
  }
  delete(snapshotId: string): void {
    const path = this.path(snapshotId);
    withFileLock(join(this.root, '.write.lock'), () => {
      if (!existsSync(path)) throw new Error('Source snapshot is missing.');
      writeJsonFileAtomic(path, { snapshotId, deleted: true });
    }, { recoverStale: false });
  }
}

/** 本地预览与不可变归档共用的投影。 */
export function projectTraceEvidence(selection: SourceSelection, signal?: AbortSignal): EvidenceWindow {
  signal?.throwIfAborted();
  const path = selection.records ? selection.path : realpathSync(selection.path);
  if (!selection.records && !lstatSync(path).isFile()) throw new Error('Select one agent session log file.');
  const start = selection.startRecord ?? 0;
  const end = selection.endRecord;
  if (!Number.isSafeInteger(start) || start < 0
    || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) throw new Error('Invalid record range.');
  const records: EvidenceWindow['records'] = [];
  const rawRecords: Array<CcRecord | undefined> = [];
  let recordIndex = 0;
  let bytes = 0;
  let malformed = 0;
  const collect = (raw: string, suppliedIndex?: number) => {
    signal?.throwIfAborted();
    const index = suppliedIndex ?? recordIndex++;
    if (index < start) return;
    if (end !== undefined && index > end) return false;
    bytes += Buffer.byteLength(raw, 'utf8');
    if (bytes > MAX_BYTES || records.length >= 100_000) throw new Error('Selected source exceeds capacity; choose a smaller record range.');
    records.push({ recordIndex: index, raw });
    try { rawRecords.push(JSON.parse(raw) as CcRecord); } catch { rawRecords.push(undefined); malformed++; }
    return end === undefined || index < end;
  };
  if (selection.records) { for (const record of selection.records) collect(record.raw, record.recordIndex); }
  else forEachNonEmptyUtf8Line(path, collect);
  if (!records.length) throw new Error('Selected record range is empty.');
  const detected = detectJsonlTraceSource(path, rawRecords);
  if (!detected) throw new Error('Selected records do not identify a single supported agent log format.');
  const snapshotId = randomUUID();
  const { session } = detected;
  const limitations: string[] = selection.records ? ['Explicit messages from an observed conversation; surrounding context and unselected records are omitted. Source text may be redacted by observation.'] : [];
  if (start > 0 || end !== undefined) limitations.push('Explicit record range; surrounding context may be missing.');
  if (end !== undefined && records.at(-1)!.recordIndex < end) limitations.push('Source ended before the requested final record.');
  if (malformed) limitations.push(`${malformed} malformed source records retained as raw evidence.`);
  if (session.events.some((event) => event.eventKind === 'context_compaction')) limitations.push('Source contains compaction; earlier context may be unavailable.');
  if (session.events.some((event) => event.eventKind === 'unknown')) limitations.push('Some source events could not be interpreted.');
  const window: EvidenceWindow = {
    snapshotId, sourceKind: detected.sourceKind, sourcePath: path,
    sourceVersion: hash(JSON.stringify(records)), projectionVersion: EVIDENCE_PROJECTION_VERSION,
    capturedAt: new Date().toISOString(), startRecord: records[0].recordIndex, endRecord: records.at(-1)!.recordIndex,
    ...(selection.origin ? { origin: selection.origin } : {}),
    limitations, records,
    excerpts: session.events.flatMap((event, index) => {
      const text = eventText(event);
      if (text === undefined) return [];
      return [{
        evidenceRef: `${snapshotId}:${index}`, recordIndex: records[event.sourceIndex].recordIndex,
        eventKind: event.eventKind, ...('role' in event ? { role: event.role } : {}),
        ...(event.timestamp ? { timestamp: event.timestamp } : {}), text,
      }];
    }),
  };
  return EvidenceWindowSchema.parse(window);
}
