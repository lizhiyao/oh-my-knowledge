export type ObservationReviewTargetType =
  | 'experience_session'
  | 'inbox_item'
  | 'skill'
  | 'goal_slice_correction'
  | 'evidence_metric'
  | 'reviewer_judgment'
  | 'soft_standard'
  | 'goal_keyword_correction'
  | 'result_artifact_correction'
  | 'completion_result_correction'
  | 'deliverable_artifact_correction'
  | 'skill_relevance_correction'
  | 'workflow_completion_correction'
  | 'hardrule_execution_correction'
  | 'main_tool_execution_correction';
export type ObservationReviewVerdict = 'reviewed' | 'real_issue' | 'not_issue' | 'needs_more_context' | 'confirmed' | 'rejected';
export type ObservationMetricKey =
  | 'user_correction'
  | 'user_interruption'
  | 'user_follow_up'
  | 'negative_feedback'
  | 'positive_feedback'
  | 'hard_rule'
  | 'user_goal_shift'
  | 'result_artifact'
  | 'completion_result'
  | 'deliverable_artifact'
  | 'progress_update'
  | 'self_correction'
  | 'repeated_execution';
export type ObservationMetricScope = 'message' | 'skill_segment';

export interface ObservationReviewStateEntry {
  targetType: ObservationReviewTargetType;
  targetId: string;
  verdict: ObservationReviewVerdict;
  reviewedAt: string;
  note?: string;
  reason?: string;
  metricKey?: ObservationMetricKey;
  metricScope?: ObservationMetricScope;
  metricScopeId?: string;
  traceId?: string;
  sourceTrace?: string;
  sessionId?: string;
  messageIndex?: number;
  messageUuid?: string;
  callInstanceId?: string;
  toolUseId?: string;
  snippet?: string;
}

export interface ObservationReviewState {
  kind: 'observe-review-state';
  schemaVersion: 2;
  updatedAt: string;
  entries: Record<string, ObservationReviewStateEntry>;
}

export interface ObservationReviewStateUpdate {
  targetType: ObservationReviewTargetType;
  targetId: string;
  verdict: ObservationReviewVerdict;
  note?: string;
  reason?: string;
  metricKey?: ObservationMetricKey;
  metricScope?: ObservationMetricScope;
  metricScopeId?: string;
  traceId?: string;
  sourceTrace?: string;
  sessionId?: string;
  messageIndex?: number;
  messageUuid?: string;
  callInstanceId?: string;
  toolUseId?: string;
  snippet?: string;
}
