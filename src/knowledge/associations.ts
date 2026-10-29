import { z } from 'zod';
import { KnowledgeActorSchema, KnowledgeBodyEvidenceSchema, KnowledgeBodyRefSchema, type KnowledgeActor, type KnowledgeBodyRef, type KnowledgeRevision } from './contracts.js';
import { canonicalJson } from './store.js';

const id = z.string().min(1).max(256);
const text = z.string().min(1).max(32_768).refine(value => value.trim().length > 0);
export const KnowledgeAssociationCatalogRefSchema = z.strictObject({ analysisId: z.string().uuid(), entityRevisionId: z.string().uuid() });
export const KnowledgeAssociationEntityRefSchema = KnowledgeAssociationCatalogRefSchema.extend({ entityId: id });
export const knowledgeAssociationCatalogKey = (ref: z.infer<typeof KnowledgeAssociationCatalogRefSchema>) => canonicalJson([ref.analysisId, ref.entityRevisionId]);
export const knowledgeAssociationEntityKey = (ref: z.infer<typeof KnowledgeAssociationEntityRefSchema>) => canonicalJson([ref.analysisId, ref.entityRevisionId, ref.entityId]);
export const KnowledgeAssociationRevisionSchema = z.strictObject({
  revisionId: id, parentRevisionId: id.optional(), bodyRef: KnowledgeBodyRefSchema,
  status: z.enum(['available', 'failed']), reviewStatus: z.literal('pending'),
  catalogRefs: z.array(KnowledgeAssociationCatalogRefSchema),
  segmentEntityRefs: z.array(KnowledgeAssociationEntityRefSchema.extend({ segmentId: id, mentionIds: z.array(id).min(1) })),
  typedRelations: z.array(z.strictObject({
    relationId: id, segmentIds: z.array(id).min(1), subject: KnowledgeAssociationEntityRefSchema,
    relation: text, object: KnowledgeAssociationEntityRefSchema.optional(),
    modality: z.enum(['descriptive', 'normative', 'capability', 'permission']),
    polarity: z.enum(['positive', 'negative']),
    evidence: z.array(KnowledgeBodyEvidenceSchema).min(1), issues: z.array(text),
  })).optional(),
  issues: z.array(text), revisedAt: z.iso.datetime({ offset: true }), revisedBy: KnowledgeActorSchema, revisionReason: text,
});
export type KnowledgeAssociationRevision = z.infer<typeof KnowledgeAssociationRevisionSchema>;
export const KnowledgeAssociationReviewSchema = z.strictObject({
  projectionRevisionId: id, choice: z.enum(['accept', 'reject']), actor: KnowledgeActorSchema,
  at: z.iso.datetime({ offset: true }), reason: text,
});
export type KnowledgeAssociationReview = z.infer<typeof KnowledgeAssociationReviewSchema>;
export const KnowledgeAssociationEnvelopeSchema = z.strictObject({
  storeKind: z.literal('knowledge-association-history'), schemaVersion: z.literal(2),
  namespace: id, knowledgeId: id, generation: z.number().int().positive(), writeHeadRevisionId: id,
  revisions: z.array(KnowledgeAssociationRevisionSchema).min(1), reviews: z.array(KnowledgeAssociationReviewSchema),
  receipts: z.array(z.strictObject({ requestId: id, commandDigest: z.string().min(1), committedGeneration: z.number().int().positive(), revisionId: id })).min(1),
});
export type KnowledgeAssociationEnvelope = z.infer<typeof KnowledgeAssociationEnvelopeSchema>;
const writeIdentity = { requestId: id, knowledgeId: id, expectedGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
export const KnowledgeAssociationWriteSchema = z.discriminatedUnion('commandKind', [
  z.strictObject({ ...writeIdentity, commandKind: z.literal('append_revision'), expectedHeadRevisionId: id.nullable(), revision: KnowledgeAssociationRevisionSchema }),
  z.strictObject({ ...writeIdentity, commandKind: z.literal('record_review'), review: KnowledgeAssociationReviewSchema }),
]);
export type KnowledgeAssociationWrite = z.infer<typeof KnowledgeAssociationWriteSchema>;
export interface KnowledgeAssociationStore {
  read(knowledgeId: string): KnowledgeAssociationEnvelope;
  list(): KnowledgeAssociationEnvelope[];
  write(command: KnowledgeAssociationWrite, actor: KnowledgeActor): KnowledgeAssociationEnvelope['receipts'][number];
}
export type KnowledgeAssociationSelection = {
  status: 'absent' | 'failed' | 'stale' | 'available'; reviewStatus: 'pending' | 'accepted' | 'rejected'; bodyRef: KnowledgeBodyRef; revision?: KnowledgeAssociationRevision;
};
export function selectKnowledgeAssociation(history: KnowledgeAssociationEnvelope | undefined, bodyRef: KnowledgeBodyRef): KnowledgeAssociationSelection {
  if (!history) return { status: 'absent', reviewStatus: 'pending', bodyRef };
  validateKnowledgeAssociationHistory(history);
  if (history.knowledgeId !== bodyRef.knowledgeId) throw new Error('Association knowledge identity mismatch.');
  const revision = [...history.revisions].reverse().find(item => canonicalJson(item.bodyRef) === canonicalJson(bodyRef));
  const review = revision && [...history.reviews].reverse().find(item => item.projectionRevisionId === revision.revisionId);
  return revision ? { status: revision.status, reviewStatus: review ? review.choice === 'accept' ? 'accepted' : 'rejected' : 'pending', bodyRef, revision }
    : { status: 'stale', reviewStatus: 'pending', bodyRef, revision: history.revisions.at(-1)! };
}

/** Derived evidence cannot silently extend the body it describes. */
export function validateKnowledgeAssociationReferences(revision: KnowledgeAssociationRevision, body: KnowledgeRevision): void {
  if (canonicalJson(revision.bodyRef) !== canonicalJson({ knowledgeId: body.knowledgeId, revisionId: body.revisionId, bodyDigest: body.bodyDigest })) {
    throw new Error('Association body identity mismatch.');
  }
  const segments = new Map(body.content.segments.map(segment => [segment.segmentId, segment]));
  const catalogs = new Set(revision.catalogRefs.map(knowledgeAssociationCatalogKey));
  if (catalogs.size !== revision.catalogRefs.length) throw new Error('Duplicate association catalog reference.');
  const associations = new Set<string>();
  for (const ref of revision.segmentEntityRefs) {
    const key = canonicalJson([ref.segmentId, knowledgeAssociationEntityKey(ref)]);
    if (!catalogs.has(knowledgeAssociationCatalogKey(ref)) || !segments.has(ref.segmentId) || associations.has(key) || new Set(ref.mentionIds).size !== ref.mentionIds.length) {
      throw new Error('Invalid segment entity reference.');
    }
    associations.add(key);
  }
  const relationIds = new Set<string>();
  for (const relation of revision.typedRelations ?? []) {
    if (relationIds.has(relation.relationId) || new Set(relation.segmentIds).size !== relation.segmentIds.length
      || relation.segmentIds.some(id => !segments.has(id))) throw new Error('Invalid typed relation references.');
    relationIds.add(relation.relationId);
    for (const endpoint of [relation.subject, relation.object].filter(value => value !== undefined)) {
      if (!catalogs.has(knowledgeAssociationCatalogKey(endpoint)) || !relation.segmentIds.some(segmentId => associations.has(canonicalJson([segmentId, knowledgeAssociationEntityKey(endpoint)])))) {
        throw new Error('Typed relation entity is not associated with its body segments.');
      }
    }
    const bodyEvidence = relation.segmentIds.flatMap(id => segments.get(id)!.evidence);
    for (const evidence of relation.evidence) {
      if (!bodyEvidence.some(item => canonicalJson(item.source) === canonicalJson(evidence.source)
        && item.selection.evidenceRef === evidence.selection.evidenceRef
        && evidence.selection.start >= item.selection.start && evidence.selection.end <= item.selection.end
        && evidence.selection.end - evidence.selection.start === evidence.selection.quote.length
        && item.selection.quote.slice(evidence.selection.start - item.selection.start, evidence.selection.end - item.selection.start) === evidence.selection.quote)) {
        throw new Error('Typed relation evidence is outside its body segment evidence.');
      }
    }
  }
  if (revision.status === 'failed' && (revision.segmentEntityRefs.length || (revision.typedRelations?.length ?? 0))) {
    throw new Error('Failed association must not publish successful relations.');
  }
  if (revision.status === 'failed' && !revision.issues.length) throw new Error('Failed association needs an issue.');
}
export function validateKnowledgeAssociationHistory(history: KnowledgeAssociationEnvelope): void {
  if (history.generation !== history.revisions.length + history.reviews.length || history.generation !== history.receipts.length
    || history.writeHeadRevisionId !== history.revisions.at(-1)!.revisionId) throw new Error('Invalid association history.');
  const ids = new Set<string>(); const requests = new Set<string>();
  for (const [index, revision] of history.revisions.entries()) {
    if (revision.bodyRef.knowledgeId !== history.knowledgeId || ids.has(revision.revisionId)
      || revision.parentRevisionId !== history.revisions[index - 1]?.revisionId) throw new Error('Invalid association lineage.');
    ids.add(revision.revisionId);
  }
  for (const [index, receipt] of history.receipts.entries()) {
    if (requests.has(receipt.requestId) || receipt.committedGeneration !== index + 1 || !ids.has(receipt.revisionId)) throw new Error('Invalid association receipts.');
    requests.add(receipt.requestId);
  }
  for (const review of history.reviews) {
    const target = history.revisions.find(revision => revision.revisionId === review.projectionRevisionId);
    if (!target || (review.choice === 'accept' && target.status !== 'available')) throw new Error('Invalid association review target.');
  }
}
export function applyKnowledgeAssociationWrite(existing: KnowledgeAssociationEnvelope | undefined, input: KnowledgeAssociationWrite,
  actor: KnowledgeActor, namespace: string, commandDigest: string): KnowledgeAssociationEnvelope {
  const command = KnowledgeAssociationWriteSchema.parse(input);
  const author = command.commandKind === 'append_revision' ? command.revision.revisedBy : command.review.actor;
  if (canonicalJson(author) !== canonicalJson(KnowledgeActorSchema.parse(actor))) throw new Error('unauthorized');
  if (existing) {
    validateKnowledgeAssociationHistory(existing);
    if (existing.namespace !== namespace || existing.knowledgeId !== command.knowledgeId) throw new Error('Association identity mismatch.');
    const receipt = existing.receipts.find(item => item.requestId === command.requestId);
    if (receipt) { if (receipt.commandDigest !== commandDigest) throw new Error('idempotency_conflict'); return existing; }
  }
  if (command.expectedGeneration >= Number.MAX_SAFE_INTEGER || (existing?.generation ?? 0) !== command.expectedGeneration) throw new Error('conflict');
  const revisions = [...(existing?.revisions ?? [])], reviews = [...(existing?.reviews ?? [])]; let revisionId: string;
  if (command.commandKind === 'append_revision') {
    if ((existing?.writeHeadRevisionId ?? null) !== command.expectedHeadRevisionId
      || (command.revision.parentRevisionId ?? null) !== command.expectedHeadRevisionId) throw new Error('conflict');
    revisions.push(command.revision); revisionId = command.revision.revisionId;
  } else {
    if (!existing) throw new Error('Unknown association projection.');
    reviews.push(command.review); revisionId = command.review.projectionRevisionId;
  }
  const next = KnowledgeAssociationEnvelopeSchema.parse({
    storeKind: 'knowledge-association-history', schemaVersion: 2, namespace, knowledgeId: command.knowledgeId,
    generation: command.expectedGeneration + 1, writeHeadRevisionId: revisions.at(-1)!.revisionId,
    revisions, reviews, receipts: [...(existing?.receipts ?? []), {
      requestId: command.requestId, commandDigest, committedGeneration: command.expectedGeneration + 1, revisionId,
    }],
  });
  validateKnowledgeAssociationHistory(next); return next;
}
