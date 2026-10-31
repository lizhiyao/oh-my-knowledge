import { KnowledgeBodyRefSchema, type KnowledgeActor, type KnowledgeBodyRef, type KnowledgeRevision } from '../contracts.js';
import { KnowledgeReviewActorSchema, knowledgeReviewSources, sameReviewBody } from '../reviews.js';
import { KnowledgeRelationError, KnowledgeRelationEnvelopeSchema, KnowledgeRelationProposeInputSchema, KnowledgeRelationReviewInputSchema, KnowledgeRelationWithdrawInputSchema,
  KnowledgeRelationWriteSchema, type KnowledgeRelationEnvelope, type KnowledgeRelationEndpoint, type KnowledgeRelationProposeInput, type KnowledgeRelationProposedEvent,
  type KnowledgeRelationReviewInput, type KnowledgeRelationStore, type KnowledgeRelationWithdrawInput, type KnowledgeRelationWrite } from '../relations.js';
import { sameKnowledgeRelationActor, selectKnowledgeRelation } from '../relation-history.js';
import type { KnowledgeStore } from '../store.js';
import { canonicalJson } from '../store.js';
import type { SourceStore } from '../source-store.js';
import type { SourceRef } from '../sources.js';
import { validateEvidenceSelection } from '../validation.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../adapters/body-digest.js';

