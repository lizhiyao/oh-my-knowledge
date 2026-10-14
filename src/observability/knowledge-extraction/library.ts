import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type KnowledgeActor } from '../../knowledge/contracts.js';
import { LibraryDraftSchema, memberKey, type LibraryDraft, type LibraryMember, type LibraryStore } from '../../knowledge/library/contracts.js';
import { canonicalJson } from '../../knowledge/store.js';
import { validateEvidenceSelection } from '../../knowledge/validation.js';
import type { KnowledgeApplication } from './application.js';

export const LibraryQuerySchema = z.strictObject({ query: z.string().trim().max(512).default(''),
  page: z.number().int().min(1).max(100_000).default(1), pageSize: z.number().int().min(1).max(100).default(20) });
export const LibrarySaveSchema = z.strictObject({ objectId: z.string().uuid(), requestId: z.string().uuid(),
  generation: z.number().int().nonnegative(), headRevisionId: z.string().uuid().nullable(),
  draft: LibraryDraftSchema, reason: z.string().trim().min(1).max(4096), identityConfirmed: z.literal(true) });

/** Organization operates on exact revisions; it neither generates nor edits extracted knowledge. */
export class KnowledgeLibraryApplication {
  constructor(private readonly knowledge: KnowledgeApplication, private readonly store: LibraryStore,
    private readonly actor: KnowledgeActor = { actorKind: 'human', actorId: 'local-user' },
    private readonly id: () => string = randomUUID, private readonly now: () => string = () => new Date().toISOString()) {}

  catalog(input: z.input<typeof LibraryQuerySchema> = {}) {
    const query = LibraryQuerySchema.parse(input); const terms = query.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const all = this.store.list();
    const filtered = all.filter(history => terms.every(term => {
      const draft = history.revisions.at(-1)!.draft;
      return [draft.label, draft.description].some(value => value.toLocaleLowerCase().includes(term));
    })).sort((a, b) => Date.parse(b.revisions.at(-1)!.revisedAt) - Date.parse(a.revisions.at(-1)!.revisedAt) || a.objectId.localeCompare(b.objectId));
    const page = Math.min(query.page, Math.max(1, Math.ceil(filtered.length / query.pageSize)));
    return { rows: filtered.slice((page - 1) * query.pageSize, page * query.pageSize).map(history => {
      const revision = history.revisions.at(-1)!;
      return { objectId: history.objectId, revisionId: revision.revisionId, label: revision.draft.label,
        description: revision.draft.description, referentKind: revision.draft.referentKind, memberCount: revision.draft.members.length,
        revisedAt: revision.revisedAt };
    }), total: filtered.length, objectCount: all.length, page, pageSize: query.pageSize };
  }

  owners(analysisId: string, entityId: string) {
    return this.store.list().filter(history => history.revisions.at(-1)!.draft.members
      .some(member => member.analysisId === analysisId && member.entityId === entityId))
      .map(history => ({ objectId: history.objectId, label: history.revisions.at(-1)!.draft.label }));
  }

  /** All knowledge remains visible even before it has a confirmed organizational home. */
  knowledgeCatalog() {
    const objects = this.store.list().map(history => {
      const revision = history.revisions.at(-1)!;
      return { objectId: history.objectId, label: revision.draft.label, members: revision.draft.members };
    });
    const byEntity = new Map<string, { objectId: string; label: string; entityRevisionId: string }[]>();
    for (const object of objects) for (const member of object.members) {
      const key = memberKey(member);
      byEntity.set(key, [...(byEntity.get(key) ?? []), { objectId: object.objectId, label: object.label, entityRevisionId: member.entityRevisionId }]);
    }
    const rows = this.knowledge.list().map(row => {
      const detail = this.knowledge.detail(row.knowledgeId);
      const ref = detail.grounding.entityAnalysisRef;
      const links = new Map<string, { objectId: string; label: string; associationStatus: 'matched' | 'needs_review' }>();
      if (ref) for (const entity of detail.revision.entities) {
        for (const object of byEntity.get(memberKey({ analysisId: ref.analysisId, entityId: entity.entityId })) ?? []) {
          const previous = links.get(object.objectId);
          links.set(object.objectId, { objectId: object.objectId, label: object.label,
            associationStatus: previous?.associationStatus === 'needs_review' || object.entityRevisionId !== ref.revisionId ? 'needs_review' : 'matched' });
        }
      }
      return { ...row, knowledgeKind: detail.revision.content.organization.knowledgeKind,
        revisedAt: detail.revision.revisedAt, objects: [...links.values()] };
    }).sort((a, b) => Date.parse(b.revisedAt) - Date.parse(a.revisedAt) || a.knowledgeId.localeCompare(b.knowledgeId));
    return { rows, objects: objects.map(({ objectId, label }) => ({ objectId, label })) };
  }

