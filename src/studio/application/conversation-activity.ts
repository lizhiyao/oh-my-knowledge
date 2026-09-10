import { createHash } from 'node:crypto';
import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ConversationTaskItem
} from '../../observability/view-models/index.js';
import type { ConversationActivitySnapshot, ConversationDetailActivitySnapshot } from '../view-models/conversation-activity.js';

export function buildConversationActivitySnapshot(
  model: ConversationIndexViewModel,
): ConversationActivitySnapshot {
  let runningCount = 0;
  const state = model.conversations.map((conversation) => {
    const openTask = latestOpenConversationTask(conversation);
    if (openTask) runningCount += 1;
    return [
      conversation.threadId,
      conversation.archived ? 1 : 0,
      conversation.turnCount ?? null,
      openTask?.turnId ?? null,
    ];
  });
  return {
    schemaVersion: 1,
    revision: createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 24),
    runningCount,
  };
}

export function buildConversationDetailActivitySnapshot(
  conversation: ConversationListItem,
): ConversationDetailActivitySnapshot {
  const state = conversation.tasks.map((task) => [
    task.turnId,
    task.status,
    task.startTimestamp ?? null,
    task.endTimestamp ?? null,
  ]);
  return {
    schemaVersion: 1,
    revision: createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 24),
    taskCount: conversation.tasks.length,
    runningCount: conversation.tasks.filter((task) => task.status === 'open').length,
  };
}

export function latestOpenConversationTask(
  conversation: ConversationListItem,
): ConversationTaskItem | undefined {
  for (let index = conversation.tasks.length - 1; index >= 0; index -= 1) {
    const task = conversation.tasks[index];
    if (task?.status === 'open') return task;
  }
  return undefined;
}
