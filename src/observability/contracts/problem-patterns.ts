export type ExperienceProblemBucket =
  | 'output_format'
  | 'content_accuracy'
  | 'missing_context'
  | 'rule_violation'
  | 'workflow_mismatch'
  | 'tool_runtime'
  | 'goal_shift'
  | 'unclear';

export type ExperienceProblemSignal =
  | 'user_correction'
  | 'negative_feedback'
  | 'user_interruption'
  | 'hard_rule'
  | 'user_goal_shift'
  | 'tool_failure'
  | 'workflow_mismatch'
  | 'artifact_missing'
  | 'observer_lifecycle_failed'
  | 'orchestration_boundary_violation';

export interface ExperienceProblemEvidenceRef {
  id: string;
  kind: string;
  traceId?: string;
  sourceTrace: string;
  sessionId: string;
  messageIndex?: number;
  logicalMessageIndex?: number;
  sourceLineIndex?: number;
  messageUuid?: string;
  callInstanceId?: string;
  toolUseId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant' | 'tool' | 'other';
  label?: string;
  snippet?: string;
}

export interface ExperienceProblemPattern {
  id: string;
  bucket: ExperienceProblemBucket;
  patternKey: string;
  count: number;
  sessionCount: number;
  recentSessionIds: string[];
  signalTypes: ExperienceProblemSignal[];
  evidenceRefs: ExperienceProblemEvidenceRef[];
  lastSeen?: string;
}

export interface ProblemTimelineEvent {
  id: string;
  kind: string;
  traceId?: string;
  sourceTrace: string;
  sessionId: string;
  messageIndex?: number;
  logicalMessageIndex?: number;
  sourceLineIndex?: number;
  messageUuid?: string;
  callInstanceId?: string;
  toolUseId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant' | 'tool' | 'other';
  label?: string;
  snippet?: string;
  fullText?: string;
  toolName?: string;
  isError?: boolean;
}