  private member(member: LibraryMember) {
    try {
      const detail = this.knowledge.entityDetail(member.analysisId, member.entityId, member.entityRevisionId);
      const mentions = detail.revision.mentions.filter(mention => member.mentionIds.includes(mention.mentionId));
      return { ...member, status: 'available' as const, entity: detail.entity, current: detail.revision.revisionId === detail.history.writeHeadRevisionId,
        sourceStatus: detail.source.status, origin: detail.origin ? { threadId: detail.origin.threadId, title: detail.origin.title } : undefined,
        evidence: mentions.map(mention => ({ mentionId: mention.mentionId, quote: mention.selection.quote,
          basis: mention.basis, rationale: mention.rationale, positionStatus: detail.mentionChecks.find(value => value.mentionId === mention.mentionId)?.positionStatus ?? 'unavailable' })),
      };
    } catch { return { ...member, status: 'unavailable' as const }; }
  }

  detail(objectId: string, revisionId?: string) {
    const history = this.store.read(objectId);
    const revision = history.revisions.find(value => value.revisionId === (revisionId ?? history.writeHeadRevisionId));
    if (!revision) throw new Error('Library revision unavailable.');
    const members = revision.draft.members.map(member => this.member(member));
    const byEntity = new Map(revision.draft.members.map(member => [memberKey(member), member]));
    const status = { knowledge: 'available' as 'available' | 'unavailable' };
    const details: ReturnType<KnowledgeApplication['detail']>[] = [];
    try { for (const row of this.knowledge.list()) details.push(this.knowledge.detail(row.knowledgeId)); }
    catch { status.knowledge = 'unavailable'; details.length = 0; }
    const knowledge = details.flatMap(detail => {
      const ref = detail.grounding.entityAnalysisRef;
      if (!ref) return [];
      const linked = detail.revision.entities.flatMap(entity => {
        const member = byEntity.get(memberKey({ analysisId: ref.analysisId, entityId: entity.entityId }));
        if (!member) return [];
        return [{ ...member, matchesRevision: member.entityRevisionId === ref.revisionId }];
      });
      if (!linked.length) return [];
      // An identity correction must be reviewed before its claims can be attributed to this object.
      const associationStatus = linked.every(member => member.matchesRevision) ? 'matched' as const : 'needs_review' as const;
      return [{ knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId, title: detail.revision.title,
        choice: detail.maintenance?.choice ?? null, associationStatus,
        content: detail.revision.content, entities: detail.revision.entities, tags: detail.tagging.tags,
        revisedAt: detail.revision.revisedAt, revisionCount: detail.history.revisions.length,
        evidence: detail.revision.evidence.map(link => ({ basis: link.basis, relation: link.relation, interpretation: link.interpretation,
          statementIds: link.statementIds })),
        sourceStatus: detail.sources.every(source => source.status === 'available') ? 'available' as const : 'unavailable' as const,
        roles: detail.revision.content.statements.flatMap(statement => [
          ...(linked.some(member => member.entityId === statement.subject.entityId) ? [{ statementId: statement.statementId, role: 'subject' as const }] : []),
          ...(linked.some(member => member.entityId === statement.object?.entityId) ? [{ statementId: statement.statementId, role: 'object' as const }] : []),
        ]),
        bindings: linked.map(member => ({ analysisId: member.analysisId, entityId: member.entityId,
          entityRevisionId: ref.revisionId, confirmedEntityRevisionId: member.entityRevisionId, matchesRevision: member.matchesRevision })),
      }];
    }).sort((a, b) => Date.parse(b.revisedAt) - Date.parse(a.revisedAt) || a.knowledgeId.localeCompare(b.knowledgeId));
    const objectOwners = new Map<string, { objectId: string; label: string }>(this.store.list().flatMap(value => value.revisions.at(-1)!.draft.members.map(member =>
      [`${memberKey(member)}:${member.entityRevisionId}`, { objectId: value.objectId, label: value.revisions.at(-1)!.draft.label }] as const)));
    const relatedEntities = new Map<string, { analysisId: string; entityId: string; entityRevisionId: string; label: string;
      object?: { objectId: string; label: string } }>();
    for (const item of knowledge.filter(value => value.associationStatus === 'matched')) {
      const ref = item.bindings[0];
      for (const entity of item.entities) {
        if (byEntity.has(memberKey({ analysisId: ref.analysisId, entityId: entity.entityId }))) continue;
        const key = `${ref.analysisId}:${entity.entityId}:${ref.entityRevisionId}`;
        relatedEntities.set(key, { analysisId: ref.analysisId, entityId: entity.entityId, entityRevisionId: ref.entityRevisionId,
          label: entity.label, object: objectOwners.get(key) });
      }
    }
    return { history, revision, members, knowledge, relatedEntities: [...relatedEntities.values()], knowledgeStatus: status.knowledge,
      counts: { retained: status.knowledge === 'available' ? knowledge.filter(item => item.associationStatus === 'matched' && item.choice === 'retain').length : null,
        pending: status.knowledge === 'available' ? knowledge.filter(item => item.associationStatus === 'matched' && item.choice === null).length : null,
        discarded: status.knowledge === 'available' ? knowledge.filter(item => item.associationStatus === 'matched' && item.choice === 'discard').length : null,
        needsReview: status.knowledge === 'available' ? knowledge.filter(item => item.associationStatus === 'needs_review').length : null } };
  }

