import { z } from 'zod';
import { EntityMentionSchema, KnowledgeActorSchema, type KnowledgeActor } from './contracts.js';
import { canonicalJson } from './store.js';

const text = z.string().trim().min(1).max(4096);
const uuid = z.string().uuid();
const sourceVersion = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const AnalyzedEntitySchema = z.strictObject({
  entityId: uuid, label: text, description: text, qualifiers: z.array(text).max(32),
  identityStatus: z.enum(['proposed', 'unresolved']),
  possibleEntityIds: z.array(uuid).max(32), uncertainties: z.array(text).max(32),
}).superRefine((entity, context) => {
  if (entity.identityStatus === 'unresolved' && !entity.uncertainties.length) {
    context.addIssue({ code: 'custom', path: ['uncertainties'], message: 'Unresolved identity needs a reason.' });
  }
  if (entity.identityStatus === 'proposed' && entity.possibleEntityIds.length) {
    context.addIssue({ code: 'custom', path: ['possibleEntityIds'], message: 'Possible targets belong to unresolved identities.' });
  }
});
export type AnalyzedEntity = z.infer<typeof AnalyzedEntitySchema>;
export const EntityAnalysisDraftSchema = z.strictObject({
  entities: z.array(AnalyzedEntitySchema).max(256),
  mentions: z.array(EntityMentionSchema.extend({ mentionId: uuid, entityId: uuid })).max(512),
  limitations: z.array(text).max(64),
});
export type EntityAnalysisDraft = z.infer<typeof EntityAnalysisDraftSchema>;
export const EntityAnalysisRevisionSchema = EntityAnalysisDraftSchema.extend({
  revisionId: uuid, parentRevisionId: uuid.optional(),
  revisedAt: z.iso.datetime({ offset: true }), revisedBy: KnowledgeActorSchema, revisionReason: text,
});
export type EntityAnalysisRevision = z.infer<typeof EntityAnalysisRevisionSchema>;
export const EntityAnalysisEnvelopeSchema = z.strictObject({
  storeKind: z.literal('entity-analysis-history'), schemaVersion: z.literal(1),
  analysisId: uuid, snapshotId: uuid, sourceVersion,
  generation: z.number().int().positive(), writeHeadRevisionId: uuid,
  revisions: z.array(EntityAnalysisRevisionSchema).min(1).max(1024),
  receipts: z.array(z.strictObject({
    requestId: uuid, commandDigest: z.string().min(1), committedGeneration: z.number().int().positive(), revisionId: uuid,
  })).min(1).max(1024),
});
export type EntityAnalysisEnvelope = z.infer<typeof EntityAnalysisEnvelopeSchema>;
export const EntityAnalysisWriteSchema = z.strictObject({
  requestId: uuid, analysisId: uuid, snapshotId: uuid, sourceVersion,
  expectedGeneration: z.number().int().nonnegative(), expectedHeadRevisionId: uuid.nullable(),
  revision: EntityAnalysisRevisionSchema,
});
export type EntityAnalysisWrite = z.infer<typeof EntityAnalysisWriteSchema>;
export interface EntityAnalysisStore {
  read(analysisId: string): EntityAnalysisEnvelope;
  write(command: EntityAnalysisWrite, actor: KnowledgeActor): EntityAnalysisEnvelope['receipts'][number];
}

