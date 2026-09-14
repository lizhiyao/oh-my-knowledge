import type { ConversationTaskItem } from '../../observability/view-models/conversation.js';
export interface ConversationReaderPage {
  total: number;
  turns: { task: ConversationTaskItem; messages: { role: string; text: string; timestamp?: string }[]; unavailable: boolean }[];
}
