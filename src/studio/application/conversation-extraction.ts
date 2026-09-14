import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import { projectCodexEvidence } from '../../observability/knowledge-extraction/adapters/codex-evidence.js';

/** Resolve identities through the same catalog as Observe; never trust client paths or text. */
export async function conversationExtractionSource(catalog: ConversationCatalog, threadId: string, turnId: string) {
  const conversation = await catalog.getConversation(threadId);
  if (!conversation?.tasks.some(task => (task.sourceTurnId ?? task.turnId) === turnId)) throw new Error('Conversation task unavailable.');
  const trajectory = await catalog.loadTaskTrajectory(threadId, turnId, { includeNextHumanMessage: false });
  if (!trajectory || trajectory.sourceRecords.status !== 'available' || trajectory.sourceRecords.truncated) throw new Error('Conversation source unavailable or incomplete.');
  const records = trajectory.sourceRecords.records;
  if (records.some(record => record.truncated)) throw new Error('Conversation source incomplete.');
  const window = projectCodexEvidence({ path: trajectory.session.sourceTrace, records: records.map(record => ({ recordIndex: record.sourceIndex, raw: record.raw })),
    origin: { threadId, turnId, title: conversation.title, ...(conversation.cwd ? { cwd: conversation.cwd } : {}) } });
  const messages = window.excerpts.filter(entry => entry.eventKind === 'message' && ['user', 'assistant'].includes(entry.role ?? ''));
  return { window, messages };
}
