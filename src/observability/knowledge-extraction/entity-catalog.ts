import { z } from 'zod';
import type { AnalyzedEntity, EntityAnalysisEnvelope } from '../../knowledge/entities/contracts.js';
import type { KnowledgeEnvelope } from '../../knowledge/store.js';
import type { EvidenceWindow, SourceResolution } from './evidence.js';

export const EntityQuerySchema = z.strictObject({
  query: z.string().trim().max(512).default(''),
  identityStatus: z.enum(['all', 'proposed', 'unresolved']).default('all'),
  sourceStatus: z.enum(['all', 'available', 'unavailable']).default('all'),
  threadId: z.string().min(1).optional(),
  analysisId: z.string().uuid().optional(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
});
export type EntityQuery = z.input<typeof EntityQuerySchema>;
export interface EntityKnowledgeLink {
  knowledgeId: string; revisionId: string; title: string;
  entityRevisionId: string; currentEntityRevision: boolean;
  choice: 'retain' | 'discard' | null;
  roles: { statementId: string; role: 'subject' | 'object'; relation: string }[];
}
export interface EntityCatalogRow extends AnalyzedEntity {
  analysisId: string; revisionId: string; generation: number; revisedAt: string;
  mentionCount: number;
  sourceStatus: SourceResolution['status']; origin?: EvidenceWindow['origin'];
  knowledgeCount: number | null; outdatedKnowledgeCount: number | null;
}
export type EntitySearchRow = EntityCatalogRow & { surfaces: string[] };

/** Knowledge links always refer to its current immutable revision and its actual entity binding. */
export function entityKnowledgeLinks(histories: readonly KnowledgeEnvelope[], analysis: EntityAnalysisEnvelope, entityId: string): EntityKnowledgeLink[] {
  return histories.flatMap(history => {
    const revision = history.revisions.find(value => value.revisionId === history.writeHeadRevisionId)!;
    const ref = history.grounding.find(value => value.revisionId === revision.revisionId)?.entityAnalysisRef;
    if (ref?.analysisId !== analysis.analysisId || !revision.entities.some(entity => entity.entityId === entityId)) return [];
    return [{ knowledgeId: history.knowledgeId, revisionId: revision.revisionId, title: revision.title,
      entityRevisionId: ref.revisionId, currentEntityRevision: ref.revisionId === analysis.writeHeadRevisionId,
      choice: history.maintenance.filter(value => value.revisionId === revision.revisionId).at(-1)?.choice ?? null,
      roles: revision.content.statements.flatMap(statement => [
        ...(statement.subject.entityId === entityId ? [{ statementId: statement.statementId, role: 'subject' as const, relation: statement.relation }] : []),
        ...(statement.object?.entityId === entityId ? [{ statementId: statement.statementId, role: 'object' as const, relation: statement.relation }] : []),
      ]) }];
  }).sort((a, b) => a.knowledgeId.localeCompare(b.knowledgeId));
}

/** Search surfaces and qualifiers, never turn a matching name into an identity merge. */
export function queryEntityRows(rows: EntitySearchRow[], input: EntityQuery = {}) {
  const query = EntityQuerySchema.parse(input);
  const terms = query.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter(row => (query.identityStatus === 'all' || row.identityStatus === query.identityStatus)
    && (query.sourceStatus === 'all' || row.sourceStatus === query.sourceStatus)
    && (!query.threadId || row.origin?.threadId === query.threadId)
    && (!query.analysisId || row.analysisId === query.analysisId)
    && terms.every(term => [row.label, row.description, ...row.qualifiers, ...row.surfaces, row.origin?.title ?? '', row.origin?.cwd ?? '']
      .some(value => value.toLocaleLowerCase().includes(term))))
    .sort((a, b) => Date.parse(b.revisedAt) - Date.parse(a.revisedAt) || a.analysisId.localeCompare(b.analysisId) || a.entityId.localeCompare(b.entityId));
  const page = Math.min(query.page, Math.max(1, Math.ceil(filtered.length / query.pageSize)));
  return { rows: filtered.slice((page - 1) * query.pageSize, page * query.pageSize).map(({ surfaces: _surfaces, ...row }) => row), total: filtered.length,
    page, pageSize: query.pageSize, entityCount: rows.length, analysisCount: new Set(rows.map(row => row.analysisId)).size };
}