  save(input: z.input<typeof LibrarySaveSchema>) {
    const request = LibrarySaveSchema.parse(input);
    const previous = this.store.list().find(history => history.objectId === request.objectId);
    const priorReceipt = previous?.receipts.find(receipt => receipt.requestId === request.requestId);
    const priorRevision = priorReceipt ? previous!.revisions.find(revision => revision.revisionId === priorReceipt.revisionId)! : undefined;
    return this.store.write({ requestId: request.requestId, objectId: request.objectId, expectedGeneration: request.generation,
      expectedHeadRevisionId: request.headRevisionId,
      revision: { revisionId: priorRevision?.revisionId ?? this.id(), ...(request.headRevisionId ? { parentRevisionId: request.headRevisionId } : {}),
        draft: request.draft, revisedAt: priorRevision?.revisedAt ?? this.now(), revisedBy: this.actor, reason: request.reason } }, (existing, all) => {
      if (!existing && !request.draft.members.length) throw new Error('Library initial source required.');
      const owners = new Map(all.filter(history => history.objectId !== request.objectId)
        .flatMap(history => history.revisions.at(-1)!.draft.members.map(member => [memberKey(member), history.objectId] as const)));
      for (const member of request.draft.members) {
        if (owners.has(memberKey(member))) throw new Error('Library member owner conflict.');
        const previous = existing?.revisions.at(-1)!.draft.members.find(value => memberKey(value) === memberKey(member));
        if (previous && canonicalJson(previous) === canonicalJson(member)) continue;
        this.validateMember(member, request.draft);
      }
    });
  }

  private validateMember(member: LibraryMember, draft: LibraryDraft) {
    const detail = this.knowledge.entityDetail(member.analysisId, member.entityId, member.entityRevisionId);
    if (detail.revision.revisionId !== detail.history.writeHeadRevisionId) throw new Error('Library entity revision conflict.');
    if (detail.entity.identityStatus !== 'proposed' || detail.entity.referentKind !== draft.referentKind) throw new Error('Library identity needs correction.');
    if (detail.source.status !== 'available') throw new Error('Library source unavailable.');
    for (const id of member.mentionIds) {
      const mention = detail.revision.mentions.find(value => value.mentionId === id && value.entityId === member.entityId);
      if (!mention || validateEvidenceSelection(mention.selection, detail.source.window.excerpts).length) throw new Error('Library evidence mismatch.');
    }
  }
}
