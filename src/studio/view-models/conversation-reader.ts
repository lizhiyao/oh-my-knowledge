import type { ConversationTaskItem } from '../../observability/view-models/conversation.js';
export interface ConversationReaderPage {
  total: number;
  hasOlder: boolean;
  hasNewer: boolean;
  turns: { task: ConversationTaskItem; messages: { role: string; text: string; timestamp?: string }[]; unavailable: boolean }[];
}
