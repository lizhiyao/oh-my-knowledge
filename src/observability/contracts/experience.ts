import type { ExperienceEvidenceRefSchema } from './experience-evidence-schema.js';
import type { z } from 'zod';
import type {
  ExperienceReviewPrioritySchema,
  ExperienceGoalSliceReasonCodeSchema,
  ExperienceEvidenceKindSchema,
  ExperienceAssistiveInferenceCodeSchema,
  ExperienceAssistiveInferenceConfidenceSchema,
  ExperienceAssistiveInferenceCautionCodeSchema,
  ExperienceReviewBasisCodeSchema,
  ExperienceRuleFindingLevelSchema,
  ExperienceReviewerReportScopeSchema,
  ExperienceReviewerReportStepStatusSchema,
  ExperienceReviewerReportFindingLevelSchema,
  ExperienceReviewerReportFindingSourceSchema,
  ExperienceChecklistItemStatusSchema,
  ExperienceChecklistContributionSchema,
  ExperienceParentReasonSchema,
  ExperienceSessionStoryNodeKindSchema,
  ExperienceSessionStoryAnswerKeySchema,
  ExperienceSessionStorySkillRoleSchema,
  ExperienceEpisodeBoundaryReasonSchema,
  ExperienceEpisodeRoleSchema,
  ExperienceFeedbackSignalTypeSchema,
  ExperienceFeedbackAttributionRoleSchema,
  ExperienceFeedbackAttributionReasonSchema,
  ExperienceOutcomeClosureSchema,
  ExperienceRuntimeSkillTypeSchema,
  ExperienceRuntimeSkillTypeSourceSchema,
  ExperienceEpisodeArtifactKindSchema,
  ExperienceOrchestrationEdgeStatusSchema,
  ExperienceOrchestrationEdgeKindSchema,
  ExperienceRuleFindingCodeSchema,
  TaskWindowBasisSchema,
  ExperienceTurnStatusSchema,
} from './experience-enums.js';
import type { ToolCallStatus } from '../../executors/contracts/trace.js';
import type { ExperienceProblemPattern } from './problem-patterns.js';
import type { TraceSourceKind, TraceSourceMetadata } from './trace.js';

export type ExperienceReviewPriority = z.infer<typeof ExperienceReviewPrioritySchema>;
export type ExperienceGoalSliceReasonCode = z.infer<typeof ExperienceGoalSliceReasonCodeSchema>;
export type ExperienceEvidenceKind = z.infer<typeof ExperienceEvidenceKindSchema>;
export type ExperienceAssistiveInferenceCode =
  z.infer<typeof ExperienceAssistiveInferenceCodeSchema>;
export type ExperienceAssistiveInferenceConfidence = z.infer<typeof ExperienceAssistiveInferenceConfidenceSchema>;
export type ExperienceAssistiveInferenceCautionCode =
  z.infer<typeof ExperienceAssistiveInferenceCautionCodeSchema>;
export type ExperienceReviewBasisCode =
  z.infer<typeof ExperienceReviewBasisCodeSchema>;
export type ExperienceRuleFindingLevel = z.infer<typeof ExperienceRuleFindingLevelSchema>;
export type ExperienceReviewerReportScope = z.infer<typeof ExperienceReviewerReportScopeSchema>;
export type ExperienceReviewerReportStepStatus = z.infer<typeof ExperienceReviewerReportStepStatusSchema>;
export type ExperienceReviewerReportFindingLevel = z.infer<typeof ExperienceReviewerReportFindingLevelSchema>;
export type ExperienceReviewerReportFindingSource = z.infer<typeof ExperienceReviewerReportFindingSourceSchema>;
export type ExperienceChecklistItemStatus = z.infer<typeof ExperienceChecklistItemStatusSchema>;
export type ExperienceChecklistContribution = z.infer<typeof ExperienceChecklistContributionSchema>;
export type ExperienceParentReason =
  z.infer<typeof ExperienceParentReasonSchema>;
export type ExperienceSessionStoryNodeKind =
  z.infer<typeof ExperienceSessionStoryNodeKindSchema>;
export type ExperienceSessionStoryAnswerKey = z.infer<typeof ExperienceSessionStoryAnswerKeySchema>;
export type ExperienceSessionStorySkillRole = z.infer<typeof ExperienceSessionStorySkillRoleSchema>;
export type ExperienceEpisodeBoundaryReason = z.infer<typeof ExperienceEpisodeBoundaryReasonSchema>;
export type ExperienceEpisodeRole = z.infer<typeof ExperienceEpisodeRoleSchema>;
export type ExperienceFeedbackSignalType = z.infer<typeof ExperienceFeedbackSignalTypeSchema>;
export type ExperienceFeedbackAttributionRole = z.infer<typeof ExperienceFeedbackAttributionRoleSchema>;
export type ExperienceFeedbackAttributionReason = z.infer<typeof ExperienceFeedbackAttributionReasonSchema>;
export type ExperienceOutcomeClosure = z.infer<typeof ExperienceOutcomeClosureSchema>;
export type ExperienceRuntimeSkillType = z.infer<typeof ExperienceRuntimeSkillTypeSchema>;
export type ExperienceRuntimeSkillTypeSource = z.infer<typeof ExperienceRuntimeSkillTypeSourceSchema>;
export type ExperienceEpisodeArtifactKind = z.infer<typeof ExperienceEpisodeArtifactKindSchema>;
export type ExperienceOrchestrationEdgeStatus = z.infer<typeof ExperienceOrchestrationEdgeStatusSchema>;
export type ExperienceOrchestrationEdgeKind = z.infer<typeof ExperienceOrchestrationEdgeKindSchema>;
export type ExperienceRuleFindingCode =
  z.infer<typeof ExperienceRuleFindingCodeSchema>;

// ---------- experience: interfaces ----------

export type ExperienceEvidenceRef = z.infer<typeof ExperienceEvidenceRefSchema>;

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
  z.infer<typeof TaskWindowBasisSchema>;

export type ExperienceTurnStatus =
  z.infer<typeof ExperienceTurnStatusSchema>;

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
  sourceKind: TraceSourceKind;
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
  sourceKind: TraceSourceKind;
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
  sourceKinds: TraceSourceKind[];
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
