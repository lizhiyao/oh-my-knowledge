import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { KnowledgeActorSchema, type KnowledgeActor } from '../contracts.js';
import type { EntityAnalysisStore } from '../entities/contracts.js';
import { EntityLinkEndpointSchema, EntityLinkConflictError, entityLinkPairKey, type EntityLinkEndpoint } from '../entities/links.js';
import { EntityLinkExecutionRequestSchema, type EntityLinkInvocation, type EntityLinkInvocationCommand, type EntityLinkInvocationPlan,
  type EntityLinkReviewCommand, type EntityLinkInvocationPorts, type EntityLinkInvocationStore, type EntityLinkInvocationTransaction, type EntityLinkExecutionOutcome } from '../entities/link-invocation.js';
import { entityLinkConfirmationDigest, entityLinkEvidenceReplacementDigest, projectEntityLinkInvocation, transitionEntityLinkInvocation, validateEntityLinkPreview } from '../entities/link-invocation-state.js';
import { memberKey, type LibraryEnvelope, type LibraryStore, type LibraryWrite } from '../entity-library/contracts.js';
import { LibraryWriteCapacityError, LibraryReferentKindConflictError } from '../entity-library/write-errors.js';
import { entityLinkDigest } from './entity-link-hash.js';
import { canonicalJson } from '../store.js';
import type { KnowledgeApplication } from '../application/application.js';
import { KnowledgeLibraryApplication } from '../application/library.js';
import { currentEntityLinkSource } from './entity-link-source.js';
import { createEntityLinkExecutionRequest } from '../adapters/entity-link-executor.js';
import type { ExecutorArchiveProducer } from '../../executors/contracts/archive.js';
import { configureEntityLinkApiProducer, inspectEntityLinkApiProducer, entityLinkTextHash } from '../adapters/entity-link-api-producer.js';
import { entityLinkQuality, unreadableEntityLinkQuality } from './entity-link-quality.js';

const reference = z.strictObject({ analysisId: z.string().uuid(), entityId: z.string().uuid(), mentionIds: z.array(z.string().uuid()).min(1).max(64).optional() });
const decisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({ reviewId: z.string().uuid(), requestId: z.string().uuid(), expectedGeneration: z.number().int().positive(), decision: z.literal('accept'), reason: z.string().trim().min(1).max(4096), identityConfirmed: z.literal(true), objectLabel: z.string().trim().min(1).max(256).optional(), replacementConfirmed: z.boolean().optional(),
    replacementConfirmationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }),
  z.strictObject({ reviewId: z.string().uuid(), requestId: z.string().uuid(), expectedGeneration: z.number().int().positive(), decision: z.literal('reject'), reason: z.string().trim().min(1).max(4096) }),
]);
const acceptancePreviewSchema = z.strictObject({ reviewId: z.string().uuid(), expectedGeneration: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4096), objectLabel: z.string().trim().min(1).max(256).optional() });
const terminationSchema = z.strictObject({ reviewId: z.string().uuid(), requestId: z.string().uuid(), expectedGeneration: z.number().int().positive(),
  executionId: z.string().uuid(), ownerId: z.string().uuid(), reason: z.string().trim().min(1).max(4096) });
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const prepared = (review: EntityLinkInvocation) => { const command = review.events[0].command; if (command.commandKind !== 'prepare') throw new Error('Missing preparation.'); return command; };
const decisionOf = (review: EntityLinkInvocation) => review.events.map(event => event.command).find((command): command is EntityLinkReviewCommand => command.commandKind === 'reviewed' || command.commandKind === 'reviewed_v2');
const suppressesPair = (review: EntityLinkInvocation) => {
  const status = projectEntityLinkInvocation(review, { hashJson: entityLinkDigest, hashText: entityLinkTextHash }).status;
  return !['cancelled_before_start', 'accepted_conflict', 'applied', 'execution_failed', 'execution_unknown', 'execution_terminated'].includes(status);
};
const ownerOf = (all: readonly LibraryEnvelope[], entity: Pick<EntityLinkEndpoint, 'analysisId' | 'entityId'>): EntityLinkEndpoint['owner'] => {
  const owners = all.filter(history => history.revisions.at(-1)!.draft.members.some(member => memberKey(member) === memberKey(entity)));
  if (owners.length > 1) throw new EntityLinkConflictError('owner_conflict');
  return owners[0] ? { objectId: owners[0].objectId, generation: owners[0].generation, headRevisionId: owners[0].writeHeadRevisionId } : null;
};
export class EntityLinkArchiveError extends Error {
  constructor(readonly reviewId: string, readonly executionId: string, options: ErrorOptions) { super('Entity-link execution archive acknowledgement is unknown; inspect/resume this review without invoking again.', options); }
}
/** Safe observation of arbitrary JS thrown values: never invoke getters, proxy traps or coercion. */
export function observeEntityLinkException(error: unknown): Extract<EntityLinkExecutionOutcome, { outcomeKind: 'exception' }>['error'] {
  return { representationKind: 'exception-diagnostic/v1', sourceType: typeof error, name: null,
    message: 'Execution threw without an ExecResult; its outcome and usage are unknown.', truncated: true, accessorsSkipped: true };
}

