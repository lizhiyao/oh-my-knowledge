import { z } from 'zod';
import { KnowledgeActorSchema, KnowledgeBodyRefSchema } from '../contracts.js';
import { KnowledgeWriteSchema } from '../store.js';
import { EntityAnalysisWriteSchema } from '../entities/contracts.js';
import { KnowledgeAssociationRevisionSchema } from '../associations.js';
import { GenerationOutcomeRefSchema, type GenerationOutcome } from './native-outcome.js';
import { WORKFLOW_ID } from './source-input.js';
import { SOURCE_REVIEW_INPUT_VERSION } from './source-review-input.js';
import { SourceLedgerWriteSchema, SourceCoverageWriteSchema, SourceLedgerRefSchema, SourceCoverageRefSchema,
  SourceCoverageDecisionRefSchema } from '../source-review.js';

const uuid = z.string().uuid(), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const associationWrite = z.strictObject({ commandKind: z.literal('append_revision'), requestId: uuid,
  knowledgeId: z.string().min(1), expectedGeneration: z.number().int().nonnegative(), expectedHeadRevisionId: z.string().nullable(),
  revision: KnowledgeAssociationRevisionSchema });
export const GenerationStageSchema = z.strictObject({
  stageKind: z.enum(['source_ledger', 'body', 'source_coverage', 'association']), invocationId: uuid,
  state: z.enum(['prepared', 'claimed', 'archived', 'prepared_writes', 'completed', 'failed']),
  profileId: digest, promptVersion: z.string(), system: z.string(), wireId: digest, wireSchema: z.record(z.string(), z.unknown()),
  input: z.string(), inputDigest: digest, requestDigest: digest,
  producer: z.strictObject({ producerId: z.string().min(1), producerRevision: z.string().min(1),
    sourceChannels: z.array(z.strictObject({ channel: z.string(), maxBytes: z.number().int().nonnegative() })),
    maxOutcomeJsonBytes: z.number().int().positive(), proof: z.unknown() }),
  outcomeRef: GenerationOutcomeRefSchema.optional(),
  rejected: z.array(z.strictObject({ index: z.number().int().nonnegative(), reasons: z.array(z.string()) })).optional(),
  issues: z.array(z.string()),
  bodyWrites: z.array(KnowledgeWriteSchema).optional(), entityWrites: z.array(EntityAnalysisWriteSchema).optional(),
  associationWrites: z.array(associationWrite).optional(), committed: z.number().int().nonnegative(),
  ledgerWrites: z.array(SourceLedgerWriteSchema).length(1).optional(),
  coverageWrites: z.array(SourceCoverageWriteSchema.options[0]).length(1).optional(),
});
export const GenerationJournalSchema = z.strictObject({
  storeKind: z.literal('knowledge-generation-journal'), schemaVersion: z.literal(4), workflowId: z.literal(WORKFLOW_ID),
  inputVersion: z.literal(SOURCE_REVIEW_INPUT_VERSION), sourceSetId: digest,
  runId: uuid, generation: z.number().int().positive(), mode: z.enum(['generate', 'review_sources', 'rebuild_associations']),
  status: z.enum(['active', 'completed', 'failed']), createdAt: z.iso.datetime({ offset: true }), actor: KnowledgeActorSchema,
  sources: z.array(z.strictObject({ snapshotId: uuid, sourceVersion: digest, sourceDigest: digest })).min(1).max(256),
  executor: z.string().min(1), model: z.string().min(1), timeoutMs: z.number().int().positive(),
  bodies: z.array(KnowledgeBodyRefSchema).max(256), stages: z.array(GenerationStageSchema).min(1).max(4),
  ledgerRef: SourceLedgerRefSchema.optional(), coverageRef: SourceCoverageRefSchema.optional(),
  sourceCoverageDecisionRef: SourceCoverageDecisionRefSchema.optional(),
});
export type GenerationStage = z.infer<typeof GenerationStageSchema>;
export type GenerationJournal = z.infer<typeof GenerationJournalSchema>;
/** Inventory observations never claim that a native original has been decoded or verified. */
export interface GenerationArchiveCheck {
  runId: string;
  invocationId: string;
  archiveStatus: 'not_recorded' | 'present' | 'missing' | 'invalid' | 'unknown';
  verificationStatus: 'not_verified';
  reason?: string;
}
export interface GenerationJournalInventory {
  current: GenerationJournal[];
  unsupported: { runId: string; schemaStatus: 'unsupported'; reason: string }[];
  unavailable: { runId: string; reason: 'unreadable' | 'invalid_identity'; detail: string }[];
  archiveChecks: GenerationArchiveCheck[];
}
export interface GenerationJournalStore {
  read(runId: string): GenerationJournal | undefined;
  list(): GenerationJournalInventory;
  /** The association dispatch witness is checked under the same workspace lock that publishes its claim. */
  write(journal: GenerationJournal, expectedGeneration: number,
    validateClaim?: (journal: GenerationJournal, stage: GenerationStage) => void): GenerationJournal;
  archive(journal: GenerationJournal, stage: GenerationStage, outcome: GenerationOutcome): z.infer<typeof GenerationOutcomeRefSchema>;
  outcome(journal: GenerationJournal, stage: GenerationStage): GenerationOutcome | undefined;
}
