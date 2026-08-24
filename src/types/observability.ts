/**
 * Observability DTO 集中定义。
 *
 * 解开 `src/observability/` 内部 4 个文件(experience / inbox / skill-chain /
 * experience-frontmatter)之间的 type-only 循环依赖：types/ 是叶子层，不依赖
 * 任何业务模块；observability/ 的运行时文件向这里 import 类型即可。
 *
 * 设计原则：
 *   - 只放纯 DTO(string union / interface / 类型别名)，不放任何运行时函数 / 常量
 *   - 不依赖 src 内的业务模块(observability / cli / server / renderer / diagnosis)
 *   - 跨层共享类型集中在 types/，单一来源
 */

import type { DiagnosisBundle } from './diagnosis.js';
import type { ToolCallStatus } from './executor.js';
import type { TraceSourceKind } from './trace.js';
import type { SkillHardRule, SkillWorkflow } from '../shared/hard-rules.js';

// ---------- trace-source ----------

export interface TraceIngestionSummary {
  fileCount: number;
  sourceRecordCount: number;
  parsedRecordCount: number;
  malformedRecordCount: number;
  ignoredValueCount: number;
  unknownEventCount: number;
  filteredSessionCount: number;
}

export interface TraceSourceMetadata {
  channel?: string;
  sender?: string;
  senderId?: string;
  provider?: string;
  model?: string;
  modelApi?: string;
  businessActions?: string[];
}

// ---------- review-state ----------

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

// ---------- problem-patterns ----------

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

// ---------- skill-chain-advisories ----------

export type SkillChainAdvisoryCode =
  | 'hardrules_not_declared'
  | 'workflows_not_declared'
  | 'skill_md_not_found';

export interface SkillChainAdvisory {
  code: SkillChainAdvisoryCode;
  message: string;
  exampleYaml?: string;
  commandTemplate?: string;
  shortLabel: string;
}

// ---------- inbox ----------

export type ObservationSignalType = 'failed_search' | 'repeated_failure' | 'hedging' | 'explicit_marker' | 'user_feedback';
/** @deprecated Prefer TraceSourceKind for new source-neutral APIs. */
export type ObservationSourceKind = TraceSourceKind;
export type ObservationSeverityReasonCode =
  | 'knowledge_gap_suspected'
  | 'repeated_failure_suspected'
  | 'explicit_gap_marker'
  | 'exploratory_probe'
  | 'skill_asset_unavailable'
  | 'soft_hedging_signal'
  | 'user_reported_knowledge_issue'
  | 'tool_or_runtime_noise';
export type ObservationSignalSubtype =
  | 'hard_miss'
  | 'repeated_failure'
  | 'exploratory_miss'
  | 'tool_error'
  | 'permission_error'
  | 'bash_probe'
  | 'not_found'
  | 'transient_file_missing'
  | 'skill_asset_read_failed'
  | 'permission_denied'
  | 'tool_limit'
  | 'tool_failure'
  | 'regex_only'
  | 'llm_classified'
  | 'marker'
  | 'explicit_user_feedback';

export type ObservationCaptureObservedEventKind =
  | 'tool_boundary'
  | 'user_feedback'
  | 'submitted_evidence';

export type ObservationCaptureUnavailableEventKind =
  | 'full_conversation'
  | 'external_tool_calls'
  | 'hidden_reasoning';

export interface ObservationCaptureCoverage {
  coverageStatus: 'partial';
  capturePath: 'explicit_tool_call';
  observedEventKinds: ObservationCaptureObservedEventKind[];
  unavailableEventKinds: ObservationCaptureUnavailableEventKind[];
}

export interface ObservationEvidence {
  traceId?: string;
  sessionId?: string;
  sourceTrace?: string;
  sourceKind?: ObservationSourceKind;
  tool?: string;
  query?: string;
  path?: string;
  outputSnippet?: string;
  assistantSnippet?: string;
  userFeedbackSnippet?: string;
  submittedEvidenceSnippet?: string;
  markerToken?: string;
  messageIndex?: number;
  messageUuid?: string;
  callInstanceId?: string;
  toolUseId?: string;
  segmentTimestamp?: string;
}

export interface ObservationMessageRef {
  role: 'user' | 'assistant' | 'other';
  snippet: string;
  messageIndex: number;
  uuid?: string;
  timestamp?: string;
}

export interface ObservationMessageWindow {
  before: ObservationMessageRef[];
  event: ObservationMessageRef[];
  after: ObservationMessageRef[];
  resolutionAfter: 'resolved' | 'unresolved' | 'unknown';
}

