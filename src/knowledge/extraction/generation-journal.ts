import { z } from 'zod';
import { KnowledgeActorSchema, KnowledgeBodyRefSchema } from '../contracts.js';
import { KnowledgeWriteSchema } from '../store.js';
import { EntityAnalysisWriteSchema } from '../entities/contracts.js';
import { KnowledgeAssociationRevisionSchema } from '../associations.js';
import { GenerationOutcomeRefSchema, type GenerationOutcome } from './native-outcome.js';

const uuid = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const associationWrite = z.strictObject({ commandKind: z.literal('append_revision'), requestId: uuid,
  knowledgeId: z.string().min(1), expectedGeneration: z.number().int().nonnegative(), expectedHeadRevisionId: z.string().nullable(),
  revision: KnowledgeAssociationRevisionSchema });
export const GenerationStageSchema = z.strictObject({
  stageKind: z.enum(['body', 'association']), invocationId: uuid,
  state: z.enum(['prepared', 'claimed', 'archived', 'prepared_writes', 'completed', 'failed']),
  profileId: digest, promptVersion: z.string(), system: z.string(), wireId: digest, wireSchema: z.record(z.string(), z.unknown()),
  input: z.string(), inputDigest: digest, requestDigest: digest,
  producer: z.strictObject({ producerId: z.string().min(1), producerRevision: z.string().min(1),
    sourceChannels: z.array(z.strictObject({ channel: z.string(), maxBytes: z.number().int().nonnegative() })),
    maxOutcomeJsonBytes: z.number().int().positive(), proof: z.unknown() }),
  outcomeRef: GenerationOutcomeRefSchema.optional(),
  rejected: z.array(z.strictObject({ index: z.number().int().nonnegative(), reasons: z.array(z.string()) })).optional(),
  issues: z.array(z.string()),
  bodyWrites: z.array(KnowledgeWriteSchema).optional(), entityWrite: EntityAnalysisWriteSchema.optional(),
  associationWrites: z.array(associationWrite).optional(), committed: z.number().int().nonnegative(),
});
export const GenerationJournalSchema = z.strictObject({
  storeKind: z.literal('knowledge-generation-journal'), schemaVersion: z.literal(1), workflowId: z.literal('knowledge-body-first/v1'),
  runId: uuid, generation: z.number().int().positive(), mode: z.enum(['generate', 'rebuild_associations']),
  status: z.enum(['active', 'completed', 'failed']), createdAt: z.iso.datetime({ offset: true }), actor: KnowledgeActorSchema,
  snapshotId: uuid, sourceVersion: digest, sourceDigest: digest,
  executor: z.string().min(1), model: z.string().min(1), timeoutMs: z.number().int().positive(),
  bodies: z.array(KnowledgeBodyRefSchema), stages: z.array(GenerationStageSchema).min(1).max(2),
});
export type GenerationStage = z.infer<typeof GenerationStageSchema>;
export type GenerationJournal = z.infer<typeof GenerationJournalSchema>;
export interface GenerationJournalStore {
  read(runId: string): GenerationJournal | undefined;
  list(): { current: GenerationJournal[]; unsupported: { runId: string; schemaStatus: 'unsupported'; reason: string }[] };
  write(journal: GenerationJournal, expectedGeneration: number): GenerationJournal;
  archive(journal: GenerationJournal, stage: GenerationStage, outcome: GenerationOutcome): z.infer<typeof GenerationOutcomeRefSchema>;
  outcome(journal: GenerationJournal, stage: GenerationStage): GenerationOutcome | undefined;
}
