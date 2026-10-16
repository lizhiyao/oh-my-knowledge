import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KnowledgeActorSchema, type KnowledgeActor } from '../../knowledge/contracts.js';
import type { EntityAnalysisStore } from '../../knowledge/entities/contracts.js';
import { EntityLinkCaptureSchema, EntityLinkEndpointSchema, EntityLinkConflictError, entityLinkAdmission, entityLinkPairKey,
  type EntityLinkCapture, type EntityLinkEndpoint, type EntityLinkEvent, type EntityLinkReview, type EntityLinkStore } from '../../knowledge/entities/links.js';
import { memberKey, type LibraryEnvelope, type LibraryStore, type LibraryWrite } from '../../knowledge/library/contracts.js';
import { LibraryWriteCapacityError, LibraryReferentKindConflictError } from '../../knowledge/library/write-errors.js';
import { entityLinkDigest } from './entity-link-hash.js';
import { canonicalJson } from '../../knowledge/store.js';
import type { KnowledgeApplication } from './application.js';
import { KnowledgeLibraryApplication } from './library.js';
import { currentEntityLinkSource } from './entity-link-source.js';

const reference = z.strictObject({ analysisId: z.string().uuid(), entityId: z.string().uuid(), mentionIds: z.array(z.string().uuid()).min(1).max(64).optional() });
const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ reviewId: z.string().uuid(), requestId: z.string().uuid(), expectedGeneration: z.number().int().positive(), decision: z.literal('accept'), reason: z.string().trim().min(1).max(4096), identityConfirmed: z.literal(true), objectLabel: z.string().trim().min(1).max(256).optional() }),
  z.strictObject({ reviewId: z.string().uuid(), requestId: z.string().uuid(), expectedGeneration: z.number().int().positive(), decision: z.literal('reject'), reason: z.string().trim().min(1).max(4096) }),
]);
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const decisionOf = (review: EntityLinkReview) => review.events.find((event): event is Extract<EntityLinkEvent, { eventKind: 'reviewed' }> => event.eventKind === 'reviewed');
const suppressesPair = (review: EntityLinkReview) => review.duplicateOf === null && (decisionOf(review)?.decision === 'reject'
  || !review.events.some(event => ['applied', 'conflict'].includes(event.eventKind)));
const ownerOf = (all: readonly LibraryEnvelope[], entity: Pick<EntityLinkEndpoint, 'analysisId' | 'entityId'>): EntityLinkEndpoint['owner'] => {
  const owners = all.filter(history => history.revisions.at(-1)!.draft.members.some(member => memberKey(member) === memberKey(entity)));
  if (owners.length > 1) throw new EntityLinkConflictError('owner_conflict');
  return owners[0] ? { objectId: owners[0].objectId, generation: owners[0].generation, headRevisionId: owners[0].writeHeadRevisionId } : null;
};

/** Explicit cross-window organization. Captures, human judgment and application are separate facts. */
export class EntityLinkApplication {
  private readonly actor: Extract<KnowledgeActor, { actorKind: 'human' }>;
  constructor(private readonly knowledge: KnowledgeApplication, private readonly entities: EntityAnalysisStore,
    private readonly reviews: EntityLinkStore, private readonly library: LibraryStore,
    actor: KnowledgeActor = { actorKind: 'human', actorId: 'local-user' },
    private readonly id: () => string = randomUUID, private readonly now: () => string = () => new Date().toISOString()) {
    KnowledgeActorSchema.parse(actor);
    if (actor.actorKind !== 'human') throw new Error('Entity links require an explicit human decision.');
    this.actor = actor;
  }
  list() { return this.reviews.list(); }
  read(reviewId: string) { return this.reviews.read(reviewId); }

