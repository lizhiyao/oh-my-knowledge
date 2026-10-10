import { KnowledgeActorSchema, type KnowledgeActor } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { EntityAnalysisEnvelopeSchema, EntityAnalysisWriteSchema, type EntityAnalysisEnvelope, type EntityAnalysisWrite } from './contracts.js';
import { validateEntityAnalysis } from './validation.js';

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
    storeKind: 'entity-analysis-history', schemaVersion: 2,
    analysisId: command.analysisId, snapshotId: command.snapshotId, sourceVersion: command.sourceVersion,
    generation: command.expectedGeneration + 1, writeHeadRevisionId: command.revision.revisionId,
    revisions: [...(existing?.revisions ?? []), command.revision],
    receipts: [...(existing?.receipts ?? []), { requestId: command.requestId, commandDigest,
      committedGeneration: command.expectedGeneration + 1, revisionId: command.revision.revisionId }],
  });
  validateEntityAnalysisHistory(next);
  return next;
}