export interface ObservationInboxItem {
  id: string;
  skillName: string;
  artifactVersion: string | 'unknown';
  artifactHash?: string;
  cwd?: string;
  sessionId: string;
  /** Physical evidence stream identity; unlike sessionId, unique across reused run ids. */
  traceId?: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  signalType: ObservationSignalType;
  signalSubtype: ObservationSignalSubtype;
  confidence: number;
  attributionConfidence: number;
  severity: 'high' | 'medium' | 'low' | 'noise';
  severityReasonCode?: ObservationSeverityReasonCode;
  severityReason?: string;
  captureCoverage?: ObservationCaptureCoverage;
  evidence: ObservationEvidence;
  messageWindow?: ObservationMessageWindow;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  /** Occurrences backed by an observed source timestamp. */
  timestampedOccurrences?: number;
  recentSessionIds: string[];
  recentTraceIds?: string[];
  representativeEvidence: ObservationEvidence[];
}

export interface ObservationSessionTimeRange {
  sessionId: string;
  traceId?: string;
  sessionGroupId?: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  cwd?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  durationMs?: number;
}

export type ObservationSourceRecordArchiveStatus = 'available' | 'partial' | 'unavailable';
export type ObservationSourceRecordArchiveReason =
  | 'no_record_ranges'
  | 'source_missing'
  | 'unsupported_source'
  | 'read_failed'
  | 'archive_limit';

/**
 * A report only retains a relative pointer to its bounded source-record archive.
 * The archive itself stays beside the report so Studio never follows an
 * arbitrary absolute path supplied by report JSON.
 */
export interface ObservationSourceRecordArchiveRef {
  experienceSessionId: string;
  status: ObservationSourceRecordArchiveStatus;
  relativePath?: string;
  recordCount: number;
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
  reason?: ObservationSourceRecordArchiveReason;
}

export interface ObservationSourceRecord {
  sourceIndex: number;
  traceId: string;
  sourceTrace: string;
  sourceType: string;
  sourceEventId?: string;
  timestamp?: string;
  raw: string;
  byteCount: number;
  truncated: boolean;
  redacted: boolean;
}

export interface ObservationSourceRecordArchive {
  archiveKind: 'observe-source-records';
  schemaVersion: 1;
  experienceSessionId: string;
  generatedAt: string;
  records: ObservationSourceRecord[];
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
}

export interface ObservationSourceRecordArchiveView {
  status: ObservationSourceRecordArchiveStatus;
  /** Total retained records, even when `records` is intentionally lazy. */
  recordCount: number;
  records: ObservationSourceRecord[];
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
  reason?: ObservationSourceRecordArchiveReason | 'archive_invalid';
}

export interface ObservationInboxReport {
  kind: 'observe-inbox';
  schemaVersion: 2;
  meta: {
    tracePath: string;
    generatedAt: string;
    sessionCount?: number;
    sessionTimeRange?: {
      from: string;
      to: string;
      durationMs?: number;
    };
    sessionTimeRanges?: ObservationSessionTimeRange[];
    ingestion?: TraceIngestionSummary;
    segmentCount: number;
    itemCount: number;
    skillInvocationCounts?: Record<string, number>;
    skillSessionCounts?: Record<string, number>;
    skillInvocationLastSeen?: Record<string, string>;
    skillToolCallCounts?: Record<string, Record<string, number>>;
    timestampedSegmentCount?: number;
    timestampCoverage?: number;
    sourceRecordArchives?: ObservationSourceRecordArchiveRef[];
  };
  items: ObservationInboxItem[];
  experience?: ObservationExperienceReport;
  diagnostics?: DiagnosisBundle;
}

export interface ObservationSkillRollup {
  skillName: string;
  invocationCount: number;
  sessionCount: number;
  observationCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  noiseCount: number;
  latestSeen: string;
}

export interface BuildObservationInboxReportOptions {
  reviewState?: ObservationReviewState;
}

// ---------- experience: string unions ----------

export type ExperienceReviewPriority = 'review_first' | 'sample_review' | 'routine_sample';
export type ExperienceGoalSliceReasonCode = 'skill_segment_boundary' | 'explicit_user_goal_shift' | 'default_session_slice';
export type ExperienceEvidenceKind = 'user_message' | 'synthetic_user_event' | 'assistant_message' | 'model_activity' | 'agent_activity' | 'tool_use' | 'tool_result' | 'skill_context' | 'runtime_context' | 'lifecycle' | 'observation';
export type ExperienceAssistiveInferenceCode =
  | 'review_recommended'
  | 'sample_recommended'
  | 'positive_signal_observed'
  | 'user_switched_topic_neutral'
  | 'no_obvious_issue_from_rules'
  | 'insufficient_human_context';
export type ExperienceAssistiveInferenceConfidence = 'low' | 'medium' | 'high';
export type ExperienceAssistiveInferenceCautionCode =
  | 'no_llm_judge'
  | 'rule_only'
  | 'runtime_context_excluded'
  | 'skill_context_excluded'
  | 'no_human_user_message'
  | 'limited_timeline_window';
