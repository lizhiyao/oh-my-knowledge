import { loadLatestObservationInboxReports } from './inbox/index.js';
import type { ExperienceSessionSummary, ExperienceTurnSummary } from './contracts/experience.js';
import type { ObservationSourceKind } from './contracts/trace.js';
import type {
  ConversationIndexViewModel,
  ConversationListItem,
  ConversationTaskItem,
} from './view-models/conversation.js';
import { durationMsBetween } from '../shared/time.js';
import type { ConversationCatalog } from './conversation-catalog.js';

interface MutableTask {
  turn: ExperienceTurnSummary;
  experienceSessionId: string;
  relatedSkills: Set<string>;
}

interface MutableConversation {
  threadId: string;
  sourceThreadId: string;
  sourceKind: ObservationSourceKind;
  sessions: ExperienceSessionSummary[];
  tasks: Map<string, MutableTask>;
  relatedSkills: Set<string>;
}

export function buildConversationIndexViewModel(
  observationsDir: string,
): ConversationIndexViewModel {
  const groups = new Map<string, MutableConversation>();
  const reports = loadLatestObservationInboxReports(observationsDir);

  for (const report of reports) {
    for (const session of report.experience?.sessions ?? []) {
      const group = groups.get(session.threadId) ?? {
        threadId: session.threadId,
        sourceThreadId: session.sourceThreadId,
        sourceKind: session.sourceKind,
        sessions: [],
        tasks: new Map<string, MutableTask>(),
        relatedSkills: new Set<string>(),
      };
      group.sessions.push(session);
      group.relatedSkills.add(session.skillName);
      const attributedIds = new Set(session.attributedEventIds);

      for (const turn of session.turns) {
        const related = turn.eventIds.some((id) => attributedIds.has(id));
        const existing = group.tasks.get(turn.turnId);
        if (!existing || turn.eventIds.length > existing.turn.eventIds.length) {
          group.tasks.set(turn.turnId, {
            turn,
            experienceSessionId: session.id,
            relatedSkills: new Set(existing?.relatedSkills ?? []),
          });
        }
        if (related) {
          const task = group.tasks.get(turn.turnId);
          task?.relatedSkills.add(session.skillName);
          if (task && task.experienceSessionId !== session.id) {
            task.experienceSessionId = session.id;
          }
        }
      }
      groups.set(session.threadId, group);
    }
  }

  const conversations = Array.from(groups.values())
    .map(finalizeConversation)
    .filter((conversation) => conversation.tasks.length > 0)
    .sort((left, right) => (
      (right.endTimestamp ?? '').localeCompare(left.endTimestamp ?? '')
      || left.threadId.localeCompare(right.threadId)
    ));

  return {
    conversations,
    totalTurnCount: conversations.reduce((sum, item) => sum + (item.turnCount ?? 0), 0),
    totalToolCallCount: conversations.reduce((sum, item) => sum + (item.toolCallCount ?? 0), 0),
    totalToolFailureCount: conversations.reduce((sum, item) => sum + (item.toolFailureCount ?? 0), 0),
  };
}

/** Test/compatibility adapter for persisted observe reports. */
export function createObservationConversationCatalog(
  observationsDir: string,
): ConversationCatalog {
  return {
    async listConversations() {
      return buildConversationIndexViewModel(observationsDir);
    },
    async getConversation(threadId) {
      return buildConversationIndexViewModel(observationsDir).conversations.find((item) => item.threadId === threadId);
    },
    async loadTaskTrajectory() {
      return undefined;
    },
  };
}

function finalizeConversation(group: MutableConversation): ConversationListItem {
  const tasks = Array.from(group.tasks.values())
    .map(({ turn, experienceSessionId, relatedSkills }): ConversationTaskItem => ({
      turnId: turn.turnId,
      sourceTurnId: turn.sourceTurnId,
      experienceSessionId,
      title: turn.title,
      startTimestamp: turn.startTimestamp,
      endTimestamp: turn.endTimestamp,
      durationMs: durationMsBetween(turn.startTimestamp, turn.endTimestamp),
      status: turn.status,
      eventCount: turn.eventIds.length,
      toolCallCount: turn.toolCallCount,
      toolFailureCount: turn.toolFailureCount,
      relatedSkillNames: Array.from(relatedSkills).sort(),
    }))
    .sort((left, right) => (
      (left.startTimestamp ?? '').localeCompare(right.startTimestamp ?? '')
      || left.turnId.localeCompare(right.turnId)
    ));
  const firstTask = tasks[0];
  const lastTask = tasks.at(-1);
  return {
    threadId: group.threadId,
    sourceThreadId: group.sourceThreadId,
    sourceKind: group.sourceKind,
    title: firstTask?.title ?? '未命名对话',
    startTimestamp: firstTask?.startTimestamp,
    endTimestamp: lastTask?.endTimestamp ?? lastTask?.startTimestamp,
    durationMs: durationMsBetween(firstTask?.startTimestamp, lastTask?.endTimestamp ?? lastTask?.startTimestamp),
    turnCount: tasks.length,
    toolCallCount: tasks.reduce((sum, task) => sum + task.toolCallCount, 0),
    toolFailureCount: tasks.reduce((sum, task) => sum + task.toolFailureCount, 0),
    relatedSkillNames: Array.from(group.relatedSkills).sort(),
    tasks,
  };
}
