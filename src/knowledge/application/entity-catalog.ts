import { z } from 'zod';
import type { AnalyzedEntity } from '../entities/contracts.js';
import type { TraceOrigin, SourceResolution } from '../sources.js';
import type { SourceSummary } from './source-summary.js';

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
  segmentIds: string[]; projectionReviewStatus: 'pending' | 'accepted' | 'rejected';
}
export interface EntityCatalogRow extends AnalyzedEntity {
  analysisId: string; revisionId: string; generation: number; revisedAt: string;
  mentionCount: number;
  sourceStatus: SourceResolution['status']; origin?: TraceOrigin; source?: SourceSummary;
  knowledgeCount: number | null; outdatedKnowledgeCount: number | null;
}
export type EntitySearchRow = EntityCatalogRow & { surfaces: string[] };

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