export type ExperienceReviewBasisCode =
  | 'has_high_observation'
  | 'has_medium_observation'
  | 'user_correction'
  | 'user_interruption'
  | 'session_interrupted'
  | 'negative_feedback'
  | 'hard_rule_text_hit'
  | 'tool_failure'
  | 'hedging_signal'
  | 'explicit_marker';
export type ExperienceRuleFindingLevel = 'attention' | 'sample' | 'normal';
export type ExperienceReviewerReportScope = 'single_skill_single_goal' | 'degraded_complex';
export type ExperienceReviewerReportStepStatus = 'ok' | 'attention' | 'unknown' | 'degraded' | 'not_applicable';
export type ExperienceReviewerReportFindingLevel = 'attention' | 'possible_false_positive' | 'note';
export type ExperienceReviewerReportFindingSource = 'deterministic_rule' | 'llm_soft' | 'manual';
export type ExperienceChecklistItemStatus = 'passed' | 'failed' | 'unknown' | 'not_declared' | 'not_applicable' | 'degraded';
export type ExperienceChecklistContribution = 'blocking' | 'attention' | 'informational' | 'positive' | 'neutral';
export type ExperienceParentReason =
  | 'data_degraded'
  | 'blocking_failed'
  | 'attention_accumulated'
  | 'unknown_dominant'
  | 'all_passed'
  | 'not_applicable';
export type ExperienceSessionStoryNodeKind =
  | 'user_goal'
  | 'skill_invocation'
  | 'subagent_branch'
  | 'tool_execution'
  | 'delivery'
  | 'user_feedback'
  | 'goal_shift';
export type ExperienceSessionStoryAnswerKey = 'goal_satisfaction' | 'declared_behavior_fit' | 'user_feeling';
export type ExperienceSessionStorySkillRole = 'router' | 'executor' | 'mixed' | 'unknown';
export type ExperienceEpisodeBoundaryReason = 'goal_shift' | 'checkpoint_or_subagent' | 'downstream_closed' | 'session_end';
export type ExperienceEpisodeRole = 'main_executor' | 'router' | 'delegator' | 'supporting' | 'observer';
export type ExperienceFeedbackSignalType = 'correction' | 'follow_up' | 'frustration' | 'interruption' | 'positive' | 'unknown';
export type ExperienceFeedbackAttributionRole = 'primary_fault' | 'downstream_related' | 'context_only';
export type ExperienceFeedbackAttributionReason = 'object_match' | 'promise_match' | 'action_match' | 'orchestration_edge' | 'episode_context';
export type ExperienceOutcomeClosure = 'closed' | 'unresolved' | 'abandoned' | 'unknown';
export type ExperienceRuntimeSkillType = 'router' | 'delegation' | 'executor' | 'advisory' | 'workflow_owner' | 'unknown';
export type ExperienceRuntimeSkillTypeSource = 'frontmatter' | 'trace' | 'unknown';
export type ExperienceEpisodeArtifactKind = 'path' | 'url' | 'document' | 'code' | 'execution_window' | 'unknown';
export type ExperienceOrchestrationEdgeStatus = 'started' | 'completed' | 'failed' | 'unknown';
export type ExperienceOrchestrationEdgeKind = 'internal_skill' | 'external_child_session';
export type ExperienceRuleFindingCode =
  | 'high_observation_seen'
  | 'medium_observation_seen'
  | 'user_correction_seen'
  | 'user_interruption_seen'
  | 'session_interrupted_seen'
  | 'negative_feedback_seen'
  | 'positive_feedback_seen'
  | 'user_goal_shift_seen'
  | 'hard_rule_seen'
  | 'tool_failure_seen'
  | 'hedging_seen'
  | 'explicit_marker_seen'
  | 'runtime_context_excluded'
  | 'skill_context_excluded'
  | 'no_priority_signal';

// ---------- experience: interfaces ----------

export interface ExperienceEvidenceRef {
  id: string;
  kind: ExperienceEvidenceKind;
  traceId?: string;
  sourceTrace: string;
  sessionId: string;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  messageIndex?: number;
  logicalMessageIndex?: number;
  sourceLineIndex?: number;
  messageUuid?: string;
  /** Source-native record classification retained after normalization. */
  sourceType?: string;
  /** Source-neutral identity for one agent turn, when the trace exposes it. */
  turnId?: string;
  /** Source-neutral identity for one concrete tool-call occurrence. */
  callInstanceId?: string;
  toolUseId?: string;
  timestamp?: string;
  role?: 'user' | 'assistant' | 'tool' | 'other';
  modelActivityKind?: 'reasoning';
  contentVisibility?: 'plaintext' | 'opaque';
  contentSource?: 'summary' | 'content' | 'text';
  runtimeKind?: 'session_context' | 'execution_context' | 'settings' | 'goal' | 'context_compaction' | 'usage';
  label?: string;
  snippet?: string;
}