/** Reference closure is structural admission, never semantic identity verification. */
export function validateEntityAnalysis(draft: EntityAnalysisDraft): string[] {
  const problems: string[] = [];
  const ids = new Set(draft.entities.map(entity => entity.entityId));
  if (ids.size !== draft.entities.length) problems.push('duplicate_entity');
  const mentions = new Set(draft.mentions.map(mention => mention.mentionId));
  if (mentions.size !== draft.mentions.length) problems.push('duplicate_mention');
  const positions = new Set<string>();
  for (const mention of draft.mentions) {
    if (!ids.has(mention.entityId)) problems.push('unknown_entity');
    if (mention.selection.start >= mention.selection.end
      || mention.selection.end - mention.selection.start !== mention.selection.quote.length) problems.push('invalid_selection');
    const position = canonicalJson([mention.selection.evidenceRef, mention.selection.start, mention.selection.end]);
    if (positions.has(position)) problems.push('duplicate_mention_position');
    positions.add(position);
  }
  for (const entity of draft.entities) {
    if (!draft.mentions.some(mention => mention.entityId === entity.entityId)) problems.push('entity_without_mention');
    if (new Set(entity.possibleEntityIds).size !== entity.possibleEntityIds.length) problems.push('duplicate_possible_entity');
    for (const target of entity.possibleEntityIds) {
      if (!ids.has(target) || target === entity.entityId) problems.push('unknown_possible_entity');
      else if (draft.entities.find(candidate => candidate.entityId === target)?.identityStatus !== 'proposed') problems.push('unresolved_possible_entity');
    }
  }
  return [...new Set(problems)];
}

export function validateEntityAnalysisHistory(history: EntityAnalysisEnvelope): void {
  if (history.generation !== history.revisions.length || history.receipts.length !== history.generation
    || history.writeHeadRevisionId !== history.revisions.at(-1)!.revisionId) throw new Error('Invalid entity history head.');
  const revisionIds = new Set<string>(); const requests = new Set<string>();
  const selections = new Map<string, string>();
  for (const [index, revision] of history.revisions.entries()) {
    if (revisionIds.has(revision.revisionId) || revision.parentRevisionId !== history.revisions[index - 1]?.revisionId
      || validateEntityAnalysis(revision).length) throw new Error('Invalid entity revision references.');
    revisionIds.add(revision.revisionId);
    const receipt = history.receipts[index];
    if (requests.has(receipt.requestId) || receipt.committedGeneration !== index + 1 || receipt.revisionId !== revision.revisionId) {
      throw new Error('Invalid entity receipts.');
    }
    requests.add(receipt.requestId);
    for (const mention of revision.mentions) {
      const selection = canonicalJson(mention.selection);
      if (selections.has(mention.mentionId) && selections.get(mention.mentionId) !== selection) {
        throw new Error('Entity mention identity moved to different evidence.');
      }
      selections.set(mention.mentionId, selection);
    }
  }
}

export function applyEntityAnalysisWrite(existing: EntityAnalysisEnvelope | undefined, input: EntityAnalysisWrite,
  actor: KnowledgeActor, commandDigest: string): EntityAnalysisEnvelope {
  const command = EntityAnalysisWriteSchema.parse(input);
  if (canonicalJson(command.revision.revisedBy) !== canonicalJson(KnowledgeActorSchema.parse(actor))) throw new Error('unauthorized_entity_author');
  if (existing) {
    validateEntityAnalysisHistory(existing);
    if (existing.analysisId !== command.analysisId || existing.snapshotId !== command.snapshotId
      || existing.sourceVersion !== command.sourceVersion) throw new Error('Entity source identity conflict.');
    const previous = existing.receipts.find(receipt => receipt.requestId === command.requestId);
    if (previous) {
      if (previous.commandDigest !== commandDigest) throw new Error('entity_idempotency_conflict');
      return existing;
    }
  }
  if ((existing?.generation ?? 0) !== command.expectedGeneration
    || (existing?.writeHeadRevisionId ?? null) !== command.expectedHeadRevisionId
    || (command.revision.parentRevisionId ?? null) !== command.expectedHeadRevisionId) throw new Error('Entity analysis conflict.');
  const next = EntityAnalysisEnvelopeSchema.parse({
    storeKind: 'entity-analysis-history', schemaVersion: 1,
    analysisId: command.analysisId, snapshotId: command.snapshotId, sourceVersion: command.sourceVersion,
    generation: command.expectedGeneration + 1, writeHeadRevisionId: command.revision.revisionId,
    revisions: [...(existing?.revisions ?? []), command.revision],
    receipts: [...(existing?.receipts ?? []), { requestId: command.requestId, commandDigest,
      committedGeneration: command.expectedGeneration + 1, revisionId: command.revision.revisionId }],
  });
  validateEntityAnalysisHistory(next);
  return next;
}