  recall(input: z.input<typeof reference>) {
    const selected = reference.parse(input); const source = this.knowledge.entityDetail(selected.analysisId, selected.entityId);
    const keys = new Set([source.entity.label, ...source.revision.mentions.filter(mention => mention.entityId === selected.entityId).map(mention => mention.selection.quote)].map(normalize));
    const histories = this.entities.list(); const all = this.library.list(); const reviewed = this.reviews.list();
    const left = { ...selected, entityRevisionId: source.revision.revisionId, snapshotId: source.history.snapshotId, sourceVersion: source.history.sourceVersion };
    const rows = histories.histories.flatMap(history => history.analysisId === selected.analysisId ? [] : history.revisions.at(-1)!.entities.flatMap(entity => {
      const revision = history.revisions.at(-1)!;
      const names = [entity.label, ...revision.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.selection.quote)];
      if (!names.some(name => keys.has(normalize(name)))) return [];
      const right = { analysisId: history.analysisId, entityId: entity.entityId, entityRevisionId: revision.revisionId, snapshotId: history.snapshotId, sourceVersion: history.sourceVersion };
      const pairKey = entityLinkPairKey(left, right, entityLinkDigest);
      if (reviewed.some(review => review.pairKey === pairKey && suppressesPair(review))) return [];
      const owner = ownerOf(all, right), selectedOwner = ownerOf(all, left);
      if (owner && owner.objectId === selectedOwner?.objectId) return [];
      return [{ ...right, label: entity.label, description: entity.description, referentKind: entity.referentKind, identityStatus: entity.identityStatus,
        sourceStatus: this.knowledge.source(history.snapshotId, history.sourceVersion).status, ownerConflict: !!owner && !!selectedOwner && owner.objectId !== selectedOwner.objectId }];
    })).sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
    if (rows.length > 100) throw new Error('Entity-link candidate capacity exceeded. Choose a more specific source entity.');
    return { retrievalPolicy: 'entity-link-retrieval/v1' as const, rows, unavailableAnalyses: histories.unavailable };
  }

  preview(leftInput: z.input<typeof reference>, rightInput: z.input<typeof reference>) {
    return this.reviews.transaction(transaction => {
      const all = transaction.library.list();
      const endpoint = (input: z.input<typeof reference>) => {
        const selected = reference.parse(input); const detail = this.knowledge.entityDetail(selected.analysisId, selected.entityId);
        return EntityLinkEndpointSchema.parse({ analysisId: selected.analysisId, entityId: selected.entityId, entityRevisionId: detail.revision.revisionId,
          generation: detail.history.generation, snapshotId: detail.history.snapshotId, sourceVersion: detail.history.sourceVersion,
          owner: ownerOf(all, selected), mentionIds: selected.mentionIds ?? detail.revision.mentions.filter(mention => mention.entityId === selected.entityId).map(mention => mention.mentionId) });
      };
      const left = endpoint(leftInput), right = endpoint(rightInput);
      if (left.analysisId === right.analysisId) throw new Error('Select two different source windows.');
      const input = this.input(left, right);
      const prior = transaction.list().find(review => review.pairKey === entityLinkPairKey(left, right, entityLinkDigest)
        && suppressesPair(review));
      if (prior) throw new Error('Entity-link pair already reviewed or pending.');
      if (left.owner && right.owner) throw new EntityLinkConflictError('owner_conflict');
      return { reviewId: this.id(), left, right, input, inputDigest: entityLinkDigest(input) };
    });
  }
  private input(left: EntityLinkEndpoint, right: EntityLinkEndpoint, requireCurrent = true) {
    const source = (endpoint: EntityLinkEndpoint) => {
      // Recording a completed capture must retain its old input even after source deletion or later corrections.
      const history = this.entities.read(endpoint.analysisId);
      const revision = history.revisions.find(revision => revision.revisionId === endpoint.entityRevisionId);
      const entity = revision?.entities.find(entity => entity.entityId === endpoint.entityId);
      if (!revision || !entity || history.snapshotId !== endpoint.snapshotId || history.sourceVersion !== endpoint.sourceVersion
        || history.revisions.indexOf(revision) + 1 !== endpoint.generation
        || endpoint.mentionIds.some(id => !revision.mentions.some(mention => mention.mentionId === id && mention.entityId === endpoint.entityId))) throw new Error('Entity-link captured revision mismatch.');
      if (requireCurrent) currentEntityLinkSource(this.knowledge, endpoint);
      return { binding: endpoint, entity,
        mentions: revision.mentions.filter(mention => endpoint.mentionIds.includes(mention.mentionId)), limitations: revision.limitations };
    };
    const input = { protocolId: 'entity-link-model-input/v1', left: source(left), right: source(right) };
    if (Buffer.byteLength(canonicalJson(input)) > 256 * 1024) throw new Error('Entity-link input capacity exceeded. Choose fewer source mentions.');
    return input;
  }
  record(input: EntityLinkCapture): EntityLinkReview {
    const capture = EntityLinkCaptureSchema.parse(input);
    return this.reviews.transaction(transaction => {
      const allReviews = transaction.list(); const previous = allReviews.find(review => review.capture.reviewId === capture.reviewId);
      if (previous) {
        if (entityLinkDigest(previous.capture) !== entityLinkDigest(capture)) throw new Error('Entity-link request identity conflict.');
        return previous;
      }
      if (allReviews.some(review => review.capture.requestId === capture.requestId)) throw new Error('Entity-link request identity conflict.');
      const pairKey = entityLinkPairKey(capture.left, capture.right, entityLinkDigest);
      const duplicateOf = allReviews.find(review => review.pairKey === pairKey && suppressesPair(review))?.capture.reviewId ?? null;
      if (capture.inputDigest !== entityLinkDigest(this.input(capture.left, capture.right, false))) throw new Error('Entity-link captured input conflict.');
      const event: EntityLinkEvent = { eventKind: 'recorded', eventId: this.id(), requestId: capture.requestId,
        commandDigest: entityLinkDigest({ capture, duplicateOf }), at: this.now(), actor: this.actor };
      const review: EntityLinkReview = { storeKind: 'entity-link-review-history', schemaVersion: 1, capture, pairKey, duplicateOf,
        retrievalPolicy: 'entity-link-retrieval/v1', suggestion: entityLinkAdmission(capture), generation: 1, writeHeadEventId: event.eventId, events: [event] };
      transaction.create(review); return review;
    });
  }
  decide(input: z.input<typeof decisionSchema>): EntityLinkReview {
    const command = decisionSchema.parse(input);
    const objectLabel = command.decision === 'accept' ? command.objectLabel ?? null : null;
    const commandDigest = entityLinkDigest({ reviewId: command.reviewId, requestId: command.requestId, decision: command.decision, reason: command.reason, objectLabel, actor: this.actor });
    const review = this.reviews.transaction(transaction => {
      const current = transaction.read(command.reviewId);
      const previous = current.events.find(event => event.requestId === command.requestId);
      if (previous) { if (previous.commandDigest !== commandDigest) throw new Error('Entity-link decision identity conflict.'); return current; }
      if (current.generation !== command.expectedGeneration || decisionOf(current)) throw new Error('Entity-link revision conflict.');
      let applicationIntent: LibraryWrite | null = null;
      let conflict: EntityLinkConflictError | undefined;
      if (command.decision === 'accept') {
        if (current.suggestion.status !== 'admitted') throw new Error('Invalid entity-link suggestion cannot be accepted.');
        try {
          if (current.duplicateOf) throw new EntityLinkConflictError('pair_already_reviewed');
          applicationIntent = this.intent(current, transaction.library, command.reason, objectLabel);
        }
        catch (error) { if (!(error instanceof EntityLinkConflictError)) throw error; conflict = error; }
      }
      const event: Extract<EntityLinkEvent, { eventKind: 'reviewed' }> = { eventKind: 'reviewed', eventId: this.id(), requestId: command.requestId,
        commandDigest, at: this.now(), actor: this.actor, decision: command.decision, reason: command.reason, objectLabel, applicationIntent };
      return transaction.append(command.reviewId, current.generation, [event, ...(conflict ? [this.conflict(conflict, event)] : [])]);
    });
    return decisionOf(review)?.decision === 'accept' ? this.resume(command.reviewId) : review;
  }
  private conflict(error: EntityLinkConflictError, decision: Extract<EntityLinkEvent, { eventKind: 'reviewed' }>): EntityLinkEvent {
    return { eventKind: 'conflict', eventId: this.id(), requestId: decision.applicationIntent?.requestId ?? this.id(), at: this.now(), actor: decision.actor,
      conflictCode: error.conflictCode, commandDigest: entityLinkDigest({ conflictCode: error.conflictCode, decisionRequestId: decision.requestId }) };
  }
  private intent(review: EntityLinkReview, library: LibraryStore, reason: string, objectLabel: string | null): LibraryWrite {
    const endpoints = [review.capture.left, review.capture.right]; const all = library.list();
    const sources = endpoints.map(endpoint => currentEntityLinkSource(this.knowledge, endpoint));
    if (sources.some(source => source.entity.identityStatus !== 'proposed' || source.entity.referentKind !== sources[0].entity.referentKind)) throw new EntityLinkConflictError('identity_unresolved');
    for (const endpoint of endpoints) if (canonicalJson(ownerOf(all, endpoint)) !== canonicalJson(endpoint.owner)) throw new EntityLinkConflictError('owner_conflict');
    const owners = [...new Set(endpoints.flatMap(endpoint => endpoint.owner ? [endpoint.owner.objectId] : []))];
    if (owners.length > 1 || (endpoints[0].owner && endpoints[0].owner.objectId === endpoints[1].owner?.objectId)) throw new EntityLinkConflictError('owner_conflict');
    const owner = all.find(history => history.objectId === owners[0]); const draft = owner?.revisions.at(-1)!.draft;
    if (draft && draft.referentKind !== sources[0].entity.referentKind) throw new EntityLinkConflictError('identity_unresolved');
    if (draft && objectLabel && objectLabel !== draft.label) throw new Error('Existing organization label must be maintained separately.');
    const label = objectLabel ?? draft?.label ?? sources[0].entity.label;
    if (label.length > 256) throw new Error('Choose an explicit organization label of at most 256 characters.');
    return { requestId: this.id(), objectId: owner?.objectId ?? this.id(), expectedGeneration: owner?.generation ?? 0, expectedHeadRevisionId: owner?.writeHeadRevisionId ?? null,
      revision: { revisionId: this.id(), ...(owner ? { parentRevisionId: owner.writeHeadRevisionId } : {}), revisedAt: this.now(), revisedBy: this.actor, reason,
        draft: { label, description: draft?.description ?? sources[0].entity.description,
          referentKind: sources[0].entity.referentKind,
          members: [...(draft?.members.filter(member => !endpoints.some(endpoint => memberKey(endpoint) === memberKey(member))) ?? []),
            ...endpoints.map(endpoint => ({ analysisId: endpoint.analysisId, entityId: endpoint.entityId, entityRevisionId: endpoint.entityRevisionId, mentionIds: endpoint.mentionIds, rationale: reason }))] } } };
  }
  resume(reviewId: string): EntityLinkReview {
    return this.reviews.transaction(transaction => {
      const review = transaction.read(reviewId); const decision = decisionOf(review);
      if (!decision || decision.decision !== 'accept' || review.events.some(event => ['applied', 'conflict'].includes(event.eventKind))) return review;
      const intent = decision.applicationIntent!;
      try {
        const library = new KnowledgeLibraryApplication(this.knowledge, transaction.library, decision.actor, this.id, this.now);
        const applied = library.applyLinkIntent(intent, [review.capture.left, review.capture.right]);
        const receipt = applied.receipts.find(receipt => receipt.requestId === intent.requestId)!;
        return transaction.append(reviewId, review.generation, [{ eventKind: 'applied', eventId: this.id(), requestId: intent.requestId,
          commandDigest: entityLinkDigest(receipt), at: this.now(), actor: decision.actor, receipt }]);
      } catch (error) {
        const conflict = error instanceof EntityLinkConflictError ? error
          : error instanceof LibraryWriteCapacityError ? new EntityLinkConflictError('library_capacity')
            : error instanceof LibraryReferentKindConflictError ? new EntityLinkConflictError('identity_unresolved')
          : error instanceof Error && ['Library revision conflict.', 'Library idempotency conflict.', 'Library change required.'].includes(error.message) ? new EntityLinkConflictError('library_changed') : undefined;
        if (!conflict) throw error; // Unknown publication/acknowledgement failure stays recoverable.
        return transaction.append(reviewId, review.generation, [this.conflict(conflict, decision)]);
      }
    });
  }
}
