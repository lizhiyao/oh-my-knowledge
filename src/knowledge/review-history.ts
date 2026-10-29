import type { KnowledgeAssociationRevision } from './associations.js';
import { type KnowledgeActor, type KnowledgeRevision } from './contracts.js';
import { canonicalJson } from './store.js';
import { KnowledgeReviewActorSchema, KnowledgeReviewEnvelopeSchema, KnowledgeReviewEventSchema, KnowledgeReviewWriteSchema, knowledgeReviewSources, sameReviewBody,
  type KnowledgeReviewEnvelope, type KnowledgeReviewEvent, type KnowledgeReviewWrite } from './reviews.js';

function sameContext(a: KnowledgeReviewEvent, b: KnowledgeReviewEvent): boolean {
  return a.eventKind === b.eventKind && sameReviewBody(a.bodyRef, b.bodyRef)
    && (a.eventKind !== 'association_coverage' || b.eventKind === 'association_coverage' && a.projectionRevisionId === b.projectionRevisionId)
    && (a.eventKind !== 'task_use' || b.eventKind === 'task_use' && a.taskRef === b.taskRef && a.signal === b.signal);
}
export function validateKnowledgeReviewHistory(history: KnowledgeReviewEnvelope): void {
  if (history.events.length !== history.generation || history.receipts.length !== history.generation
    || history.writeHeadEventId !== history.events.at(-1)?.eventId) throw new Error('Invalid knowledge review head.');
  const prior = new Map<string, KnowledgeReviewEvent>(), requests = new Set<string>(), superseded = new Set<string>();
  for (const [index, event] of history.events.entries()) {
    const receipt = history.receipts[index];
    if (event.bodyRef.knowledgeId !== history.knowledgeId || event.parentEventId !== (history.events[index - 1]?.eventId ?? null)
      || prior.has(event.eventId) || requests.has(receipt.requestId) || receipt.eventId !== event.eventId || receipt.requestId !== event.eventId
      || receipt.committedGeneration !== index + 1 || new Set(event.supersedesEventIds).size !== event.supersedesEventIds.length) throw new Error('Invalid knowledge review history references.');
    for (const target of event.supersedesEventIds) {
      const previous = prior.get(target);
      if (!previous || superseded.has(target) || !sameContext(event, previous)) throw new Error('Invalid knowledge review supersession.');
      superseded.add(target);
    }
    prior.set(event.eventId, event); requests.add(receipt.requestId);
  }
}
/** All expected references are exact; source membership never comes from names or the current head. */
export function validateKnowledgeReviewBodyReferences(command: KnowledgeReviewWrite | KnowledgeReviewEvent, body: KnowledgeRevision): void {
  if (!sameReviewBody(command.bodyRef, body)) throw new Error('Knowledge review body identity conflict.');
  const expected = knowledgeReviewSources(body).map(canonicalJson).sort(), supplied = command.sources.map(canonicalJson).sort();
  if (canonicalJson(expected) !== canonicalJson(supplied)) throw new Error('Knowledge review source identity conflict.');
  const segments = new Set(body.content.segments.map(segment => segment.segmentId));
  if (command.eventKind === 'content_review') {
    if (command.findings.some(finding => finding.segmentIds.some(id => !segments.has(id)))) throw new Error('Unknown content finding segment.');
    if (command.findings.some(finding => finding.evidence.some(evidence => !expected.includes(canonicalJson(evidence.source))))) throw new Error('Content review evidence is outside the pinned body sources.');
  } else if (command.eventKind === 'task_use') {
    if (command.segmentIds.some(id => !segments.has(id))) throw new Error('Unknown consumed body segment.');
  } else if (command.decisions.length !== segments.size || command.decisions.some(decision => !segments.has(decision.segmentId))) throw new Error('Coverage must explicitly decide every exact body segment.');
}
export function validateKnowledgeReviewReferences(command: KnowledgeReviewWrite | KnowledgeReviewEvent, body: KnowledgeRevision, projection?: KnowledgeAssociationRevision): void {
  validateKnowledgeReviewBodyReferences(command, body);
  if (command.eventKind === 'association_coverage') {
    if (command.projectionRevisionId === null ? !!projection : !projection || projection.revisionId !== command.projectionRevisionId || !sameReviewBody(projection.bodyRef, command.bodyRef)) throw new Error('Knowledge coverage projection identity conflict.');
    for (const decision of command.decisions) for (const ref of decision.entityRefs) {
      if (projection?.status !== 'available' || !projection.segmentEntityRefs.some(mapping => mapping.segmentId === decision.segmentId
        && mapping.analysisId === ref.analysisId && mapping.entityRevisionId === ref.entityRevisionId && mapping.entityId === ref.entityId
        && ref.mentionIds.every(id => mapping.mentionIds.includes(id)))) throw new Error('Coverage entity or mention is outside the exact projection.');
    }
  }
}
export function applyKnowledgeReviewWrite(existing: KnowledgeReviewEnvelope | undefined, input: KnowledgeReviewWrite, actorInput: KnowledgeActor,
  namespace: string, commandDigest: string, at: string): KnowledgeReviewEnvelope {
  const command = KnowledgeReviewWriteSchema.parse(input), actor = KnowledgeReviewActorSchema.parse(actorInput);
  if (existing) {
    validateKnowledgeReviewHistory(existing);
    if (existing.namespace !== namespace || existing.knowledgeId !== command.bodyRef.knowledgeId) throw new Error('Knowledge review identity conflict.');
    const receipt = existing.receipts.find(receipt => receipt.requestId === command.requestId);
    if (receipt) {
      if (receipt.commandDigest !== commandDigest) throw new Error('Knowledge review idempotency conflict.');
      return existing;
    }
  }
  if ((existing?.generation ?? 0) !== command.expectedGeneration || (existing?.writeHeadEventId ?? null) !== command.expectedHeadEventId) throw new Error('Knowledge review revision conflict.');
  const { requestId, expectedGeneration, expectedHeadEventId, ...decision } = command;
  const event = KnowledgeReviewEventSchema.parse({ ...decision, eventId: requestId, parentEventId: expectedHeadEventId, actor, at });
  const next = KnowledgeReviewEnvelopeSchema.parse({ storeKind: 'knowledge-review-history', schemaVersion: 1, namespace, knowledgeId: command.bodyRef.knowledgeId,
    generation: expectedGeneration + 1, writeHeadEventId: event.eventId, events: [...(existing?.events ?? []), event],
    receipts: [...(existing?.receipts ?? []), { requestId, commandDigest, committedGeneration: expectedGeneration + 1, eventId: event.eventId }] });
  validateKnowledgeReviewHistory(next); return next;
}