/** Explicit production host. Reads/resume never execute a model; only start may dispatch. */
export class EntityLinkApplication {
  private readonly actor: Extract<KnowledgeActor, { actorKind: 'human' }>;
  private readonly held = new Map<string, { executionId: string; outcome: EntityLinkExecutionOutcome; requestId: string }>();
  constructor(private readonly knowledge: KnowledgeApplication, private readonly entities: EntityAnalysisStore,
    private readonly reviews: EntityLinkInvocationStore, private readonly library: LibraryStore,
    private readonly execution: ExecutorArchiveProducer,
    actor: KnowledgeActor = { actorKind: 'human', actorId: 'local-user' },
    private readonly id: () => string = randomUUID, private readonly now: () => string = () => new Date().toISOString()) {
    KnowledgeActorSchema.parse(actor); if (actor.actorKind !== 'human') throw new Error('Entity links require an explicit human decision.');
    this.actor = actor;
  }
  private at() { return z.iso.datetime({ offset: true }).max(64).parse(this.now()); }
  private integrity = { hashJson: entityLinkDigest, hashText: entityLinkTextHash };
  private ports(configuration?: ReturnType<typeof configureEntityLinkApiProducer>): EntityLinkInvocationPorts {
    return { ...this.integrity, reserve: () => configuration?.reservation,
      reservationIsCurrent: (request, reservation) => !!configuration && request.requestDigest === configuration.reservation.requestDigest && equal(reservation, configuration.reservation),
      proveOwnerExited: owner => {
        if (owner.hostname !== hostname()) return;
        try { process.kill(owner.pid, 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
        return { proofKind: 'local-process-exited', owner, observedAt: this.at() };
      } };
  }
  list() { return this.reviews.list(); }
  quality() {
    try { return entityLinkQuality(this.reviews.list(), this.integrity); }
    catch { return unreadableEntityLinkQuality(); }
  }
  read(reviewId: string) { return this.reviews.read(reviewId); }
  projectHistory(history: EntityLinkInvocation) { return projectEntityLinkInvocation(history, this.integrity); }
  inspect(reviewId: string) { const history = this.read(reviewId); return { history, projection: this.projectHistory(history) }; }
  project(reviewId: string) { return this.inspect(reviewId).projection; }
  private command<T extends object>(reviewId: string, requestId: string, generation: number, body: T, actor: KnowledgeActor = this.actor): EntityLinkInvocationCommand {
    return { reviewId, requestId, eventId: this.id(), at: this.at(), actor, expectedGeneration: generation, ...body } as unknown as EntityLinkInvocationCommand;
  }
  private transition(transaction: EntityLinkInvocationTransaction, previous: EntityLinkInvocation | undefined, command: EntityLinkInvocationCommand, ports = this.ports()) {
    this.knowledge.assertWritable();
    const next = transitionEntityLinkInvocation(previous, command, ports);
    transaction.save(next.history, previous?.generation ?? 0);
    return next;
  }
  recall(input: z.input<typeof reference>) {
    const selected = reference.parse(input), source = this.knowledge.entityDetail(selected.analysisId, selected.entityId);
    const keys = new Set([source.entity.label, ...source.revision.mentions.filter(mention => mention.entityId === selected.entityId).map(mention => mention.selection.quote)].map(normalize));
    const histories = this.entities.list(), all = this.library.list(), reviewed = this.reviews.list();
    const left = { ...selected, entityRevisionId: source.revision.revisionId, snapshotId: source.history.snapshotId, sourceVersion: source.history.sourceVersion };
    const rows = histories.histories.flatMap(history => history.analysisId === selected.analysisId ? [] : history.revisions.at(-1)!.entities.flatMap(entity => {
      const revision = history.revisions.at(-1)!;
      if (![entity.label, ...revision.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.selection.quote)].some(name => keys.has(normalize(name)))) return [];
      const right = { analysisId: history.analysisId, entityId: entity.entityId, entityRevisionId: revision.revisionId, snapshotId: history.snapshotId, sourceVersion: history.sourceVersion };
      if (reviewed.some(review => review.pairKey === entityLinkPairKey(left, right, entityLinkDigest) && suppressesPair(review))) return [];
      const owner = ownerOf(all, right), selectedOwner = ownerOf(all, left);
      if (owner && owner.objectId === selectedOwner?.objectId) return [];
      return [{ ...right, label: entity.label, description: entity.description, referentKind: entity.referentKind, identityStatus: entity.identityStatus,
        sourceStatus: this.knowledge.source({ snapshotId: history.snapshotId, sourceVersion: history.sourceVersion }).status, ownerConflict: !!owner && !!selectedOwner && owner.objectId !== selectedOwner.objectId }];
    })).sort((a, b) => memberKey(a).localeCompare(memberKey(b)));
    if (rows.length > 100) throw new Error('Entity-link candidate capacity exceeded. Choose a more specific source entity.');
    return { retrievalPolicy: 'entity-link-retrieval/v1' as const, rows, unavailableAnalyses: histories.unavailable };
  }
  private input(left: EntityLinkEndpoint, right: EntityLinkEndpoint) {
    const source = (binding: EntityLinkEndpoint) => {
      const detail = currentEntityLinkSource(this.knowledge, binding);
      return { binding, entity: detail.entity, mentions: detail.revision.mentions.filter(mention => binding.mentionIds.includes(mention.mentionId)), limitations: detail.revision.limitations };
    };
    return { protocolId: 'entity-link-model-input/v1' as const, left: source(left), right: source(right) };
  }
  private checkPair(transaction: EntityLinkInvocationTransaction, plan: EntityLinkInvocationPlan, reviewId: string) {
    const all = transaction.library.list();
    for (const endpoint of [plan.left, plan.right]) {
      const detail = currentEntityLinkSource(this.knowledge, endpoint);
      if (!equal(ownerOf(all, endpoint), endpoint.owner)) throw new EntityLinkConflictError('owner_conflict');
      if (detail.entity.identityStatus !== 'proposed') throw new EntityLinkConflictError('identity_unresolved');
    }
    const modelInput = this.input(plan.left, plan.right);
    if (canonicalJson(modelInput) !== plan.request.prompt) throw new EntityLinkConflictError('entity_changed');
    if (plan.left.owner && plan.right.owner) throw new EntityLinkConflictError('owner_conflict');
    if (modelInput.left.entity.referentKind !== modelInput.right.entity.referentKind) throw new EntityLinkConflictError('kind_mismatch');
    const owner = all.find(item => item.objectId === (plan.left.owner ?? plan.right.owner)?.objectId);
    if (owner && owner.revisions[0].draft.referentKind !== modelInput.left.entity.referentKind) throw new EntityLinkConflictError('kind_mismatch');
    const pairKey = entityLinkPairKey(plan.left, plan.right, entityLinkDigest);
    const others = transaction.list().filter(item => item.reviewId !== reviewId);
    if (others.some(item => item.pairKey === pairKey && suppressesPair(item))) throw new EntityLinkConflictError('pair_already_reviewed');
    const samePair = others.filter(item => item.pairKey === pairKey);
    if (!plan.retryOf && samePair.some(item => ['execution_failed', 'execution_unknown', 'execution_terminated'].includes(projectEntityLinkInvocation(item, this.integrity).status))) throw new Error('Explicit retryOf and renewed confirmation are required for a failed or unknown invocation.');
    const prior = plan.retryOf ? others.find(item => item.reviewId === plan.retryOf) : undefined;
    if (plan.retryOf && (!prior || prior.pairKey !== pairKey || ['prepared', 'running'].includes(projectEntityLinkInvocation(prior, this.integrity).status))) throw new Error('Entity-link retry predecessor conflict.');
    if (others.some(item => ['prepared', 'running'].includes(projectEntityLinkInvocation(item, this.integrity).status))) throw new Error('Another entity-link invocation owns the workspace reservation.');
  }
  preview(leftInput: z.input<typeof reference>, rightInput: z.input<typeof reference>, selection: { executor: string; model: string }, retryOf: string | null = null) {
    return this.reviews.transaction(transaction => {
      const all = transaction.library.list();
      const endpoint = (input: z.input<typeof reference>) => {
        const selected = reference.parse(input), detail = this.knowledge.entityDetail(selected.analysisId, selected.entityId);
        return EntityLinkEndpointSchema.parse({ analysisId: selected.analysisId, entityId: selected.entityId, entityRevisionId: detail.revision.revisionId,
          generation: detail.history.generation, snapshotId: detail.history.snapshotId, sourceVersion: detail.history.sourceVersion, owner: ownerOf(all, selected),
          mentionIds: selected.mentionIds ?? detail.revision.mentions.filter(mention => mention.entityId === selected.entityId).map(mention => mention.mentionId) });
      };
      const left = endpoint(leftInput), right = endpoint(rightInput), reviewId = this.id();
      if (left.analysisId === right.analysisId) throw new Error('Select two different source windows.');
      const input = this.input(left, right), request = EntityLinkExecutionRequestSchema.parse(createEntityLinkExecutionRequest(selection, input));
      const producerContext = inspectEntityLinkApiProducer(request, this.execution);
      const body = { left, right, request, producerContextDigest: producerContext.reservationDigest, retryOf }, plan: EntityLinkInvocationPlan = { ...body, confirmedDigest: entityLinkConfirmationDigest(reviewId, body, entityLinkDigest) };
      this.checkPair(transaction, plan, reviewId);
      return validateEntityLinkPreview({ reviewId, requestId: this.id(), startRequestId: this.id(), input, plan, producerContext }, this.integrity);
    });
  }
  prepare(input: { reviewId: string; requestId: string; plan: EntityLinkInvocationPlan; confirmDigest: string }) {
    if (input.confirmDigest !== input.plan.confirmedDigest) throw new Error('Explicit content/model confirmation required.');
    const existing = this.reviews.transaction(transaction => {
      const previous = transaction.list().find(item => item.reviewId === input.reviewId);
      return previous ? this.transition(transaction, previous, this.command(input.reviewId, input.requestId, 0, { commandKind: 'prepare', input: input.plan })).history : undefined;
    });
    if (existing) return existing;
    const configuration = configureEntityLinkApiProducer(input.plan.request, this.execution);
    if (configuration.reservation.reservationDigest !== input.plan.producerContextDigest) throw new Error('Confirmed producer context changed before preparation.');
    return this.reviews.transaction(transaction => {
      const previous = transaction.list().find(item => item.reviewId === input.reviewId);
      const command = this.command(input.reviewId, input.requestId, 0, { commandKind: 'prepare', input: input.plan });
      if (previous) return this.transition(transaction, previous, command, this.ports(configuration)).history;
      this.checkPair(transaction, input.plan, input.reviewId);
      return this.transition(transaction, undefined, command, this.ports(configuration)).history;
    });
  }
  async start(input: { reviewId: string; requestId: string; expectedGeneration: number }, signal?: AbortSignal): Promise<EntityLinkInvocation> {
    const snapshot = this.read(input.reviewId), plan = prepared(snapshot).input;
    if (projectEntityLinkInvocation(snapshot, this.integrity).status !== 'prepared') return this.reviews.transaction(transaction => {
      const current = transaction.read(input.reviewId); return transaction.save(current, current.generation);
    });
    const configuration = configureEntityLinkApiProducer(plan.request, this.execution);
    const claimed = this.reviews.transaction(transaction => {
      const current = transaction.read(input.reviewId);
      if (projectEntityLinkInvocation(current, this.integrity).status !== 'prepared') return { history: transaction.save(current, current.generation), effect: 'none' as const };
      this.checkPair(transaction, plan, input.reviewId);
      const command = this.command(input.reviewId, input.requestId, input.expectedGeneration, { commandKind: 'start', executionId: this.id(), owner: { ownerId: this.id(), hostname: hostname(), pid: process.pid } },
        { actorKind: 'agent', actorId: 'local-entity-link-host', executionRef: input.reviewId });
      return this.transition(transaction, current, command, this.ports(configuration));
    });
    if (claimed.effect !== 'dispatch_once') return claimed.history;
    const started = claimed.history.events.at(-1)!.command;
    if (started.commandKind !== 'start') throw new Error('Missing dispatch receipt.');
    let outcome: EntityLinkExecutionOutcome;
    try {
      const returned = await configuration.execute(signal);
      outcome = returned.outcomeKind === 'result' ? returned as unknown as EntityLinkExecutionOutcome : { ...returned, error: observeEntityLinkException(returned.error) };
    } catch (error) { outcome = { outcomeKind: 'exception', error: observeEntityLinkException(error) }; }
    this.held.set(input.reviewId, { executionId: started.executionId, outcome, requestId: this.id() });
    try { return this.archiveHeld(input.reviewId); }
    catch (cause) { throw new EntityLinkArchiveError(input.reviewId, started.executionId, { cause }); }
  }
  private archiveHeld(reviewId: string): EntityLinkInvocation {
    const held = this.held.get(reviewId);
    if (!held) return this.read(reviewId);
    const saved = this.reviews.transaction(transaction => {
      const current = transaction.read(reviewId);
      return this.transition(transaction, current, this.command(reviewId, held.requestId, current.generation,
        { commandKind: 'execution_recorded', executionId: held.executionId, outcome: held.outcome }, { actorKind: 'agent', actorId: 'local-entity-link-host', executionRef: reviewId })).history;
    });
    this.held.delete(reviewId); return saved;
  }
  cancelBeforeStart(input: { reviewId: string; requestId: string; expectedGeneration: number; reason: string }) {
    return this.reviews.transaction(transaction => this.transition(transaction, transaction.read(input.reviewId),
      this.command(input.reviewId, input.requestId, input.expectedGeneration, { commandKind: 'cancel_before_start', reason: input.reason })).history);
  }
  /** Human administrative fence; no source, producer configuration, or process-exit proof is consulted. */
  terminateExecution(input: z.input<typeof terminationSchema>): EntityLinkInvocation {
    const request = terminationSchema.parse(input);
    return this.reviews.transaction(transaction => {
      const current = transaction.read(request.reviewId), started = current.events.find(event => event.command.commandKind === 'start')?.command;
      if (started?.commandKind !== 'start' || started.executionId !== request.executionId || started.owner.ownerId !== request.ownerId) {
        throw new Error('Entity-link termination execution/owner conflict.');
      }
      return this.transition(transaction, current, this.command(request.reviewId, request.requestId, request.expectedGeneration, {
        commandKind: 'execution_terminated', terminationVersion: 'omk.entity-link-termination/v1', executionId: request.executionId, owner: started.owner, reason: request.reason,
      })).history;
    });
  }
  recoverUnknown(reviewId: string, requestId: string) {
    return this.reviews.transaction(transaction => {
      const current = transaction.read(reviewId), start = current.events.find(event => event.command.commandKind === 'start')?.command;
      if (projectEntityLinkInvocation(current, this.integrity).status !== 'running' || start?.commandKind !== 'start') return transaction.save(current, current.generation);
      return this.transition(transaction, current, this.command(reviewId, requestId, current.generation, { commandKind: 'execution_unknown', executionId: start.executionId })).history;
    });
  }
  /** Read-only replacement preview. Both preview and acceptance hold the same workspace/library lock. */
  acceptPreview(input: z.input<typeof acceptancePreviewSchema>) {
    const request = acceptancePreviewSchema.parse(input);
    return this.reviews.transaction(transaction => {
      const review = transaction.read(request.reviewId);
      if (review.generation !== request.expectedGeneration) throw new Error('Entity-link acceptance revision conflict.');
      if (this.projectHistory(review).status !== 'awaiting_review') throw new Error('An admitted response awaiting review is required.');
      return this.acceptance(review, transaction.library, request.reason, request.objectLabel ?? null).preview;
    });
  }
  private acceptance(review: EntityLinkInvocation, library: LibraryStore, reason: string, objectLabel: string | null) {
    const intent = this.intent(review, library, reason, objectLabel), plan = prepared(review).input;
    const owner = plan.left.owner ?? plan.right.owner;
    const previous = owner ? library.read(owner.objectId).revisions.at(-1)!.draft : undefined;
    const endpoints = [plan.left, plan.right];
    const before = endpoints.flatMap(endpoint => previous?.members.filter(member => memberKey(member) === memberKey(endpoint)) ?? []);
    const changes = before.flatMap(member => {
      const after = intent.revision.draft.members.find(value => memberKey(value) === memberKey(member))!;
      if (equal(member, after)) return [];
      const revisionChanged = member.entityRevisionId !== after.entityRevisionId;
      return [{ before: member, after, revisionChanged,
        mentionComparison: revisionChanged ? 'different-entity-revisions' as const : 'same-entity-revision' as const,
        removedMentionIds: member.mentionIds.filter(id => revisionChanged || !after.mentionIds.includes(id)),
        addedMentionIds: after.mentionIds.filter(id => revisionChanged || !member.mentionIds.includes(id)) }];
    });
    const previousMembersDigest = entityLinkDigest(before);
    const confirmationDigest = changes.length ? entityLinkEvidenceReplacementDigest(review.reviewId, review.generation, plan, reason,
      objectLabel, intent.revision.draft.label, previousMembersDigest, this.actor, entityLinkDigest) : null;
    return { intent, previousMembersDigest, preview: { previewVersion: 'omk.entity-link-accept-preview/v1' as const,
      reviewId: review.reviewId, expectedGeneration: review.generation, left: plan.left, right: plan.right, owner,
      reason, objectLabel, organizationLabel: intent.revision.draft.label, changes, replacementRequired: changes.length > 0, confirmationDigest } };
  }
  decide(input: z.input<typeof decisionSchema>) {
    const command = decisionSchema.parse(input), objectLabel = command.decision === 'accept' ? command.objectLabel ?? null : null;
    const saved = this.reviews.transaction(transaction => {
      const current = transaction.read(command.reviewId), previous = decisionOf(current);
      // An exact acknowledged request wins before source/capacity/CAS checks, including legacy pending recovery.
      if (previous && previous.requestId === command.requestId) {
        const receipt = previous.commandKind === 'reviewed_v2' ? previous.evidenceReplacement : null;
        if (previous.decision !== command.decision || previous.reason !== command.reason || previous.objectLabel !== objectLabel || !equal(previous.actor, this.actor)
          || command.decision === 'accept' && ((command.replacementConfirmationDigest ?? null) !== (receipt?.confirmedDigest ?? null)
            || !!command.replacementConfirmed !== !!receipt)) throw new Error('Entity-link decision identity conflict.');
        return transaction.save(current, current.generation);
      }
      if (current.generation !== command.expectedGeneration) throw new Error('Entity-link acceptance revision conflict.');
      let application: Extract<EntityLinkInvocationCommand, { commandKind: 'reviewed_v2' }>['application'] = null;
      let evidenceReplacement: Extract<EntityLinkInvocationCommand, { commandKind: 'reviewed_v2' }>['evidenceReplacement'] = null;
      if (command.decision === 'accept') {
        try {
          const checked = this.acceptance(current, transaction.library, command.reason, objectLabel);
          if (checked.preview.replacementRequired) {
            if (!command.replacementConfirmed || command.replacementConfirmationDigest !== checked.preview.confirmationDigest) throw new Error('Explicit evidence replacement confirmation required; read accept-preview again.');
            evidenceReplacement = { confirmationVersion: 'omk.entity-link-evidence-replacement/v1', confirmedDigest: checked.preview.confirmationDigest!,
              previousMembersDigest: checked.previousMembersDigest };
          } else if (command.replacementConfirmed || command.replacementConfirmationDigest) throw new Error('Evidence replacement confirmation does not match this acceptance.');
          application = { applicationKind: 'intent', intent: checked.intent };
        } catch (error) {
          if (!(error instanceof EntityLinkConflictError)) throw error;
          if (command.replacementConfirmed || command.replacementConfirmationDigest) throw new Error('Evidence replacement preview is stale; read accept-preview again.');
          application = { applicationKind: 'conflict', conflictCode: error.conflictCode };
        }
      }
      return this.transition(transaction, current, this.command(command.reviewId, command.requestId, command.expectedGeneration,
        { commandKind: 'reviewed_v2', reviewVersion: 'omk.entity-link-review/v2', decision: command.decision,
          reason: command.reason, objectLabel, identityConfirmed: command.decision === 'accept', evidenceReplacement, application })).history;
    });
    return command.decision === 'accept' ? this.resume(saved.reviewId) : saved;
  }
  private intent(review: EntityLinkInvocation, library: LibraryStore, reason: string, objectLabel: string | null): LibraryWrite {
    const plan = prepared(review).input, endpoints = [plan.left, plan.right], all = library.list();
    const sources = endpoints.map(endpoint => currentEntityLinkSource(this.knowledge, endpoint));
    if (sources.some(source => source.entity.identityStatus !== 'proposed')) throw new EntityLinkConflictError('identity_unresolved');
    if (sources.some(source => source.entity.referentKind !== sources[0].entity.referentKind)) throw new EntityLinkConflictError('kind_mismatch');
    for (const endpoint of endpoints) if (!equal(ownerOf(all, endpoint), endpoint.owner)) throw new EntityLinkConflictError('owner_conflict');
    if (plan.left.owner && plan.right.owner) throw new EntityLinkConflictError('owner_conflict');
    const owner = all.find(item => item.objectId === (plan.left.owner ?? plan.right.owner)?.objectId), draft = owner?.revisions.at(-1)!.draft;
    if (owner && owner.revisions[0].draft.referentKind !== sources[0].entity.referentKind) throw new EntityLinkConflictError('kind_mismatch');
    if (draft && objectLabel && objectLabel !== draft.label) throw new Error('Existing organization label must be maintained separately.');
    const label = objectLabel ?? draft?.label ?? sources[0].entity.label;
    if (label.length > 256) throw new Error('Choose an explicit organization label of at most 256 characters.');
    return { requestId: this.id(), objectId: owner?.objectId ?? this.id(), expectedGeneration: owner?.generation ?? 0, expectedHeadRevisionId: owner?.writeHeadRevisionId ?? null,
      revision: { revisionId: this.id(), ...(owner ? { parentRevisionId: owner.writeHeadRevisionId } : {}), revisedAt: this.at(), revisedBy: this.actor, reason,
        draft: { label, description: draft?.description ?? sources[0].entity.description, referentKind: sources[0].entity.referentKind,
          members: [...(draft?.members.filter(member => !endpoints.some(endpoint => memberKey(endpoint) === memberKey(member))) ?? []),
            ...endpoints.map(endpoint => ({ analysisId: endpoint.analysisId, entityId: endpoint.entityId, entityRevisionId: endpoint.entityRevisionId, mentionIds: endpoint.mentionIds, rationale: reason }))] } } };
  }
  /** Retry held archive / library publication only. Never starts an executor. */
  resume(reviewId: string): EntityLinkInvocation {
    if (this.held.has(reviewId)) this.archiveHeld(reviewId);
    return this.reviews.transaction(transaction => {
      const review = transaction.read(reviewId), decision = decisionOf(review);
      if (projectEntityLinkInvocation(review, this.integrity).status !== 'accepted_pending_application' || !decision || decision.application?.applicationKind !== 'intent') return transaction.save(review, review.generation);
      try {
        const library = new KnowledgeLibraryApplication(this.knowledge, transaction.library, decision.actor, this.id, this.now);
        const plan = prepared(review).input, applied = library.applyLinkIntent(decision.application.intent, [plan.left, plan.right]);
        const actual = applied.receipts.find(value => value.requestId === (decision.application as { applicationKind: 'intent'; intent: LibraryWrite }).intent.requestId)!;
        return this.transition(transaction, review, this.command(reviewId, decision.application.intent.requestId, review.generation,
          { commandKind: 'application_applied', receipt: actual }, decision.actor)).history;
      } catch (error) {
        const conflict = error instanceof EntityLinkConflictError ? error
          : error instanceof LibraryWriteCapacityError ? new EntityLinkConflictError('library_capacity')
            : error instanceof LibraryReferentKindConflictError ? new EntityLinkConflictError('kind_mismatch')
              : error instanceof Error && ['Library revision conflict.', 'Library idempotency conflict.', 'Library change required.'].includes(error.message) ? new EntityLinkConflictError('library_changed') : undefined;
        if (!conflict) throw error;
        return this.transition(transaction, review, this.command(reviewId, decision.application.intent.requestId, review.generation,
          { commandKind: 'application_conflict_v2', conflictVersion: 'omk.entity-link-conflict/v2', conflictCode: conflict.conflictCode }, decision.actor)).history;
      }
    });
  }
}
