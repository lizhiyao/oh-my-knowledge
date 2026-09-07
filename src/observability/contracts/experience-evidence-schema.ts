import { z } from 'zod';
import {
  ExperienceAssistiveInferenceCautionCodeSchema,
  ExperienceAssistiveInferenceCodeSchema,
  ExperienceAssistiveInferenceConfidenceSchema,
  ExperienceChecklistContributionSchema,
  ExperienceChecklistItemStatusSchema,
  ExperienceEvidenceKindSchema,
  ExperienceReviewerReportFindingSourceSchema,
  ExperienceRuleFindingCodeSchema,
  ExperienceRuleFindingLevelSchema,
} from './experience-enums.js';

const NonNegativeIntegerSchema = z.number().int().nonnegative();

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
