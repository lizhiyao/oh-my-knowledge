import { TraceSourceKindSchema } from '../../executors/contracts/trace-source-schema.js';
import { TraceSourceMetadataSchema } from './trace-metadata-schema.js';
import { z } from 'zod';
import {
  ExperienceAssistiveInferenceCautionCodeSchema,
  ExperienceAssistiveInferenceCodeSchema,
  ExperienceAssistiveInferenceConfidenceSchema,
  ExperienceChecklistContributionSchema,
  ExperienceChecklistItemStatusSchema,
  ExperienceEpisodeArtifactKindSchema,
  ExperienceEpisodeBoundaryReasonSchema,
  ExperienceEpisodeRoleSchema,
  ExperienceEvidenceKindSchema,
  ExperienceFeedbackAttributionReasonSchema,
  ExperienceFeedbackAttributionRoleSchema,
  ExperienceFeedbackSignalTypeSchema,
  ExperienceGoalSliceReasonCodeSchema,
  ExperienceOrchestrationEdgeKindSchema,
  ExperienceOrchestrationEdgeStatusSchema,
  ExperienceOutcomeClosureSchema,
  ExperienceParentReasonSchema,
  ExperienceReviewBasisCodeSchema,
  ExperienceReviewPrioritySchema,
  ExperienceReviewerReportFindingLevelSchema,
  ExperienceReviewerReportFindingSourceSchema,
  ExperienceReviewerReportScopeSchema,
  ExperienceReviewerReportStepStatusSchema,
  ExperienceRuleFindingCodeSchema,
  ExperienceRuleFindingLevelSchema,
  ExperienceRuntimeSkillTypeSchema,
  ExperienceRuntimeSkillTypeSourceSchema,
  ExperienceSessionStoryAnswerKeySchema,
  ExperienceSessionStoryNodeKindSchema,
  ExperienceSessionStorySkillRoleSchema,
  ExperienceTurnStatusSchema,
  TaskWindowBasisSchema,
} from './experience-enums.js';

const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ExperienceTraceRecordRangeSchema = z.object({
  traceId: z.string(),
  sourceTrace: z.string(),
  startRecordIndex: NonNegativeIntegerSchema,
  endRecordIndex: NonNegativeIntegerSchema,
  eventCount: NonNegativeIntegerSchema,
});

export const ExperienceEvidenceRefSchema = z.object({
  id: z.string(),
  kind: ExperienceEvidenceKindSchema,
  sourceTrace: z.string(),
  sessionId: z.string(),
  messageIndex: NonNegativeIntegerSchema.optional(),
  logicalMessageIndex: NonNegativeIntegerSchema.optional(),
  sourceLineIndex: NonNegativeIntegerSchema.optional(),
  traceRole: z.enum(['standalone', 'main', 'subagent']).optional(),
  modelActivityKind: z.enum(['reasoning']).optional(),
  contentVisibility: z.enum(['plaintext', 'opaque']).optional(),
  contentSource: z.enum(['summary', 'content', 'text']).optional(),
  runtimeKind: z.enum(['session_context', 'execution_context', 'settings', 'goal', 'context_compaction', 'usage']).optional(),
  role: z.enum(['user', 'assistant', 'tool', 'other']).optional(),
  traceLabel: z.string().optional(),
  traceId: z.string().optional(),
  turnId: z.string().optional(),
  messageUuid: z.string().optional(),
  sourceType: z.string().optional(),
  callInstanceId: z.string().optional(),
  toolUseId: z.string().optional(),
  label: z.string().optional(),
  snippet: z.string().optional(),
  timestamp: z.string().optional(),
});

export const ExperienceEvidenceChainSchema = z.object({
  userMessageCount: NonNegativeIntegerSchema,
  runtimeContextCount: NonNegativeIntegerSchema,
  skillContextCount: NonNegativeIntegerSchema,
  assistantMessageCount: NonNegativeIntegerSchema,
  toolUseCount: NonNegativeIntegerSchema,
  toolResultCount: NonNegativeIntegerSchema,
  toolFailureResultCount: NonNegativeIntegerSchema,
  observationCount: NonNegativeIntegerSchema,
  firstUserMessage: ExperienceEvidenceRefSchema.optional(),
  firstRuntimeContext: ExperienceEvidenceRefSchema.optional(),
  firstSkillContext: ExperienceEvidenceRefSchema.optional(),
  firstToolUse: ExperienceEvidenceRefSchema.optional(),
  firstToolFailure: ExperienceEvidenceRefSchema.optional(),
  lastAssistantMessage: ExperienceEvidenceRefSchema.optional(),
});

