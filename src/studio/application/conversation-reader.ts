import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { ConversationReaderPage } from '../view-models/conversation-reader.js';
import { conversationExtractionSource } from './conversation-extraction.js';

/** Read a small page of turns through the same source projection used for extraction. */
export async function readConversationTurns(catalog: ConversationCatalog, threadId: string, offset: number, limit: number): Promise<ConversationReaderPage | undefined> {
  const conversation = await catalog.getConversation(threadId);
  if (!conversation) return undefined;
  const tasks = [...conversation.tasks].reverse().slice(offset, offset + limit);
  const turns: ConversationReaderPage['turns'] = [];
  for (const task of tasks) {
    try {
      const source = await conversationExtractionSource(catalog, threadId, task.sourceTurnId ?? task.turnId);
      turns.push({ task, messages: source.messages.map(({ role, text, timestamp }) => ({ role: role ?? 'assistant', text, timestamp })), unavailable: false });
    } catch { turns.push({ task, messages: [], unavailable: true }); }
  }
  return { total: conversation.tasks.length, turns };
}
