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
    // 覆盖生命周期级用户可见变化（标题改名、归档、新任务、运行中任务切换）；
    // 增长信号（工具计数、最近活动时间）刻意不入 revision，避免运行中每轮轮询都触发整页刷新。
    return [
      conversation.threadId,
      conversation.title,
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
  // 任务行覆盖生命周期（状态、起止时间）；会话标题是详情页标题，改名需可见；
  // 任务内事件/工具计数增长刻意不覆盖（理由同列表快照）。
  const state = {
    title: conversation.title,
    tasks: conversation.tasks.map((task) => [
      task.turnId,
      task.status,
      task.startTimestamp ?? null,
      task.endTimestamp ?? null,
    ]),
  };
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
