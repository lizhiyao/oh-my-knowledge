import { createHash } from 'node:crypto';
import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import { readTraceSource, type TraceSourceReadContext } from '../adapters/trace-source-reader.js';
import { normalizeRecordRanges, type SourceRecordRange } from '../sources.js';

/** Resolve original records through Observe. Browser selectors never supply paths, text or offsets. */
export async function conversationExtractionSource(catalog: ConversationCatalog, threadId: string, turnId?: string,
  signal?: AbortSignal, selectedTurns?: readonly string[], recordIndexes?: readonly number[]) {
  const conversation = await catalog.getConversation(threadId);
  if (!conversation) throw new Error('Conversation unavailable.');
  const turns = [...new Set(conversation.tasks.map(task => task.sourceTurnId ?? task.turnId))];
  if (turnId && !turns.includes(turnId) || selectedTurns?.some(id => !turns.includes(id))) throw new Error('Conversation task unavailable.');
  const records = new Map<number, { recordIndex: number; raw: string }>();
  let path: string | undefined, bytes = 0;
  for (const id of selectedTurns ?? (turnId ? [turnId] : turns)) {
    signal?.throwIfAborted();
    let source: { path: string; records: { recordIndex: number; raw: string }[] } | undefined;
    if (catalog.loadTaskMessageRecords) source = await catalog.loadTaskMessageRecords(threadId, id);
    else {
      const trajectory = await catalog.loadTaskTrajectory(threadId, id, { includeNextHumanMessage: false });
      if (!trajectory || trajectory.sourceRecords.status !== 'available' || trajectory.sourceRecords.truncated
        || trajectory.sourceRecords.records.some(record => record.truncated)) throw new Error('Conversation source unavailable or incomplete.');
      source = { path: trajectory.session.sourceTrace,
        records: trajectory.sourceRecords.records.map(record => ({ recordIndex: record.sourceIndex, raw: record.raw })) };
    }
    if (!source) throw new Error('Conversation source unavailable.');
    if (path && path !== source.path) throw new Error('Conversation source conflict.');
    path = source.path;
    for (const record of source.records) {
      const previous = records.get(record.recordIndex);
      if (previous && previous.raw !== record.raw) throw new Error('Conversation source conflict.');
      if (!previous) bytes += Buffer.byteLength(record.raw);
      if (bytes > 16 * 1024 * 1024 || records.size >= 100_000 && !previous) throw new Error('Conversation exceeds capacity. Choose one task.');
      records.set(record.recordIndex, record);
    }
  }
  if (!path || !records.size) throw new Error('Conversation has no available messages.');
  const sourceId = `conversation:${createHash('sha256').update(JSON.stringify([conversation.sourceKind, threadId])).digest('hex')}`;
  const ordered = [...records.values()].sort((a, b) => a.recordIndex - b.recordIndex);
  const ranges = (indexes: readonly number[]): SourceRecordRange[] => {
    const grouped: SourceRecordRange[] = [];
    for (const index of [...new Set(indexes)].sort((a, b) => a - b)) {
      const previous = grouped.at(-1);
      if (previous && index === previous.endRecord + 1) previous.endRecord = index;
      else grouped.push({ startRecord: index, endRecord: index });
    }
    if (grouped.length > 256) throw new Error('Conversation exceeds range capacity. Choose one task.');
    return normalizeRecordRanges(grouped, ordered.at(-1)!.recordIndex);
  };
  const binding: TraceSourceReadContext = { sourceId, traceKind: conversation.sourceKind,
    source: { sourceType: 'records', records: ordered },
    origin: { threadId, ...(turnId ? { turnId } : {}), title: conversation.title } };
  const all = readTraceSource({ sourceKind: 'agent_trace', sourceId, traceKind: binding.traceKind,
    recordRanges: ranges(ordered.map(record => record.recordIndex)) }, { ...binding, signal });
  const messageIndexes = [...new Set(all.projection.excerpts.flatMap(excerpt => excerpt.coordinate.coordinateKind === 'trace_event'
    && excerpt.coordinate.eventKind === 'message' && ['user', 'assistant'].includes(excerpt.coordinate.role ?? '') ? [excerpt.coordinate.recordIndex] : []))];
  const selected = recordIndexes === undefined ? messageIndexes : [...new Set(recordIndexes)];
  if (!selected.length || selected.some(index => !messageIndexes.includes(index))) throw new Error('Invalid conversation message selection.');
  if (messageIndexes.length > 1000) throw new Error('Conversation exceeds message capacity. Choose one task.');
  const selection = { sourceKind: 'agent_trace' as const, sourceId, traceKind: binding.traceKind, recordRanges: ranges(selected) };
  const reading = readTraceSource(selection, { ...binding, signal });
  const messages = reading.projection.excerpts.flatMap((excerpt, ordinal) => {
    const coordinate = excerpt.coordinate;
    return coordinate.coordinateKind === 'trace_event' && coordinate.eventKind === 'message' && ['user', 'assistant'].includes(coordinate.role ?? '')
      ? [{ excerptKey: `${coordinate.recordIndex}:${coordinate.eventOrdinal}:${ordinal}`, recordIndex: coordinate.recordIndex,
        role: coordinate.role!, text: excerpt.text, ...(coordinate.timestamp ? { timestamp: coordinate.timestamp } : {}) }] : [];
  });
  return { reading, selection, binding, messages, origin: binding.origin!,
    scopeRevision: `sha256:${createHash('sha256').update(JSON.stringify({ sourceId, turnId, selectedTurns, sourceVersion: reading.sourceVersion })).digest('hex')}` };
}