export interface ExperienceTimelineEvent extends ExperienceEvidenceRef {
  order: number;
  /** Model explicitly associated with this normalized event by the source adapter. */
  model?: string;
  toolName?: string;
  toolStatus?: ToolCallStatus;
  isError?: boolean;
  fullText?: string;
  attachments?: Array<{
    attachmentKind: 'image' | 'file';
    name: string;
  }>;
}

// ---------- Knowledge Debugger task trajectory ----------

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

export type TaskWindowBasis =
  | 'turn_id'
  | 'turn_lifecycle'
  | 'user_message'
  | 'unresolved';

export type ExperienceTurnStatus =
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'interrupted'
  | 'open'
  | 'unknown';

/**
 * One user-visible task inside a source thread. `turnId` is the stable,
 * source-neutral identity used by Studio routes. `sourceTurnId` preserves the
 * runtime-native identity when the source exposes one.
 */
export interface ExperienceTurnSummary {
  turnId: string;
  sourceTurnId?: string;
  boundaryBasis: Exclude<TaskWindowBasis, 'unresolved'>;
  traceId?: string;
  sourceTrace: string;
  startTimestamp?: string;
  endTimestamp?: string;
  status: ExperienceTurnStatus;
  title: string;
  eventIds: string[];
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolFailureCount: number;
}

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

/**
 * Source-neutral task trajectory input. Observe reports carry more review and
 * Skill-attribution fields, but the debugger only requires this trace slice.
 */
