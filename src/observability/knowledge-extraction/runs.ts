import { z } from 'zod';
import { KnowledgeActorSchema } from '../../knowledge/contracts.js';
import { GroundingSchema } from '../../knowledge/store.js';
import { KnowledgeRevisionSchema } from '../../knowledge/contracts.js';

export const ExtractionRunSchema = z.strictObject({
  runId: z.string().uuid(), requestDigest: z.string(), generation: z.number().int().positive(),
  snapshotId: z.string().uuid(), sourceVersion: z.string(),
  executor: z.string().min(1), model: z.string().min(1),
  promptVersion: z.enum(['knowledge-extraction-v1', 'knowledge-local-rules-v1']), promptHash: z.string(), inputDigest: z.string(),
  actor: KnowledgeActorSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(['generating', 'prepared', 'completed', 'failed', 'cancelled']),
  error: z.string().optional(), rawOutput: z.string().optional(),
  rejections: z.array(z.strictObject({ index: z.number().int().nonnegative(), reasons: z.array(z.string()) })),
  intents: z.array(z.strictObject({
    requestId: z.string(), revision: KnowledgeRevisionSchema, grounding: GroundingSchema,
  })),
  committed: z.array(z.strictObject({ knowledgeId: z.string(), revisionId: z.string() })),
  runtime: z.strictObject({
    durationMs: z.number(), inputTokens: z.number().optional(), outputTokens: z.number().optional(),
    costUSD: z.number().optional(),
  }).optional(),
});
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;
export interface ExtractionRunStore {
  create(run: ExtractionRun): void;
  read(runId: string): ExtractionRun;
  list(): ExtractionRun[];
  save(run: ExtractionRun, expectedGeneration: number): void;
}