export const ExperienceRuleFindingSchema = z.object({
  code: ExperienceRuleFindingCodeSchema,
  level: ExperienceRuleFindingLevelSchema,
  count: NonNegativeIntegerSchema,
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceAssistiveInferenceSchema = z.object({
  mode: z.literal('deterministic_rules_only'),
  code: ExperienceAssistiveInferenceCodeSchema,
  confidence: ExperienceAssistiveInferenceConfidenceSchema,
  basisRuleCodes: z.array(ExperienceRuleFindingCodeSchema),
  cautionCodes: z.array(ExperienceAssistiveInferenceCautionCodeSchema),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceChecklistItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  status: ExperienceChecklistItemStatusSchema,
  contribution: ExperienceChecklistContributionSchema,
  reason: z.string(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
  source: ExperienceReviewerReportFindingSourceSchema,
  suggestionKey: z.string().optional(),
});

export const ExperienceInvocationMetricsSchema = z.object({
  durationMs: NonNegativeIntegerSchema,
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheReadTokens: NonNegativeIntegerSchema,
  cacheCreationTokens: NonNegativeIntegerSchema,
  /** False means counters are placeholders because the trace exposed no valid usage event. */
  tokenUsageObserved: z.boolean(),
  numTurns: NonNegativeIntegerSchema,
  numToolCalls: NonNegativeIntegerSchema,
  numToolFailures: NonNegativeIntegerSchema,
  numToolCancelled: NonNegativeIntegerSchema.optional(),
  /** Unresolved or source-unknown outcomes; excluded from failure-rate denominators. */
  numToolUnknown: NonNegativeIntegerSchema.optional(),
});

// Persisted metrics require outcome counters even when hydrated callers may omit them.
export const ExperienceInvocationMetricsWireSchema = ExperienceInvocationMetricsSchema.required();

export const ExperienceSessionStoryGoalSliceSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  skillNames: z.array(z.string()),
  startTimestamp: z.string(),
  endTimestamp: z.string(),
  reasonCode: ExperienceGoalSliceReasonCodeSchema,
  inferredUserGoal: z.string().optional(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceSessionStorySubagentDispatchSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  branchId: z.string(),
  childSessionId: z.string(),
  traceId: z.string(),
  label: z.string(),
  sourceTrace: z.string(),
  attachTo: z.object({
  messageIndex: NonNegativeIntegerSchema.optional(),
  callInstanceId: z.string().optional(),
  toolUseId: z.string().optional(),
  label: z.string().optional(),
}).optional(),
  eventCount: NonNegativeIntegerSchema,
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceSessionStorySkillLinkSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  skillName: z.string(),
  role: ExperienceSessionStorySkillRoleSchema,
  invocationIds: z.array(z.string()),
  goalSliceIds: z.array(z.string()),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceSessionStoryGraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: ExperienceSessionStoryNodeKindSchema,
  status: ExperienceReviewerReportStepStatusSchema,
  role: ExperienceSessionStorySkillRoleSchema.optional(),
  detailNodeId: z.string().optional(),
});

export const ExperienceSessionStoryGraphEdgeSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  label: z.string(),
});

export const ExperienceSessionStoryNodeSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  kind: ExperienceSessionStoryNodeKindSchema,
  label: z.string(),
  status: ExperienceReviewerReportStepStatusSchema,
  text: z.string(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceSessionStoryAnswerSchema = z.object({
  key: ExperienceSessionStoryAnswerKeySchema,
  label: z.string(),
  status: ExperienceReviewerReportStepStatusSchema,
  reason: ExperienceParentReasonSchema,
  sourceItemKeys: z.array(z.string()),
  text: z.string(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
  checklistItems: z.array(ExperienceChecklistItemSchema),
});

const ExperienceGoalEvidenceKindSchema = z.enum(['user_message', 'goal_slice', 'llm_goal']);

export const ExperienceMessageRangeSchema = z.object({
  startMessageIndex: NonNegativeIntegerSchema,
  endMessageIndex: NonNegativeIntegerSchema,
  traceId: z.string().optional(),
  sourceTrace: z.string().optional(),
  sessionId: z.string().optional(),
});

export const ExperienceGoalEvidenceRefSchema = z.object({
  kind: ExperienceGoalEvidenceKindSchema,
  goalSliceId: z.string().optional(),
  evidenceRef: ExperienceEvidenceRefSchema.optional(),
  label: z.string().optional(),
});

export const ExperienceSkillSegmentSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  skillName: z.string(),
  skillType: ExperienceRuntimeSkillTypeSchema,
  skillTypeSource: ExperienceRuntimeSkillTypeSourceSchema.optional(),
  declaredSkillType: ExperienceRuntimeSkillTypeSchema.optional(),
  traceInferredSkillType: ExperienceRuntimeSkillTypeSchema.optional(),
  episodeRole: ExperienceEpisodeRoleSchema,
  skillInvocationIds: z.array(z.string()),
  startMessageIndex: NonNegativeIntegerSchema.optional(),
  endMessageIndex: NonNegativeIntegerSchema.optional(),
  messageRanges: z.array(ExperienceMessageRangeSchema).optional(),
  startTimestamp: z.string(),
  endTimestamp: z.string(),
  typeSpecificChecklist: z.array(ExperienceChecklistItemSchema),
  runtimeAssessment: z.object({
    goalSatisfaction: z.string().optional(),
    declaredBehaviorFit: z.string().optional(),
    artifactGoalMatch: z.string().optional(),
    userFeeling: z.string().optional(),
  }).optional(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceOrchestrationEdgeSchema = z.object({
  id: z.string(),
  episodeId: z.string(),
  edgeKind: ExperienceOrchestrationEdgeKindSchema,
  parentSkillSegmentId: z.string().optional(),
  executorSkillSegmentId: z.string().optional(),
  childSessionId: z.string().optional(),
  runnerStartedRef: ExperienceEvidenceRefSchema.optional(),
  runnerCompletedRef: ExperienceEvidenceRefSchema.optional(),
  notificationRef: ExperienceEvidenceRefSchema.optional(),
  status: ExperienceOrchestrationEdgeStatusSchema,
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceFeedbackAttributionSchema = z.object({
  skillName: z.string().optional(),
  skillSegmentId: z.string().optional(),
  attributionRole: ExperienceFeedbackAttributionRoleSchema,
  reasonCode: ExperienceFeedbackAttributionReasonSchema,
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceFeedbackSignalSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  type: ExperienceFeedbackSignalTypeSchema,
  text: z.string(),
  targetObject: z.string().optional(),
  sourceWindow: z.enum(['session', 'episode', 'skill_invocation', 'downstream_child']),
  evidenceRef: ExperienceEvidenceRefSchema,
  canonicalAttributions: z.array(ExperienceFeedbackAttributionSchema).optional(),
  attributions: z.array(ExperienceFeedbackAttributionSchema),
});

export const ExperienceEpisodeArtifactSchema = z.object({
  kind: ExperienceEpisodeArtifactKindSchema,
  label: z.string(),
  pathOrUrl: z.string().optional(),
  artifactGoalMatch: z.enum(['passed', 'failed', 'unknown']),
  evidenceRef: ExperienceEvidenceRefSchema,
});

export const ExperienceEpisodeOutcomeSchema = z.object({
  closure: ExperienceOutcomeClosureSchema,
  artifacts: z.array(ExperienceEpisodeArtifactSchema),
  verdict: ExperienceReviewPrioritySchema,
  acceptanceCriteria: z.string().optional(),
});

export const ExperienceEpisodeSchema = z.object({
  id: z.string(),
  order: NonNegativeIntegerSchema,
  sessionId: z.string(),
  primaryGoal: z.string().optional(),
  goalEvidenceRefs: z.array(ExperienceGoalEvidenceRefSchema),
  startTimestamp: z.string(),
  endTimestamp: z.string(),
  startRef: ExperienceEvidenceRefSchema.optional(),
  endRef: ExperienceEvidenceRefSchema.optional(),
  boundaryReason: ExperienceEpisodeBoundaryReasonSchema,
  skillSegments: z.array(ExperienceSkillSegmentSchema),
  orchestrationEdges: z.array(ExperienceOrchestrationEdgeSchema),
  feedbackSignals: z.array(ExperienceFeedbackSignalSchema),
  outcome: ExperienceEpisodeOutcomeSchema,
});

export const ExperienceStoryContextSchema = z.object({
  id: z.string(),
  sessionGroupKey: z.string(),
  goalSlices: z.array(ExperienceSessionStoryGoalSliceSchema),
  subagentDispatches: z.array(ExperienceSessionStorySubagentDispatchSchema),
  episodes: z.array(ExperienceEpisodeSchema),
});

export const ExperienceReviewerReportStepSchema = z.object({
  order: NonNegativeIntegerSchema,
  label: z.string(),
  status: ExperienceReviewerReportStepStatusSchema,
  text: z.string(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceReviewerReportFindingSchema = z.object({
  id: z.string(),
  judgmentId: z.string(),
  source: ExperienceReviewerReportFindingSourceSchema,
  level: ExperienceReviewerReportFindingLevelSchema,
  title: z.string(),
  body: z.string(),
  ruleSource: z.string(),
  ruleVersion: z.string(),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
  reviewStateRef: z.object({
    targetType: z.literal('reviewer_judgment'),
    targetId: z.string(),
    verdict: z.string().optional(),
    reason: z.string().optional(),
    note: z.string().optional(),
    reviewedAt: z.string().optional(),
  }),
});

// Hydrated legacy reports may lack coverage; wire metrics require all coverage fields.

const ExperienceReviewerTokenUsageSchema = z.object({
  inputTokens: NonNegativeIntegerSchema,
  outputTokens: NonNegativeIntegerSchema,
  cacheReadTokens: NonNegativeIntegerSchema,
  cacheCreationTokens: NonNegativeIntegerSchema,
  observedInvocationCount: NonNegativeIntegerSchema.optional(),
  invocationCount: NonNegativeIntegerSchema.optional(),
  coverage: z.number().optional(),
  attribution: z.literal('skill_segment'),
});

export const ExperienceReviewerMetricsSchema = z.object({
  toolCallCount: NonNegativeIntegerSchema,
  toolFailureCount: NonNegativeIntegerSchema,
  toolCancelledCount: NonNegativeIntegerSchema.optional(),
  toolUnknownCount: NonNegativeIntegerSchema.optional(),
  userMessageCount: NonNegativeIntegerSchema,
  userFollowUpCount: NonNegativeIntegerSchema,
  assistantDeliverySignalCount: NonNegativeIntegerSchema,
  deliverableArtifactSignalCount: NonNegativeIntegerSchema,
  routerDownstreamCompleted: NonNegativeIntegerSchema,
  routerDownstreamFailed: NonNegativeIntegerSchema,
  assistantProgressUpdateCount: NonNegativeIntegerSchema,
  selfCorrectionCount: NonNegativeIntegerSchema,
  repeatedExecutionCount: NonNegativeIntegerSchema,
  finalDeliverySignalCount: NonNegativeIntegerSchema,
  traceEventCount: NonNegativeIntegerSchema,
  tokenUsage: ExperienceReviewerTokenUsageSchema,
});

export const ExperienceReviewerMetricsWireSchema = ExperienceReviewerMetricsSchema.required().extend({
  tokenUsage: ExperienceReviewerTokenUsageSchema.required(),
});

const ExperienceSessionStoryBaseSchema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string(),
  invocationCount: NonNegativeIntegerSchema,
  goalSliceCount: NonNegativeIntegerSchema,
  branchCount: NonNegativeIntegerSchema,
  progressUpdateCount: NonNegativeIntegerSchema,
  finalDeliverySignalCount: NonNegativeIntegerSchema,
  mainlineNodeIds: z.array(z.string()),
  skillLinks: z.array(ExperienceSessionStorySkillLinkSchema),
  graph: z.object({
    nodes: z.array(ExperienceSessionStoryGraphNodeSchema),
    edges: z.array(ExperienceSessionStoryGraphEdgeSchema),
  }),
  nodes: z.array(ExperienceSessionStoryNodeSchema),
  answers: z.array(ExperienceSessionStoryAnswerSchema),
});

export const ExperienceSessionStorySchema = ExperienceSessionStoryBaseSchema.extend({
  contextRef: z.string().optional(),
  goalSlices: z.array(ExperienceSessionStoryGoalSliceSchema),
  subagentDispatches: z.array(ExperienceSessionStorySubagentDispatchSchema),
  episodes: z.array(ExperienceEpisodeSchema).optional(),
});

export const ExperienceSessionStoryWireSchema = ExperienceSessionStoryBaseSchema.extend({
  contextRef: z.string(),
});

const ExperienceReviewerReportBaseSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['deterministic_milestone_1', 'deterministic_session_story']),
  generatedAt: z.string(),
  title: z.string(),
  summary: z.string(),
  scope: z.object({
    kind: ExperienceReviewerReportScopeSchema,
    reasonCodes: z.array(z.string()),
  }),
  chainSteps: z.array(ExperienceReviewerReportStepSchema),
  findings: z.array(ExperienceReviewerReportFindingSchema),
  oneLookMetrics: ExperienceReviewerMetricsSchema,
  authorSuggestions: z.array(z.string()),
  traceLinks: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceReviewerReportSchema = ExperienceReviewerReportBaseSchema.extend({
  sessionStory: ExperienceSessionStorySchema,
  sessionStoryRef: z.literal('session').optional(),
});

export const ExperienceReviewerReportWireSchema = ExperienceReviewerReportBaseSchema.extend({
  oneLookMetrics: ExperienceReviewerMetricsWireSchema,
  sessionStoryRef: z.literal('session'),
});

export const ExperienceTimelineAttachmentSchema = z.object({
  attachmentKind: z.enum(['image', 'file']),
  name: z.string(),
});

export const ExperienceTimelineEventSchema = ExperienceEvidenceRefSchema.extend({
  order: NonNegativeIntegerSchema,
  model: z.string().optional(),
  toolName: z.string().optional(),
  toolStatus: z.enum(['success', 'failure', 'cancelled', 'unknown']).optional(),
  isError: z.boolean().optional(),
  fullText: z.string().optional(),
  attachments: z.array(ExperienceTimelineAttachmentSchema).optional(),
});

export const ExperienceTimelineBranchSchema = z.object({
  id: z.string(),
  label: z.string(),
  sessionId: z.string(),
  traceId: z.string().optional(),
  sourceTrace: z.string(),
  traceRole: z.enum(['main', 'subagent', 'standalone']),
  attachTo: z.object({
    traceId: z.string().optional(),
    sourceTrace: z.string(),
    messageIndex: NonNegativeIntegerSchema.optional(),
    callInstanceId: z.string().optional(),
    toolUseId: z.string().optional(),
    label: z.string().optional(),
  }).optional(),
  events: z.array(ExperienceTimelineEventSchema),
});

export const ExperienceTimelineTreeSchema = z.object({
  sessionId: z.string(),
  main: z.array(ExperienceTimelineEventSchema),
  branches: z.array(ExperienceTimelineBranchSchema),
});

export const ExperienceTraceTimelineSchema = z.object({
  id: z.string(),
  sessionGroupKey: z.string(),
  sessionId: z.string(),
  eventCount: NonNegativeIntegerSchema,
  tree: ExperienceTimelineTreeSchema,
});

export const ExperienceTurnSummarySchema = z.object({
  turnId: z.string(),
  sourceTurnId: z.string().optional(),
  boundaryBasis: TaskWindowBasisSchema.exclude(['unresolved']),
  traceId: z.string().optional(),
  sourceTrace: z.string(),
  startTimestamp: z.string().optional(),
  endTimestamp: z.string().optional(),
  status: ExperienceTurnStatusSchema,
  title: z.string(),
  eventIds: z.array(z.string()),
  userMessageCount: NonNegativeIntegerSchema,
  assistantMessageCount: NonNegativeIntegerSchema,
  toolCallCount: NonNegativeIntegerSchema,
  toolFailureCount: NonNegativeIntegerSchema,
});

export const ExperienceGoalSliceSchema = z.object({
  id: z.string(),
  skillName: z.string(),
  sessionId: z.string(),
  traceId: z.string().optional(),
  sourceTrace: z.string(),
  cwd: z.string().optional(),
  startTimestamp: z.string(),
  endTimestamp: z.string(),
  timestampObserved: z.boolean().optional(),
  sliceReasonCode: ExperienceGoalSliceReasonCodeSchema,
  sliceConfidence: z.enum(['low', 'medium', 'high']),
  inferredUserGoal: z.string().optional(),
  userMessageRefs: z.array(ExperienceEvidenceRefSchema),
});

export const ExperienceReviewIndicatorsSchema = z.object({
  userMessageCount: NonNegativeIntegerSchema,
  userFollowUpCount: NonNegativeIntegerSchema,
  userCorrectionCount: NonNegativeIntegerSchema,
  userInterruptionCount: NonNegativeIntegerSchema,
  sessionInterruptedCount: NonNegativeIntegerSchema,
  negativeFeedbackCount: NonNegativeIntegerSchema,
  positiveFeedbackCount: NonNegativeIntegerSchema,
  userGoalShiftCount: NonNegativeIntegerSchema,
  hardRuleTextHitCount: NonNegativeIntegerSchema,
  assistantDeliverySignalCount: NonNegativeIntegerSchema,
  deliverableArtifactSignalCount: NonNegativeIntegerSchema,
  routerDownstreamCompleted: NonNegativeIntegerSchema,
  routerDownstreamFailed: NonNegativeIntegerSchema,
  selfCorrectionCount: NonNegativeIntegerSchema,
  repeatedExecutionCount: NonNegativeIntegerSchema,
  toolCallCount: NonNegativeIntegerSchema,
  toolFailureCount: NonNegativeIntegerSchema,
  toolCancelledCount: NonNegativeIntegerSchema.optional(),
  toolUnknownCount: NonNegativeIntegerSchema.optional(),
  highObservationCount: NonNegativeIntegerSchema,
  mediumObservationCount: NonNegativeIntegerSchema,
  hedgingCount: NonNegativeIntegerSchema,
  explicitMarkerCount: NonNegativeIntegerSchema,
});

export const ExperienceReviewIndicatorsWireSchema = ExperienceReviewIndicatorsSchema.required();

export const ExperienceMetaSchema = z.object({
  sessionCount: NonNegativeIntegerSchema,
  skillCount: NonNegativeIntegerSchema,
  invocationCount: NonNegativeIntegerSchema,
  goalSliceCount: NonNegativeIntegerSchema,
  noteCodes: z.array(z.enum(['no_llm_judge', 'no_auto_verdict', 'default_goal_slice_is_allowed', 'deterministic_assistive_inference'])),
});

export const ExperienceAttributionSchema = z.object({
  source: z.string(),
  confidence: z.number(),
  rawSkillRef: z.string().optional(),
  pluginName: z.string().optional(),
  commandName: z.string().optional(),
});

export const ExperienceTimelineScopeSchema = z.object({
  mode: z.literal('skill_segment_window'),
  segmentEventCount: NonNegativeIntegerSchema,
  previewEventCount: NonNegativeIntegerSchema,
  fullSessionEventCount: NonNegativeIntegerSchema,
  segmentRecordRanges: z.array(ExperienceTraceRecordRangeSchema),
  previewRecordRanges: z.array(ExperienceTraceRecordRangeSchema),
  sessionRecordRanges: z.array(ExperienceTraceRecordRangeSchema),
  truncated: z.boolean(),
  omittedBeforeCount: NonNegativeIntegerSchema,
  omittedAfterCount: NonNegativeIntegerSchema,
});

export const ExperienceProblemBucketSchema = z.enum(['output_format', 'content_accuracy', 'missing_context', 'rule_violation', 'workflow_mismatch', 'tool_runtime', 'goal_shift', 'unclear']);

export const ExperienceProblemSignalSchema = z.enum(['user_correction', 'negative_feedback', 'user_interruption', 'hard_rule', 'user_goal_shift', 'tool_failure', 'workflow_mismatch', 'artifact_missing', 'observer_lifecycle_failed', 'orchestration_boundary_violation']);

export const ExperienceProblemEvidenceRefSchema = z.object({
  id: z.string(),
  kind: z.string(),
  traceId: z.string().optional(),
  sourceTrace: z.string(),
  sessionId: z.string(),
  messageIndex: NonNegativeIntegerSchema.optional(),
  logicalMessageIndex: NonNegativeIntegerSchema.optional(),
  sourceLineIndex: NonNegativeIntegerSchema.optional(),
  messageUuid: z.string().optional(),
  callInstanceId: z.string().optional(),
  toolUseId: z.string().optional(),
  timestamp: z.string().optional(),
  role: z.enum(['user', 'assistant', 'tool', 'other']).optional(),
  label: z.string().optional(),
  snippet: z.string().optional(),
});

export const ExperienceProblemPatternSchema = z.object({
  id: z.string(),
  bucket: ExperienceProblemBucketSchema,
  patternKey: z.string(),
  count: NonNegativeIntegerSchema,
  sessionCount: NonNegativeIntegerSchema,
  recentSessionIds: z.array(z.string()),
  signalTypes: z.array(ExperienceProblemSignalSchema),
  evidenceRefs: z.array(ExperienceProblemEvidenceRefSchema),
  lastSeen: z.string().optional(),
});

const ExperienceCountRecordSchema = z.record(z.string(), NonNegativeIntegerSchema);

export const ExperienceInvocationSchema = z.object({
  id: z.string(),
  skillName: z.string(),
  sessionId: z.string(),
  sessionGroupKey: z.string(),
  traceId: z.string().optional(),
  sourceTrace: z.string(),
  sourceKind: TraceSourceKindSchema,
  entrypoint: z.string().optional(),
  sourceMetadata: TraceSourceMetadataSchema.optional(),
  cwd: z.string().optional(),
  segmentIndex: NonNegativeIntegerSchema,
  goalSliceId: z.string(),
  startTimestamp: z.string(),
  endTimestamp: z.string(),
  timestampObserved: z.boolean().optional(),
  attribution: ExperienceAttributionSchema,
  metrics: ExperienceInvocationMetricsSchema,
  toolCounts: ExperienceCountRecordSchema,
  indicators: ExperienceReviewIndicatorsSchema,
  evidenceChain: ExperienceEvidenceChainSchema,
  ruleFindings: z.array(ExperienceRuleFindingSchema),
  assistiveInference: ExperienceAssistiveInferenceSchema,
  problemPatterns: z.array(ExperienceProblemPatternSchema),
  relatedObservationIds: z.array(z.string()),
  evidenceRefs: z.array(ExperienceEvidenceRefSchema),
  timelineRef: z.string().optional(),
  timelineEventIds: z.array(z.string()).optional(),
  timeline: z.array(ExperienceTimelineEventSchema),
});

export const ExperienceSessionSummarySchema = z.object({
  id: z.string(),
  skillName: z.string(),
  threadId: z.string(),
  sourceThreadId: z.string(),
  sessionId: z.string(),
  sourceTrace: z.string(),
  sourceKind: TraceSourceKindSchema,
  entrypoint: z.string().optional(),
  sourceMetadata: TraceSourceMetadataSchema.optional(),
  cwd: z.string().optional(),
  sourceSessionStartTimestamp: z.string().optional(),
  sourceSessionEndTimestamp: z.string().optional(),
  sourceSessionDurationMs: NonNegativeIntegerSchema.optional(),
  startTimestamp: z.string(),
  endTimestamp: z.string(),
  timestampedInvocationCount: NonNegativeIntegerSchema.optional(),
  timestampCoverage: z.number().optional(),
  invocationIds: z.array(z.string()),
  goalSliceIds: z.array(z.string()),
  reviewPriority: ExperienceReviewPrioritySchema,
  reviewPriorityScore: z.number().nonnegative(),
  reviewBasisCodes: z.array(ExperienceReviewBasisCodeSchema),
  indicators: ExperienceReviewIndicatorsSchema,
  evidenceChain: ExperienceEvidenceChainSchema,
  ruleFindings: z.array(ExperienceRuleFindingSchema),
  assistiveInference: ExperienceAssistiveInferenceSchema,
  problemPatterns: z.array(ExperienceProblemPatternSchema),
  relatedObservationIds: z.array(z.string()),
  timelineRef: z.string().optional(),
  timelinePreviewEventIds: z.array(z.string()).optional(),
  attributedEventIds: z.array(z.string()),
  turns: z.array(ExperienceTurnSummarySchema),
  timelinePreview: z.array(ExperienceTimelineEventSchema),
  fullSessionTimeline: z.array(ExperienceTimelineEventSchema),
  timelineTree: ExperienceTimelineTreeSchema.optional(),
  timelineScope: ExperienceTimelineScopeSchema,
  attributionSources: z.array(z.string()),
  pluginNames: z.array(z.string()),
  rawSkillRefs: z.array(z.string()),
  commandNames: z.array(z.string()),
  sessionStory: ExperienceSessionStorySchema.optional(),
  reviewerReport: ExperienceReviewerReportSchema.optional(),
});

export const ExperienceSkillSummarySchema = z.object({
  skillName: z.string(),
  invocationCount: NonNegativeIntegerSchema,
  sessionCount: NonNegativeIntegerSchema,
  sourceKinds: z.array(TraceSourceKindSchema),
  entrypoints: z.array(z.string()),
  entrypointCounts: ExperienceCountRecordSchema,
  sourceMetadataCounts: z.object({
    channels: ExperienceCountRecordSchema,
    senders: ExperienceCountRecordSchema,
    businessActions: ExperienceCountRecordSchema,
    providers: ExperienceCountRecordSchema,
    models: ExperienceCountRecordSchema,
  }),
  attributionCounts: ExperienceCountRecordSchema,
  pluginNames: z.array(z.string()),
  rawSkillRefs: z.array(z.string()),
  commandNames: z.array(z.string()),
  toolCounts: ExperienceCountRecordSchema,
  firstSeen: z.string(),
  lastSeen: z.string(),
  timestampedInvocationCount: NonNegativeIntegerSchema.optional(),
  timestampCoverage: z.number().optional(),
  reviewFirstSessionCount: NonNegativeIntegerSchema,
  sampleReviewSessionCount: NonNegativeIntegerSchema,
  indicators: ExperienceReviewIndicatorsSchema,
  evidenceChain: ExperienceEvidenceChainSchema,
  ruleFindings: z.array(ExperienceRuleFindingSchema),
  assistiveInference: ExperienceAssistiveInferenceSchema,
  problemPatterns: z.array(ExperienceProblemPatternSchema),
  relatedObservationIds: z.array(z.string()),
});

export const ExperienceInvocationWireSchema = ExperienceInvocationSchema.extend({
  traceId: z.string(),
  timestampObserved: z.boolean(),
  metrics: ExperienceInvocationMetricsWireSchema,
  indicators: ExperienceReviewIndicatorsWireSchema,
  timelineRef: z.string(),
  timelineEventIds: z.array(z.string()),
  timeline: z.array(ExperienceTimelineEventSchema).optional(),
});

export const ExperienceSessionSummaryWireSchema = ExperienceSessionSummarySchema.extend({
  threadId: z.string().optional(),
  sourceThreadId: z.string().optional(),
  timestampedInvocationCount: NonNegativeIntegerSchema,
  timestampCoverage: z.number(),
  indicators: ExperienceReviewIndicatorsWireSchema,
  turns: z.array(ExperienceTurnSummarySchema).optional(),
  timelineRef: z.string(),
  timelinePreviewEventIds: z.array(z.string()),
  timelinePreview: z.array(ExperienceTimelineEventSchema).optional(),
  fullSessionTimeline: z.array(ExperienceTimelineEventSchema).optional(),
  sessionStory: ExperienceSessionStoryWireSchema.optional(),
  reviewerReport: ExperienceReviewerReportWireSchema.optional(),
}).omit({ attributedEventIds: true });

export const ExperienceSkillSummaryWireSchema = ExperienceSkillSummarySchema.extend({
  timestampedInvocationCount: NonNegativeIntegerSchema,
  timestampCoverage: z.number(),
  indicators: ExperienceReviewIndicatorsWireSchema,
});