export interface KnowledgeRelationsPorts {
  knowledge: Pick<KnowledgeStore, 'read'>; sources: Pick<SourceStore, 'read'>; relations: KnowledgeRelationStore;
  actor?: KnowledgeActor; now(): string; assertWritable?(): void;
}
export interface KnowledgeRelationEndpointStatus {
  bodyRef: KnowledgeBodyRef; segmentIds?: string[]; currentBodyRef?: KnowledgeBodyRef;
  status: 'current' | 'stale' | 'unavailable' | 'out_of_scope'; reason?: string;
}
export interface KnowledgeRelationSourceStatus extends SourceRef { status: 'available' | 'unavailable'; reason?: string }
export type KnowledgeRelationProjection = ReturnType<KnowledgeRelationsApplication['project']>;
export type KnowledgeRelationStatus = ReturnType<KnowledgeRelationsApplication['relation']>;
/** Explicit cross-knowledge opinions; no generation, automatic approval or truth arbitration. */
export class KnowledgeRelationsApplication {
  constructor(private readonly ports: KnowledgeRelationsPorts) { if (ports.actor !== undefined) KnowledgeReviewActorSchema.parse(ports.actor); }
  private body(endpoint: KnowledgeRelationEndpoint) {
    let history;
    try { history = this.ports.knowledge.read(endpoint.bodyRef.knowledgeId); }
    catch { throw new KnowledgeRelationError('unavailable', 'Exact relation endpoint is unavailable.'); }
    const body = history.revisions.find(b => b.revisionId === endpoint.bodyRef.revisionId);
    if (!body || !sameReviewBody(endpoint.bodyRef, body) || knowledgeBodyDigest(body) !== body.bodyDigest) throw new KnowledgeRelationError('invalid', 'Relation body identity conflict.');
    if (endpoint.segmentIds?.some(id => !body.content.segments.some(s => s.segmentId === id))) throw new KnowledgeRelationError('invalid', 'Unknown relation endpoint segment.');
    const current = history.revisions.find(b => b.revisionId === history.writeHeadRevisionId);
    if (!current) throw new KnowledgeRelationError('unavailable', 'Relation body head is unavailable.');
    return { body, currentBodyRef: knowledgeBodyRef(current) };
  }
  private sourceStates(bodies: readonly KnowledgeRevision[]): KnowledgeRelationSourceStatus[] {
    return [...new Map(bodies.flatMap(knowledgeReviewSources).map(ref => [canonicalJson(ref), ref])).values()].map(ref => {
      try { const result = this.ports.sources.read(ref.snapshotId, ref.sourceVersion);
        return result.status === 'available' ? { ...ref, status: 'available' as const } : { ...ref, status: 'unavailable' as const, reason: result.reason };
      } catch { return { ...ref, status: 'unavailable' as const, reason: 'corrupt' }; }
    });
  }
  private validateProposal(proposal: KnowledgeRelationProposedEvent | KnowledgeRelationProposeInput): void {
    const bodies = { from: this.body(proposal.from).body, to: this.body(proposal.to).body };
    // Every source supporting either complete body is pinned, not merely the quotes chosen in the form.
    if (this.sourceStates(Object.values(bodies)).some(s => s.status !== 'available')) throw new KnowledgeRelationError('unavailable', 'Relation supporting source unavailable.');
    for (const body of Object.values(bodies)) for (const segment of body.content.segments) for (const evidence of segment.evidence) {
      const source = this.ports.sources.read(evidence.source.snapshotId, evidence.source.sourceVersion);
      if (source.status !== 'available' || validateEvidenceSelection(evidence.selection, source.snapshot.excerpts).length) throw new KnowledgeRelationError('invalid', 'Relation body source evidence is invalid.');
    }
    for (const evidence of proposal.evidence) {
      const endpoint = proposal[evidence.side], body = bodies[evidence.side];
      const segment = body.content.segments.find(s => s.segmentId === evidence.bodySelection.segmentId);
      if (!segment || endpoint.segmentIds && !endpoint.segmentIds.includes(segment.segmentId)) throw new KnowledgeRelationError('invalid', 'Relation evidence is outside its endpoint segments.');
      const selection = evidence.bodySelection;
      if (segment.text.slice(selection.start, selection.end) !== selection.quote || selection.end > segment.text.length) throw new KnowledgeRelationError('invalid', 'Relation body quote does not match its UTF-16 range.');
      if (!segment.evidence.some(e => canonicalJson(e.source) === canonicalJson(evidence.source))) throw new KnowledgeRelationError('invalid', 'Relation evidence source is not bound to its body segment.');
      const source = this.ports.sources.read(evidence.source.snapshotId, evidence.source.sourceVersion);
      if (source.status !== 'available' || validateEvidenceSelection(evidence.selection, source.snapshot.excerpts).length) throw new KnowledgeRelationError('invalid', 'Relation supporting quote does not match its exact source.');
    }
  }
  project(history: KnowledgeRelationEnvelope, relationRevisionId?: string, knowledgeIds?: ReadonlySet<string>) {
    const selected = selectKnowledgeRelation(history, relationRevisionId), bodies: KnowledgeRevision[] = [];
    const endpoint = (value: KnowledgeRelationEndpoint): KnowledgeRelationEndpointStatus => {
      if (knowledgeIds && !knowledgeIds.has(value.bodyRef.knowledgeId)) return { ...value, status: 'out_of_scope', reason: 'Endpoint is outside the explicit knowledge selection.' };
      try {
        const resolved = this.body(value); bodies.push(resolved.body);
        return { ...value, currentBodyRef: resolved.currentBodyRef, status: sameReviewBody(value.bodyRef, resolved.currentBodyRef) ? 'current' : 'stale' };
      } catch { return { ...value, status: 'unavailable', reason: 'Exact relation endpoint or its segments are unavailable.' }; }
    };
    const endpoints = { from: endpoint(selected.revision.from), to: endpoint(selected.revision.to) }, sources = this.sourceStates(bodies);
    const bodyStatus = Object.values(endpoints).some(e => e.status === 'unavailable' || e.status === 'out_of_scope') ? 'unavailable' as const
      : Object.values(endpoints).some(e => e.status === 'stale') ? 'stale' as const : 'current' as const;
    const sourceStatus = bodyStatus === 'unavailable' || sources.some(s => s.status === 'unavailable') ? 'unavailable' as const : 'available' as const;
    const issues = [...Object.values(endpoints).filter(e => e.reason).map(e => e.reason!), ...sources.filter(s => s.status === 'unavailable').map(() => 'Exact supporting source unavailable.')];
    const actor = this.ports.actor;
    const currentRevision = [...history.events].reverse().find(e => e.eventKind === 'relation_proposed');
    const permissions = { canReview: !!actor && !selected.withdrawn,
      canWithdraw: !!actor && !selected.withdrawn && currentRevision?.eventId === selected.revision.eventId && sameKnowledgeRelationActor(actor, selected.revision.actor),
      canAccept: !!actor && !selected.withdrawn && sourceStatus === 'available' && (selected.revision.relationType !== 'conflicts_with' || selected.revision.comparisonScope.status === 'same'),
      supersedableReviewEventIds: actor ? selected.activeReviews.filter(e => sameKnowledgeRelationActor(e.actor, actor)).map(e => e.eventId) : [] };
    return { relationId: history.relationId, storageStatus: 'available' as const, history, generation: history.generation, headEventId: history.writeHeadEventId,
      ...selected, isCurrentRevision: currentRevision?.eventId === selected.revision.eventId, endpoints, sources, bodyStatus, sourceStatus, issues, permissions };
  }
  inventory(knowledgeIds?: ReadonlySet<string>) { return this.ports.relations.inventory(knowledgeIds); }
  list(input: KnowledgeBodyRef) {
    const bodyRef = KnowledgeBodyRefSchema.parse(input), inventory = this.inventory(new Set([bodyRef.knowledgeId]));
    const relations = inventory.histories.flatMap(history => {
      const matching = [...history.events].reverse().find(e => e.eventKind === 'relation_proposed'
        && (sameReviewBody(e.from.bodyRef, bodyRef) || sameReviewBody(e.to.bodyRef, bodyRef)));
      return matching ? [this.project(history, matching.eventId)] : [];
    });
    return { bodyRef, relations, unavailable: inventory.unavailable, completeness: inventory.completeness };
  }
  relation(id: string, relationRevisionId?: string) {
    const relationId = KnowledgeRelationEnvelopeSchema.shape.relationId.parse(id);
    let history;
    try {
      history = this.ports.relations.read(relationId);
    } catch { return { relationId, storageStatus: 'unavailable' as const, reason: 'Relation ledger is unavailable; no absence can be inferred.' }; }
    return history ? this.project(history, relationRevisionId) : { relationId, storageStatus: 'absent' as const };
  }
  propose(input: KnowledgeRelationProposeInput) { return this.write({ ...KnowledgeRelationProposeInputSchema.parse(input), eventKind: 'relation_proposed' }); }
  review(input: KnowledgeRelationReviewInput) { return this.write({ ...KnowledgeRelationReviewInputSchema.parse(input), eventKind: 'relation_reviewed' }); }
  withdraw(input: KnowledgeRelationWithdrawInput) { return this.write({ ...KnowledgeRelationWithdrawInputSchema.parse(input), eventKind: 'relation_withdrawn' }); }
  private write(input: KnowledgeRelationWrite) {
    if (!this.ports.actor) throw new KnowledgeRelationError('forbidden', 'A trusted actual relation actor is required for writes.');
    this.ports.assertWritable?.();
    const command = KnowledgeRelationWriteSchema.parse(input), actor = KnowledgeReviewActorSchema.parse(this.ports.actor);
    return this.ports.relations.write(command, actor, this.ports.now(), () => {
      // The store already checked exact receipt/CAS; re-read endpoints and sources under the same workspace lock.
      if (command.eventKind === 'relation_proposed') this.validateProposal(command);
      else if (command.eventKind === 'relation_reviewed' && command.choice === 'accept') {
        const history = this.ports.relations.read(command.relationId);
        if (!history) throw new KnowledgeRelationError('unavailable', 'Relation proposal is unavailable.');
        this.validateProposal(selectKnowledgeRelation(history, command.relationRevisionId).revision);
      }
      // reject/withdraw preserve opinions about old unavailable refs; author checks remain in the pure reducer.
    });
  }
}
