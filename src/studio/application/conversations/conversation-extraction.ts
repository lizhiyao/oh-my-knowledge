import type { ConversationCatalog } from '../../../observability/conversation/catalog.js';
import { projectCodexEvidence } from '../../../observability/knowledge-extraction/adapters/codex-evidence.js';
import type { EvidenceWindow } from '../../../observability/knowledge-extraction/evidence.js';

/** Resolve the current scope through Observe. Never trust browser paths or message text. */
export async function conversationExtractionSource(catalog: ConversationCatalog, threadId: string, turnId?: string, signal?: AbortSignal) {
  const conversation = await catalog.getConversation(threadId);
  if (!conversation) throw new Error('Conversation unavailable.');
  const turns = [...new Set(conversation.tasks.map(task => task.sourceTurnId ?? task.turnId))];
  if (turnId && !turns.includes(turnId)) throw new Error('Conversation task unavailable.');
  const records = new Map<number, EvidenceWindow['records'][number]>();
  let path: string | undefined;
  let bytes = 0;
  for (const id of turnId ? [turnId] : turns) {
    signal?.throwIfAborted();
    let source: { path: string; records: EvidenceWindow['records'] } | undefined;
    if (catalog.loadTaskMessageRecords) source = await catalog.loadTaskMessageRecords(threadId, id);
    else {
      const trajectory = await catalog.loadTaskTrajectory(threadId, id, { includeNextHumanMessage: false });
      if (!trajectory || trajectory.sourceRecords.status !== 'available' || trajectory.sourceRecords.truncated
        || trajectory.sourceRecords.records.some(record => record.truncated)) throw new Error('Conversation source unavailable or incomplete.');
      source = { path: trajectory.session.sourceTrace, records: trajectory.sourceRecords.records.map(record => ({ recordIndex: record.sourceIndex, raw: record.raw })) };
    }
    if (!source) throw new Error('Conversation source unavailable.');
    if (path && path !== source.path) throw new Error('Conversation source conflict.');
    path = source.path;
    if (!source.records.length) continue;
    const task = projectCodexEvidence(source, signal);
    const indexes = new Set(task.excerpts.filter(entry => entry.eventKind === 'message' && ['user', 'assistant'].includes(entry.role ?? '')).map(entry => entry.recordIndex));
    for (const record of task.records.filter(record => indexes.has(record.recordIndex))) {
      const previous = records.get(record.recordIndex);
      if (previous && previous.raw !== record.raw) throw new Error('Conversation source conflict.');
      if (!previous) bytes += Buffer.byteLength(record.raw);
      if (bytes > 16 * 1024 * 1024) throw new Error('Conversation exceeds capacity. Choose one task.');
      records.set(record.recordIndex, record);
    }
  }
  if (!path || !records.size) throw new Error('Conversation has no available messages.');
  const window = projectCodexEvidence({ path, records: [...records.values()].sort((a, b) => a.recordIndex - b.recordIndex),
    origin: { threadId, ...(turnId ? { turnId } : {}), title: conversation.title, ...(conversation.cwd ? { cwd: conversation.cwd } : {}) } }, signal);
  const messages = window.excerpts.filter(entry => entry.eventKind === 'message' && ['user', 'assistant'].includes(entry.role ?? ''));
  if (messages.length > 1000) throw new Error('Conversation exceeds message capacity. Choose one task.');
  return { window, messages };
}
