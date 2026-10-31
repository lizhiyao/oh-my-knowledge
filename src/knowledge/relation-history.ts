import type { KnowledgeActor } from './contracts.js';
import { KnowledgeReviewActorSchema } from './reviews.js';
import { KnowledgeRelationError, KnowledgeRelationEnvelopeSchema, KnowledgeRelationEventSchema, KnowledgeRelationWriteSchema,
  type KnowledgeRelationEnvelope, type KnowledgeRelationEvent, type KnowledgeRelationProposedEvent, type KnowledgeRelationWrite } from './relations.js';

export const sameKnowledgeRelationActor = (a: KnowledgeActor, b: KnowledgeActor): boolean => a.actorKind === b.actorKind && a.actorId === b.actorId;
function proposal(events: readonly KnowledgeRelationEvent[], id: string): KnowledgeRelationProposedEvent {
  const found = events.find((e): e is KnowledgeRelationProposedEvent => e.eventKind === 'relation_proposed' && e.eventId === id);
  if (!found) throw new KnowledgeRelationError('invalid', 'Unknown relation revision.');
  return found;
}
function validateEvent(prior: readonly KnowledgeRelationEvent[], event: KnowledgeRelationEvent): void {
  const latest = [...prior].reverse().find((e): e is KnowledgeRelationProposedEvent => e.eventKind === 'relation_proposed');
  if (event.eventKind === 'relation_proposed') {
    if (event.parentRelationRevisionId !== (latest?.eventId ?? null)) throw new KnowledgeRelationError('invalid', 'Relation proposal parent conflict.');
    if (latest && (event.from.bodyRef.knowledgeId !== latest.from.bodyRef.knowledgeId || event.to.bodyRef.knowledgeId !== latest.to.bodyRef.knowledgeId)) throw new KnowledgeRelationError('invalid', 'Relation endpoint identity conflict.');
    return;
  }
  const target = proposal(prior, event.relationRevisionId);
  const withdrawn = prior.some(e => e.eventKind === 'relation_withdrawn' && e.relationRevisionId === target.eventId);
  if (withdrawn) throw new KnowledgeRelationError('invalid', 'Relation revision is withdrawn; propose a new revision.');
  if (event.eventKind === 'relation_withdrawn') {
    if (latest?.eventId !== target.eventId || !sameKnowledgeRelationActor(event.actor, target.actor)) throw new KnowledgeRelationError('forbidden', 'Only the current proposal revision author can withdraw it.');
    return;
  }
  if (event.checkedEvidenceIndices.some(index => index >= target.evidence.length)) throw new KnowledgeRelationError('invalid', 'Unknown relation evidence index.');
  if (event.choice === 'accept') {
    if (target.relationType === 'conflicts_with' && target.comparisonScope.status !== 'same') throw new KnowledgeRelationError('invalid', 'An unknown comparison scope cannot be accepted as a conflict.');
    if (event.checkedEvidenceIndices.length !== target.evidence.length) throw new KnowledgeRelationError('invalid', 'Accept requires checking every relation evidence item.');
  }
  const superseded = new Set(prior.flatMap(e => e.eventKind === 'relation_reviewed' ? e.supersedesReviewEventIds : []));
  for (const id of event.supersedesReviewEventIds) {
    const previous = prior.find(e => e.eventId === id);
    if (!previous || previous.eventKind !== 'relation_reviewed' || previous.relationRevisionId !== target.eventId
      || superseded.has(id) || !sameKnowledgeRelationActor(previous.actor, event.actor)) throw new KnowledgeRelationError('forbidden', 'Relation review supersession requires an active own opinion on the same revision.');
  }
}
export function validateKnowledgeRelationHistory(history: KnowledgeRelationEnvelope): void {
  if (history.generation !== history.events.length || history.generation !== history.receipts.length
    || history.writeHeadEventId !== history.events.at(-1)?.eventId) throw new Error('Invalid relation history head.');
  const prior: KnowledgeRelationEvent[] = [], ids = new Set<string>();
  for (const [index, event] of history.events.entries()) {
    const receipt = history.receipts[index];
    if (ids.has(event.eventId) || event.parentEventId !== (prior.at(-1)?.eventId ?? null) || receipt.eventId !== event.eventId
      || receipt.requestId !== event.eventId || receipt.committedGeneration !== index + 1) throw new Error('Invalid relation event or receipt references.');
    validateEvent(prior, event); ids.add(event.eventId); prior.push(event);
  }
}
export function applyKnowledgeRelationWrite(existing: KnowledgeRelationEnvelope | undefined, input: KnowledgeRelationWrite,
  actorInput: KnowledgeActor, namespace: string, commandDigest: string, at: string): KnowledgeRelationEnvelope {
  const command = KnowledgeRelationWriteSchema.parse(input), actor = KnowledgeReviewActorSchema.parse(actorInput);
  if (existing) {
    validateKnowledgeRelationHistory(existing);
    if (existing.relationId !== command.relationId || existing.namespace !== namespace) throw new Error('Relation store identity conflict.');
    const receipt = existing.receipts.find(r => r.requestId === command.requestId);
    if (receipt) {
      if (receipt.commandDigest !== commandDigest) throw new Error('Relation idempotency conflict.');
      return existing;
    }
  }
  if ((existing?.generation ?? 0) !== command.expectedGeneration || (existing?.writeHeadEventId ?? null) !== command.expectedHeadEventId) throw new Error('Relation revision conflict.');
  const { relationId, requestId, expectedGeneration, expectedHeadEventId, ...decision } = command;
  const event = KnowledgeRelationEventSchema.parse({ ...decision, eventId: requestId, parentEventId: expectedHeadEventId, actor, at });
  validateEvent(existing?.events ?? [], event);
  const next = KnowledgeRelationEnvelopeSchema.parse({ storeKind: 'knowledge-relation-history', schemaVersion: 1, namespace, relationId,
    generation: expectedGeneration + 1, writeHeadEventId: event.eventId, events: [...(existing?.events ?? []), event],
    receipts: [...(existing?.receipts ?? []), { requestId, commandDigest, committedGeneration: expectedGeneration + 1, eventId: event.eventId }] });
  validateKnowledgeRelationHistory(next); return next;
}
/** Explicit own-opinion supersession only; timestamps never choose truth. */
export function selectKnowledgeRelation(history: KnowledgeRelationEnvelope, revisionId?: string) {
  validateKnowledgeRelationHistory(history);
  const revision = revisionId ? proposal(history.events, revisionId) : [...history.events].reverse().find((e): e is KnowledgeRelationProposedEvent => e.eventKind === 'relation_proposed');
  if (!revision) throw new Error('Relation proposal is missing.');
  const reviews = history.events.filter((e): e is Extract<KnowledgeRelationEvent, { eventKind: 'relation_reviewed' }> => e.eventKind === 'relation_reviewed' && e.relationRevisionId === revision.eventId);
  const superseded = new Set(reviews.flatMap(e => e.supersedesReviewEventIds)), activeReviews = reviews.filter(e => !superseded.has(e.eventId));
  const withdrawn = history.events.some(e => e.eventKind === 'relation_withdrawn' && e.relationRevisionId === revision.eventId);
  const choices = new Set(activeReviews.map(e => e.choice));
  const opinionStatus = withdrawn ? 'withdrawn' as const : choices.size > 1 ? 'disputed' as const : choices.has('accept') ? 'accepted' as const : choices.has('reject') ? 'rejected' as const : 'pending' as const;
  return { revision, activeReviews, withdrawn, opinionStatus };
}