export interface TaskTrajectorySession {
  id: string;
  threadId: string;
  sourceThreadId: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
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

export interface ExperienceTimelineBranch {
  id: string;
  label: string;
  sessionId: string;
  traceId?: string;
  sourceTrace: string;
  traceRole: 'main' | 'subagent' | 'standalone';
  attachTo?: {
    traceId?: string;
    sourceTrace: string;
    messageIndex?: number;
    callInstanceId?: string;
    toolUseId?: string;
    label?: string;
  };
  events: ExperienceTimelineEvent[];
}

export interface ExperienceTimelineTree {
  sessionId: string;
  main: ExperienceTimelineEvent[];
  branches: ExperienceTimelineBranch[];
}

export interface ExperienceTraceTimeline {
  id: string;
  sessionGroupKey: string;
  sessionId: string;
  eventCount: number;
  tree: ExperienceTimelineTree;
}

export interface ExperienceTraceRecordRange {
  traceId: string;
  sourceTrace: string;
  startRecordIndex: number;
  endRecordIndex: number;
  eventCount: number;
}

export interface ExperienceEvidenceChain {
  userMessageCount: number;
  runtimeContextCount: number;
  skillContextCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  toolResultCount: number;
  toolFailureResultCount: number;
  observationCount: number;
  firstUserMessage?: ExperienceEvidenceRef;
  firstRuntimeContext?: ExperienceEvidenceRef;
  firstSkillContext?: ExperienceEvidenceRef;
  firstToolUse?: ExperienceEvidenceRef;
  firstToolFailure?: ExperienceEvidenceRef;
  lastAssistantMessage?: ExperienceEvidenceRef;
}

export interface ExperienceRuleFinding {
  code: ExperienceRuleFindingCode;
  level: ExperienceRuleFindingLevel;
  count: number;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceAssistiveInference {
  mode: 'deterministic_rules_only';
  code: ExperienceAssistiveInferenceCode;
  confidence: ExperienceAssistiveInferenceConfidence;
  basisRuleCodes: ExperienceRuleFindingCode[];
  cautionCodes: ExperienceAssistiveInferenceCautionCode[];
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceReviewerReportStep {
  order: number;
  label: string;
  status: ExperienceReviewerReportStepStatus;
  text: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceReviewerReportFinding {
  id: string;
  judgmentId: string;
  source: ExperienceReviewerReportFindingSource;
  level: ExperienceReviewerReportFindingLevel;
  title: string;
  body: string;
  ruleSource: string;
  ruleVersion: string;
  evidenceRefs: ExperienceEvidenceRef[];
  reviewStateRef: {
    targetType: 'reviewer_judgment';
    targetId: string;
    verdict?: string;
    reason?: string;
    note?: string;
    reviewedAt?: string;
  };
}

export interface ExperienceSessionStoryNode {
  id: string;
  order: number;
  kind: ExperienceSessionStoryNodeKind;
  label: string;
  status: ExperienceReviewerReportStepStatus;
  text: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStoryAnswer {
  key: ExperienceSessionStoryAnswerKey;
  label: string;
  status: ExperienceReviewerReportStepStatus;
  reason: ExperienceParentReason;
  sourceItemKeys: string[];
  text: string;
  evidenceRefs: ExperienceEvidenceRef[];
  checklistItems: ExperienceChecklistItem[];
}

export interface ExperienceChecklistItem {
  key: string;
  label: string;
  status: ExperienceChecklistItemStatus;
  contribution: ExperienceChecklistContribution;
  reason: string;
  evidenceRefs: ExperienceEvidenceRef[];
  source: ExperienceReviewerReportFindingSource;
  suggestionKey?: string;
}

export interface ExperienceSessionStoryGoalSlice {
  id: string;
  order: number;
  skillNames: string[];
  startTimestamp: string;
  endTimestamp: string;
  reasonCode: ExperienceGoalSliceReasonCode;
  inferredUserGoal?: string;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStorySubagentDispatch {
  id: string;
  order: number;
  branchId: string;
  childSessionId: string;
  traceId: string;
  label: string;
  sourceTrace: string;
  attachTo?: {
    messageIndex?: number;
    callInstanceId?: string;
    toolUseId?: string;
    label?: string;
  };
  eventCount: number;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceSessionStorySkillLink {
  id: string;
  order: number;
  skillName: string;
  role: ExperienceSessionStorySkillRole;
  invocationIds: string[];
  goalSliceIds: string[];
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceGoalEvidenceRef {
  kind: 'user_message' | 'goal_slice' | 'llm_goal';
  goalSliceId?: string;
  evidenceRef?: ExperienceEvidenceRef;
  label?: string;
}

export interface ExperienceMessageRange {
  startMessageIndex: number;
  endMessageIndex: number;
  traceId?: string;
  sourceTrace?: string;
  sessionId?: string;
}

export interface ExperienceSkillSegment {
  id: string;
  order: number;
  skillName: string;
  skillType: ExperienceRuntimeSkillType;
  skillTypeSource?: ExperienceRuntimeSkillTypeSource;
  declaredSkillType?: ExperienceRuntimeSkillType;
  traceInferredSkillType?: ExperienceRuntimeSkillType;
  episodeRole: ExperienceEpisodeRole;
  skillInvocationIds: string[];
  startMessageIndex?: number;
  endMessageIndex?: number;
  messageRanges?: ExperienceMessageRange[];
  startTimestamp: string;
  endTimestamp: string;
  typeSpecificChecklist: ExperienceChecklistItem[];
  runtimeAssessment?: {
    goalSatisfaction?: string;
    declaredBehaviorFit?: string;
    artifactGoalMatch?: string;
    userFeeling?: string;
  };
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceOrchestrationEdge {
  id: string;
  episodeId: string;
  edgeKind: ExperienceOrchestrationEdgeKind;
  parentSkillSegmentId?: string;
  executorSkillSegmentId?: string;
  childSessionId?: string;
  runnerStartedRef?: ExperienceEvidenceRef;
  runnerCompletedRef?: ExperienceEvidenceRef;
  notificationRef?: ExperienceEvidenceRef;
  status: ExperienceOrchestrationEdgeStatus;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceFeedbackAttribution {
  skillName?: string;
  skillSegmentId?: string;
  attributionRole: ExperienceFeedbackAttributionRole;
  reasonCode: ExperienceFeedbackAttributionReason;
  evidenceRefs: ExperienceEvidenceRef[];
}

export interface ExperienceFeedbackSignal {
  id: string;
  order: number;
  type: ExperienceFeedbackSignalType;
  text: string;
  targetObject?: string;
  sourceWindow: 'session' | 'episode' | 'skill_invocation' | 'downstream_child';
  evidenceRef: ExperienceEvidenceRef;
  canonicalAttributions?: ExperienceFeedbackAttribution[];
  attributions: ExperienceFeedbackAttribution[];
}

export interface ExperienceEpisodeArtifact {
  kind: ExperienceEpisodeArtifactKind;
  label: string;
  pathOrUrl?: string;
  artifactGoalMatch: 'passed' | 'failed' | 'unknown';
  evidenceRef: ExperienceEvidenceRef;
}

export interface ExperienceEpisodeOutcome {
  closure: ExperienceOutcomeClosure;
  artifacts: ExperienceEpisodeArtifact[];
  verdict: ExperienceReviewPriority;
  acceptanceCriteria?: string;
}

export interface ExperienceEpisode {
  id: string;
  order: number;
  sessionId: string;
  primaryGoal?: string;
  goalEvidenceRefs: ExperienceGoalEvidenceRef[];
  startTimestamp: string;
  endTimestamp: string;
  startRef?: ExperienceEvidenceRef;
  endRef?: ExperienceEvidenceRef;
  boundaryReason: ExperienceEpisodeBoundaryReason;
  skillSegments: ExperienceSkillSegment[];
  orchestrationEdges: ExperienceOrchestrationEdge[];
  feedbackSignals: ExperienceFeedbackSignal[];
  outcome: ExperienceEpisodeOutcome;
}

export interface ExperienceSessionStoryGraphNode {
  id: string;
  label: string;
  kind: ExperienceSessionStoryNodeKind;
  status: ExperienceReviewerReportStepStatus;
  role?: ExperienceSessionStorySkillRole;
  detailNodeId?: string;
}

export interface ExperienceSessionStoryGraphEdge {
  fromId: string;
  toId: string;
  label: string;
}

export interface ExperienceSessionStory {
  schemaVersion: 1;
  contextRef?: string;
  summary: string;
  invocationCount: number;
  goalSliceCount: number;
  branchCount: number;
  progressUpdateCount: number;
  finalDeliverySignalCount: number;
  mainlineNodeIds: string[];
  goalSlices: ExperienceSessionStoryGoalSlice[];
  subagentDispatches: ExperienceSessionStorySubagentDispatch[];
  skillLinks: ExperienceSessionStorySkillLink[];
  episodes?: ExperienceEpisode[];
  graph: {
    nodes: ExperienceSessionStoryGraphNode[];
    edges: ExperienceSessionStoryGraphEdge[];
  };
  nodes: ExperienceSessionStoryNode[];
  answers: ExperienceSessionStoryAnswer[];
}

export interface ExperienceStoryContext {
  id: string;
  sessionGroupKey: string;
  goalSlices: ExperienceSessionStoryGoalSlice[];
  subagentDispatches: ExperienceSessionStorySubagentDispatch[];
  episodes: ExperienceEpisode[];
}

export interface ExperienceReviewerReport {
  schemaVersion: 1;
  mode: 'deterministic_milestone_1' | 'deterministic_session_story';
  generatedAt: string;
  title: string;
  summary: string;
  scope: {
    kind: ExperienceReviewerReportScope;
    reasonCodes: string[];
  };
  chainSteps: ExperienceReviewerReportStep[];
  findings: ExperienceReviewerReportFinding[];
  oneLookMetrics: {
    toolCallCount: number;
    toolFailureCount: number;
    toolCancelledCount?: number;
    toolUnknownCount?: number;
    userMessageCount: number;
    userFollowUpCount: number;
    assistantDeliverySignalCount: number;
    deliverableArtifactSignalCount: number;
    routerDownstreamCompleted: number;
    routerDownstreamFailed: number;
    assistantProgressUpdateCount: number;
    selfCorrectionCount: number;
    repeatedExecutionCount: number;
    finalDeliverySignalCount: number;
    traceEventCount: number;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      /** Missing on legacy reviewer reports; readers must treat that as unknown coverage. */
      observedInvocationCount?: number;
      invocationCount?: number;
      coverage?: number;
      attribution: 'skill_segment';
    };
  };
  sessionStory: ExperienceSessionStory;
  sessionStoryRef?: 'session';
  authorSuggestions: string[];
  traceLinks: ExperienceEvidenceRef[];
}

export interface ExperienceGoalSlice {
  id: string;
  skillName: string;
  sessionId: string;
  traceId?: string;
  sourceTrace: string;
  cwd?: string;
  startTimestamp: string;
  endTimestamp: string;
  timestampObserved?: boolean;
  sliceReasonCode: ExperienceGoalSliceReasonCode;
  sliceConfidence: 'low' | 'medium' | 'high';
  inferredUserGoal?: string;
  userMessageRefs: ExperienceEvidenceRef[];
}

export interface ExperienceReviewIndicators {
  userMessageCount: number;
  userFollowUpCount: number;
  userCorrectionCount: number;
  userInterruptionCount: number;
  sessionInterruptedCount: number;
  negativeFeedbackCount: number;
  positiveFeedbackCount: number;
  userGoalShiftCount: number;
  hardRuleTextHitCount: number;
  assistantDeliverySignalCount: number;
  deliverableArtifactSignalCount: number;
  routerDownstreamCompleted: number;
  routerDownstreamFailed: number;
  selfCorrectionCount: number;
  repeatedExecutionCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  toolCancelledCount?: number;
  /** Runtime did not expose a trustworthy terminal outcome. */
  toolUnknownCount?: number;
  highObservationCount: number;
  mediumObservationCount: number;
  hedgingCount: number;
  explicitMarkerCount: number;
}

export interface ExperienceInvocationMetrics {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** False means counters are placeholders because the trace exposed no valid usage event. */
  tokenUsageObserved: boolean;
  numTurns: number;
  numToolCalls: number;
  numToolFailures: number;
  numToolCancelled?: number;
  /** Unresolved or source-unknown outcomes; excluded from failure-rate denominators. */
  numToolUnknown?: number;
}

export interface ExperienceInvocation {
  id: string;
  skillName: string;
  sessionId: string;
  sessionGroupKey: string;
  traceId?: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  cwd?: string;
  segmentIndex: number;
  goalSliceId: string;
  startTimestamp: string;
  endTimestamp: string;
  timestampObserved?: boolean;
  attribution: {
    source: string;
    confidence: number;
    rawSkillRef?: string;
    pluginName?: string;
    commandName?: string;
  };
  metrics: ExperienceInvocationMetrics;
  toolCounts: Record<string, number>;
  indicators: ExperienceReviewIndicators;
  evidenceChain: ExperienceEvidenceChain;
  ruleFindings: ExperienceRuleFinding[];
  assistiveInference: ExperienceAssistiveInference;
  problemPatterns: ExperienceProblemPattern[];
  relatedObservationIds: string[];
  evidenceRefs: ExperienceEvidenceRef[];
  timelineRef?: string;
  timelineEventIds?: string[];
  timeline: ExperienceTimelineEvent[];
}

export interface ExperienceSessionSummary {
  id: string;
  skillName: string;
  /** Stable source-neutral identity for the root conversation/thread. */
  threadId: string;
  /** Runtime-native thread/run identity retained for inspection. */
  sourceThreadId: string;
  sessionId: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  entrypoint?: string;
  sourceMetadata?: TraceSourceMetadata;
  cwd?: string;
  sourceSessionStartTimestamp?: string;
  sourceSessionEndTimestamp?: string;
  sourceSessionDurationMs?: number;
  startTimestamp: string;
  endTimestamp: string;
  timestampedInvocationCount?: number;
  timestampCoverage?: number;
  invocationIds: string[];
  goalSliceIds: string[];
  reviewPriority: ExperienceReviewPriority;
  reviewPriorityScore: number;
  reviewBasisCodes: ExperienceReviewBasisCode[];
  indicators: ExperienceReviewIndicators;
  evidenceChain: ExperienceEvidenceChain;
  ruleFindings: ExperienceRuleFinding[];
  assistiveInference: ExperienceAssistiveInference;
  problemPatterns: ExperienceProblemPattern[];
  relatedObservationIds: string[];
  timelineRef?: string;
  timelinePreviewEventIds?: string[];
  /** Hydrated exact event relation derived from invocation timelineEventIds. */
  attributedEventIds: string[];
  /** All observable tasks in this thread, independent of Skill attribution. */
  turns: ExperienceTurnSummary[];
  timelinePreview: ExperienceTimelineEvent[];
  fullSessionTimeline: ExperienceTimelineEvent[];
  timelineTree?: ExperienceTimelineTree;
  timelineScope: {
    mode: 'skill_segment_window';
    segmentEventCount: number;
    previewEventCount: number;
    fullSessionEventCount: number;
    segmentRecordRanges: ExperienceTraceRecordRange[];
    previewRecordRanges: ExperienceTraceRecordRange[];
    sessionRecordRanges: ExperienceTraceRecordRange[];
    truncated: boolean;
    omittedBeforeCount: number;
    omittedAfterCount: number;
    /** @deprecated v2 only. Record indexes are local to one physical trace. */
    segmentStartRecordIndex?: number;
    /** @deprecated v2 only. Record indexes are local to one physical trace. */
    segmentEndRecordIndex?: number;
    /** @deprecated v2 only. Record indexes are local to one physical trace. */
    previewStartRecordIndex?: number;
    /** @deprecated v2 only. Record indexes are local to one physical trace. */
    previewEndRecordIndex?: number;
    /** @deprecated v2 only. Record indexes are local to one physical trace. */
    sessionStartRecordIndex?: number;
    /** @deprecated v2 only. Record indexes are local to one physical trace. */
    sessionEndRecordIndex?: number;
  };
  attributionSources: string[];
  pluginNames: string[];
  rawSkillRefs: string[];
  commandNames: string[];
  sessionStory?: ExperienceSessionStory;
  reviewerReport?: ExperienceReviewerReport;
}

export interface ExperienceSkillSummary {
  skillName: string;
  invocationCount: number;
  sessionCount: number;
  sourceKinds: ObservationSourceKind[];
  entrypoints: string[];
  entrypointCounts: Record<string, number>;
  sourceMetadataCounts: {
    channels: Record<string, number>;
    senders: Record<string, number>;
    businessActions: Record<string, number>;
    providers: Record<string, number>;
    models: Record<string, number>;
  };
  attributionCounts: Record<string, number>;
  pluginNames: string[];
  rawSkillRefs: string[];
  commandNames: string[];
  toolCounts: Record<string, number>;
  firstSeen: string;
  lastSeen: string;
  timestampedInvocationCount?: number;
  timestampCoverage?: number;
  reviewFirstSessionCount: number;
  sampleReviewSessionCount: number;
  indicators: ExperienceReviewIndicators;
  evidenceChain: ExperienceEvidenceChain;
  ruleFindings: ExperienceRuleFinding[];
  assistiveInference: ExperienceAssistiveInference;
  problemPatterns: ExperienceProblemPattern[];
  relatedObservationIds: string[];
}

export interface ObservationExperienceReport {
  kind: 'observe-experience';
  schemaVersion: 3;
  scope: 'evidence-only';
  generatedAt: string;
  meta: {
    sessionCount: number;
    skillCount: number;
    invocationCount: number;
    goalSliceCount: number;
    noteCodes: Array<'no_llm_judge' | 'no_auto_verdict' | 'default_goal_slice_is_allowed' | 'deterministic_assistive_inference'>;
  };
  goalSlices: ExperienceGoalSlice[];
  traceTimelines: ExperienceTraceTimeline[];
  storyContexts: ExperienceStoryContext[];
  invocations: ExperienceInvocation[];
  sessions: ExperienceSessionSummary[];
  skills: ExperienceSkillSummary[];
}

// ---------- skill-chain ----------

export type ObservationRuntimeCheckStatus = 'passed' | 'attention' | 'manual_review';

export interface ObservationRuntimeCheck {
  nodeKind: 'hardRule' | 'workflowNode';
  id: string;
  title: string;
  expectation: string;
  status: ObservationRuntimeCheckStatus;
  reason: string;
  evidenceCount: number;
  evidenceSnippets: string[];
}

export type SkillRuntimeEvidencePackSourceType =
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message'
  | 'user_feedback'
  | 'artifact'
  | 'runtime_context'
  | 'skill_context'
  | 'unknown';

export interface SkillRuntimeEvidencePackRef extends Pick<ExperienceEvidenceRef,
  'id' | 'kind' | 'sourceTrace' | 'sessionId' | 'messageUuid' | 'messageIndex' | 'logicalMessageIndex' | 'sourceLineIndex' | 'callInstanceId' | 'toolUseId' | 'timestamp' | 'role' | 'label' | 'snippet'
> {
  sourceType: SkillRuntimeEvidencePackSourceType;
  toolName?: string;
  isError?: boolean;
}

export interface SkillRuntimeEvidencePackNode {
  nodeId: string;
  nodeKind: 'workflowNode' | 'hardRule';
  title: string;
  expectation: string;
  deterministicStatus: ObservationRuntimeCheckStatus;
  deterministicReason: string;
  candidateEvidenceRefs: SkillRuntimeEvidencePackRef[];
  candidateEvidenceSnippets: string[];
}

export interface SkillRuntimeEvidencePack {
  schemaVersion: 1;
  skillName: string;
  generatedBy: 'deterministic_rule_pack';
  definition: {
    found: boolean;
    path?: string;
    truncated?: boolean;
  };
  declaredStandards: {
    hardRules: Array<{ id: string; title: string; expectation: string; source: 'frontmatter' }>;
    workflowNodes: Array<{ id: string; title: string; expectation: string; workflowId: string; source: 'frontmatter' | 'markdown_headings' }>;
  };
  runtimeEvidence: {
    toolCalls: SkillRuntimeEvidencePackRef[];
    assistantMessages: SkillRuntimeEvidencePackRef[];
    userFeedback: SkillRuntimeEvidencePackRef[];
    artifacts: SkillRuntimeEvidencePackRef[];
  };
  nodeEvidence: SkillRuntimeEvidencePackNode[];
  evidenceQuality: {
    pollutedSourceCount: number;
    windowTooNarrow: boolean;
    missingRuntimeEvidence: boolean;
    notes: string[];
  };
}

export interface ObservationSkillChain {
  skillName: string;
  definition: {
    found: boolean;
    path?: string;
    content?: string;
    truncated?: boolean;
  };
  healthCheck: {
    source: 'doctor-static-rules';
    hardRules: {
      declared: boolean;
      valid: boolean;
      count: number;
      rules: SkillHardRule[];
      errors: string[];
      advisoryCode?: SkillChainAdvisoryCode;
    };
    workflows: {
      declared: boolean;
      valid: boolean;
      branchCount: number;
      nodeCount: number;
      workflows: SkillWorkflow[];
      errors: string[];
      source: 'frontmatter' | 'markdown_headings' | 'none';
      advisoryCode?: SkillChainAdvisoryCode;
    };
  };
  runtime: {
    supported: true;
    mode: 'deterministic-no-llm';
    message: string;
    summary: {
      invocationCount: number;
      toolCallCount: number;
      toolFailureCount: number;
      passedCount: number;
      attentionCount: number;
      manualReviewCount: number;
    };
    hardRules: ObservationRuntimeCheck[];
    workflowNodes: ObservationRuntimeCheck[];
    evidencePack?: SkillRuntimeEvidencePack;
  };
}
