import type { z } from 'zod';
import type {
  ExperienceProblemBucketSchema,
  ExperienceProblemSignalSchema,
  ExperienceProblemEvidenceRefSchema,
  ExperienceProblemPatternSchema,
} from './experience-evidence-schema.js';

export type ExperienceProblemBucket = z.infer<typeof ExperienceProblemBucketSchema>;

export type ExperienceProblemSignal = z.infer<typeof ExperienceProblemSignalSchema>;

export type ExperienceProblemEvidenceRef = z.infer<typeof ExperienceProblemEvidenceRefSchema>;

export type ExperienceProblemPattern = z.infer<typeof ExperienceProblemPatternSchema>;

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
