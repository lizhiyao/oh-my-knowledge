import type { ToolCallStatus } from '../../executors/contracts/trace.js';
import type { ObservationSourceRecordArchiveView } from '../contracts/inbox.js';
import type { TraceSourceKind, TraceSourceMetadata } from '../contracts/trace.js';
import type {
  ExperienceEvidenceRef,
  ExperienceReviewIndicators,
  ExperienceSessionStory,
  ExperienceTimelineEvent,
  ExperienceTurnSummary,
  TaskWindowBasis,
} from '../contracts/experience.js';

export type DebugKnowledgeKind = 'project_instruction' | 'skill' | 'runtime_evidence';
export type DebugKnowledgeAccessKind = 'injected' | 'read' | 'returned';
export type TaskReplayStepKind =
  | 'user_request'
  | 'user_message'
  | 'user_correction'
  | 'runtime_context'
  | 'skill_context'
  | 'tool_exchange'
  | 'unmatched_tool_result'
  | 'assistant_message'
  | 'model_activity'
  | 'lifecycle'
  | 'observation'
  | 'system_event';
export type TaskReplayIntegrityCode =
  | 'task_boundary_unavailable'
  | 'timeline_truncated'
  | 'malformed_records'
  | 'ignored_values'
  | 'unknown_events'
  | 'unmatched_tool_calls'
  | 'unmatched_tool_results'
  | 'missing_timestamps';

export interface TaskTrajectorySession {
  id: string;
  threadId: string;
  sourceThreadId: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: TraceSourceKind;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  cwd?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  attributedEventIds: string[];
  turns: ExperienceTurnSummary[];
  fullSessionTimeline: ExperienceTimelineEvent[];
  indicators?: Pick<ExperienceReviewIndicators, 'userCorrectionCount'>;
  sessionStory?: ExperienceSessionStory;
}

export interface TaskWindowScope {
  basis: TaskWindowBasis;
  turnId?: string;
  normalizedEventCount: number;
  semanticEventCount: number;
  attributedEventCount: number;
  matchedAttributedEventCount: number;
  truncated: boolean;
}

export interface DebugKnowledgeEvidence {
  id: string;
  knowledgeKind: DebugKnowledgeKind;
  accessKind: DebugKnowledgeAccessKind;
  label: string;
  sourceLocator?: string;
  contentHash?: string;
  firstSeen?: string;
  lastSeen?: string;
  accessCount: number;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface TaskReplayStep {
  id: string;
  order: number;
  stepKind: TaskReplayStepKind;
  timestamp?: string;
  title: string;
  events: ExperienceTimelineEvent[];
  toolStatus?: ToolCallStatus;
  knowledgeEvidenceIds: string[];
}

export interface TaskReplayIntegrityNotice {
  code: TaskReplayIntegrityCode;
  count: number;
}

export interface KnowledgeDebuggerViewModel {
  session: TaskTrajectorySession;
  taskScope: TaskWindowScope;
  summary: {
    userGoal?: string;
    finalResponse?: string;
    observedStartTimestamp?: string;
    observedEndTimestamp?: string;
    toolCallCount: number;
    toolFailureCount: number;
    hasUserCorrection: boolean;
    /** Distinct models observed inside the attributed task window, in first-seen order. */
    observedModels: string[];
  };
  steps: TaskReplayStep[];
  normalizedEvents: ExperienceTimelineEvent[];
  sourceRecords: ObservationSourceRecordArchiveView;
  knowledgeEvidence: DebugKnowledgeEvidence[];
  integrity: {
    status: 'complete' | 'partial';
    notices: TaskReplayIntegrityNotice[];
  };
}
