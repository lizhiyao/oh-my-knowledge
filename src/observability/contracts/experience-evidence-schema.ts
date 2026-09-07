import { z } from 'zod';
import { ExperienceEvidenceKindSchema } from './experience-enums.js';

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
