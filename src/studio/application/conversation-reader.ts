import type { ConversationCatalog } from '../../observability/conversation/catalog.js';
import type { ConversationReaderPage } from '../view-models/conversation-reader.js';
import { conversationExtractionSource } from './conversation-extraction.js';

/** Read a small page of turns through the same source projection used for extraction. */
export async function readConversationTurns(catalog: ConversationCatalog, threadId: string, offset: number, limit: number, cursor: { before?: string; after?: string } = {}): Promise<ConversationReaderPage | undefined> {
  const conversation = await catalog.getConversation(threadId);
  if (!conversation) return undefined;
  const all = conversation.tasks;
  const anchor = cursor.before ?? cursor.after;
  const position = anchor ? all.findIndex(task => task.turnId === anchor) : -1;
  if (anchor && position < 0) throw new Error('conversation_cursor_unavailable');
  const end = cursor.after ? Math.min(all.length, position + offset + limit) : Math.max(0, (cursor.before ? position : all.length) - offset);
  const start = cursor.after ? Math.min(all.length, position + offset) : Math.max(0, end - limit);
  const tasks = all.slice(start, end).reverse();
  const turns: ConversationReaderPage['turns'] = [];
  for (const task of tasks) {
    try {
      const source = await conversationExtractionSource(catalog, threadId, task.sourceTurnId ?? task.turnId);
      turns.push({ task, messages: source.messages.map(({ role, text, timestamp }) => ({ role: role ?? 'assistant', text, timestamp })), unavailable: false });
    } catch { turns.push({ task, messages: [], unavailable: true }); }
  }
  return { total: all.length, hasOlder: start > 0, hasNewer: end < all.length, turns };
}
