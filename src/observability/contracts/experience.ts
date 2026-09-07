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

export type ExperienceTimelineEvent = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceTimelineEventSchema
>;

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
export type ExperienceTurnSummary = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceTurnSummarySchema
>;

export type ExperienceTimelineBranch = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceTimelineBranchSchema
>;

export type ExperienceTimelineTree = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceTimelineTreeSchema
>;

export type ExperienceTraceTimeline = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceTraceTimelineSchema
>;

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

export type ExperienceGoalSlice = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceGoalSliceSchema
>;

export type ExperienceReviewIndicators = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceReviewIndicatorsSchema
>;

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
  attribution: z.infer<typeof import('./experience-evidence-schema.js').ExperienceAttributionSchema>;
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
  timelineScope: z.infer<typeof import('./experience-evidence-schema.js').ExperienceTimelineScopeSchema>;
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
  meta: z.infer<typeof import('./experience-evidence-schema.js').ExperienceMetaSchema>;
  goalSlices: ExperienceGoalSlice[];
  traceTimelines: ExperienceTraceTimeline[];
  storyContexts: ExperienceStoryContext[];
  invocations: ExperienceInvocation[];
  sessions: ExperienceSessionSummary[];
  skills: ExperienceSkillSummary[];
}
