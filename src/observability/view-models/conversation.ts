import type { ExperienceTurnStatus } from '../contracts/experience.js';
import type { ObservationSourceKind } from '../contracts/trace.js';

export interface ConversationTaskItem {
  turnId: string;
  sourceTurnId?: string;
  /** Existing observe reports retain their report-scoped session route. */
  experienceSessionId?: string;
  /** Preferred source-neutral task trajectory route. */
  trajectoryHref?: string;
  title: string;
  startTimestamp?: string;
  endTimestamp?: string;
  durationMs?: number;
  status: ExperienceTurnStatus;
  eventCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  relatedSkillNames: string[];
}

export interface ConversationListItem {
  threadId: string;
  sourceThreadId: string;
  sourceKind: ObservationSourceKind;
  title: string;
  preview?: string;
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  archived?: boolean;
  tokensUsed?: number;
  childThreadCount?: number;
  startTimestamp?: string;
  endTimestamp?: string;
  durationMs?: number;
  /** Undefined until the selected rollout has been indexed. */
  turnCount?: number;
  toolCallCount?: number;
  toolFailureCount?: number;
  relatedSkillNames: string[];
  tasks: ConversationTaskItem[];
}

export interface ConversationIndexViewModel {
  conversations: ConversationListItem[];
  totalTurnCount: number;
  totalToolCallCount: number;
  totalToolFailureCount: number;
  indexedConversationCount?: number;
  unarchivedConversationCount?: number;
  archivedConversationCount?: number;
  workspaceCount?: number;
}
