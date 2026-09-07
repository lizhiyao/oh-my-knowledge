import { z } from 'zod';
import {
  ExperienceAssistiveInferenceCautionCodeSchema,
  ExperienceAssistiveInferenceCodeSchema,
  ExperienceAssistiveInferenceConfidenceSchema,
  ExperienceChecklistContributionSchema,
  ExperienceChecklistItemStatusSchema,
  ExperienceEvidenceKindSchema,
  ExperienceGoalSliceReasonCodeSchema,
  ExperienceParentReasonSchema,
  ExperienceReviewerReportFindingSourceSchema,
  ExperienceReviewerReportStepStatusSchema,
  ExperienceRuleFindingCodeSchema,
  ExperienceRuleFindingLevelSchema,
  ExperienceSessionStoryAnswerKeySchema,
  ExperienceSessionStoryNodeKindSchema,
  ExperienceSessionStorySkillRoleSchema,
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
