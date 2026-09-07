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

export type ExperienceInvocation = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceInvocationSchema
>;

export type ExperienceSessionSummary = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSessionSummarySchema
>;

export type ExperienceSkillSummary = z.infer<
  typeof import('./experience-evidence-schema.js').ExperienceSkillSummarySchema
>;

export type ObservationExperienceReport = z.infer<
  typeof import('./experience-evidence-schema.js').ObservationExperienceReportSchema
>;
