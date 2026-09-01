import type { ToolCallStatus } from '../../executors/contracts/trace.js';
import type { ExperienceProblemPattern } from './problem-patterns.js';
import type { ObservationSourceKind, TraceSourceMetadata } from './trace.js';

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
