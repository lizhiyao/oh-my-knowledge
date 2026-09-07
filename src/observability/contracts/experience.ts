import type {
  ExperienceEvidenceChainSchema,
  ExperienceRuleFindingSchema,
  ExperienceAssistiveInferenceSchema,
  ExperienceChecklistItemSchema,
} from './experience-evidence-schema.js';
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

export type ExperienceTraceRecordRange = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceTraceRecordRangeSchema
>;

export type ExperienceEvidenceChain = z.infer<typeof ExperienceEvidenceChainSchema>;

export type ExperienceRuleFinding = z.infer<typeof ExperienceRuleFindingSchema>;

export type ExperienceAssistiveInference = z.infer<typeof ExperienceAssistiveInferenceSchema>;

export type ExperienceReviewerReportStep = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceReviewerReportStepSchema
>;

export type ExperienceReviewerReportFinding = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceReviewerReportFindingSchema
>;

export type ExperienceSessionStoryNode = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStoryNodeSchema
>;

export type ExperienceSessionStoryAnswer = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStoryAnswerSchema
>;

export type ExperienceChecklistItem = z.infer<typeof ExperienceChecklistItemSchema>;

export type ExperienceSessionStoryGoalSlice = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStoryGoalSliceSchema
>;

export type ExperienceSessionStorySubagentDispatch = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStorySubagentDispatchSchema
>;

export type ExperienceSessionStorySkillLink = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStorySkillLinkSchema
>;

export type ExperienceGoalEvidenceRef = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceGoalEvidenceRefSchema
>;

export type ExperienceMessageRange = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceMessageRangeSchema
>;

export type ExperienceSkillSegment = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSkillSegmentSchema
>;

export type ExperienceOrchestrationEdge = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceOrchestrationEdgeSchema
>;

export type ExperienceFeedbackAttribution = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceFeedbackAttributionSchema
>;

export type ExperienceFeedbackSignal = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceFeedbackSignalSchema
>;

export type ExperienceEpisodeArtifact = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceEpisodeArtifactSchema
>;

export type ExperienceEpisodeOutcome = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceEpisodeOutcomeSchema
>;

export type ExperienceEpisode = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceEpisodeSchema
>;

export type ExperienceSessionStoryGraphNode = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStoryGraphNodeSchema
>;

export type ExperienceSessionStoryGraphEdge = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStoryGraphEdgeSchema
>;

export type ExperienceSessionStory = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionStorySchema
>;

export type ExperienceStoryContext = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceStoryContextSchema
>;

export type ExperienceReviewerReport = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceReviewerReportSchema
>;

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

export type ExperienceInvocationMetrics = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceInvocationMetricsSchema
>;

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
