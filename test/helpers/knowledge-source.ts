import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';
import { readTraceSource, type TraceSourceReadContext } from '../../src/knowledge/adapters/trace-source-reader.js';
import { sourceVersionPreimage, type SourceRef, type SourceSnapshot, type TraceOrigin } from '../../src/knowledge/sources.js';
import { canonicalJson } from '../../src/knowledge/store.js';

type RawRecord = { recordIndex: number; raw: string };
/** Authored fixtures use the current reader/store; this is not a legacy production capture entry point. */
export function captureTraceFixture(workspace: string, input: { path: string; records?: readonly RawRecord[]; origin?: TraceOrigin;
  sourceId?: string; startRecord?: number; endRecord?: number }): SourceSnapshot {
  const records = input.records ?? readFileSync(input.path, 'utf8').split(/\r?\n/u).filter(line => line.trim()).map((raw, recordIndex) => ({ recordIndex, raw }));
  const selected = records.filter(record => record.recordIndex >= (input.startRecord ?? 0) && record.recordIndex <= (input.endRecord ?? Number.MAX_SAFE_INTEGER));
  const sourceId = input.sourceId ?? `authored:${basename(input.path)}`, traceKind = 'codex';
  const context: TraceSourceReadContext = { sourceId, traceKind,
    source: input.records ? { sourceType: 'records', records: input.records } : { sourceType: 'file', approvedPath: input.path },
    ...(input.origin ? { origin: input.origin } : {}) };
  const reading = readTraceSource({ sourceKind: 'agent_trace', sourceId, traceKind,
    recordRanges: selected.map(record => ({ startRecord: record.recordIndex, endRecord: record.recordIndex })) }, context);
  return new FileSourceStore(join(workspace, 'sources'), workspace).capture(reading.projection).snapshot;
}

/** Pure view/compiler fixture. Storage admission is covered through captureTraceFixture or FileSourceStore. */
export function traceSnapshotFixture(text: string, options: { snapshotId?: string; evidenceRef?: string } = {}): SourceSnapshot {
  const sourceId = 'authored:wire', traceKind = 'codex';
  const raw = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  const { projection } = readTraceSource({ sourceKind: 'agent_trace', sourceId, traceKind, recordRanges: [{ startRecord: 0, endRecord: 0 }] },
    { sourceId, traceKind, source: { sourceType: 'records', records: [{ recordIndex: 0, raw }] } });
  const snapshotId = options.snapshotId ?? randomUUID();
  return { ...projection, snapshotId, capturedAt: '2026-10-30T00:00:00Z',
    sourceVersion: `sha256:${createHash('sha256').update(canonicalJson(sourceVersionPreimage(projection))).digest('hex')}`,
    excerpts: projection.excerpts.map((excerpt, ordinal) => ({ ...excerpt, evidenceRef: options.evidenceRef ?? `${snapshotId}:${ordinal}` })) };
}

export function sourceRef(snapshot: SourceSnapshot): SourceRef { return { snapshotId: snapshot.snapshotId, sourceVersion: snapshot.sourceVersion }; }
