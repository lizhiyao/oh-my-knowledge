import { z } from 'zod';
import type { KnowledgeBodyRef, KnowledgeDraft } from '../contracts.js';
import type { KnowledgeAssociationSelection } from '../associations.js';
import { validateEvidenceSelection } from '../validation.js';
import type { KnowledgeApplication } from './application.js';
import { formatKnowledgeRetrievalText } from './retrieval-text.js';
import { sourceSummary, type SourceSummary } from './source-summary.js';

export const KNOWLEDGE_RETRIEVAL_MIN_BYTES = 1024;
export const KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES = 65536;
export const KNOWLEDGE_RETRIEVAL_MAX_BYTES = 1024 * 1024;
export const KNOWLEDGE_RETRIEVAL_RANKING_POLICY_ID = 'knowledge-body-literal-topic-priority/v3' as const;
export const KnowledgeRetrievalRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(512)
    .refine(value => knowledgeRetrievalTerms(value).length > 0, 'Query has no searchable literal fragments.')
    .refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value), 'Query contains control characters.'),
  maxBytes: z.number().int().min(KNOWLEDGE_RETRIEVAL_MIN_BYTES).max(KNOWLEDGE_RETRIEVAL_MAX_BYTES).default(KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES),
  includeCandidates: z.boolean().default(false),
  snapshot: z.string().uuid().optional(),
  sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  analysisId: z.string().uuid().optional(),
  entityRevisionId: z.string().uuid().optional(),
  entityId: z.string().min(1).max(256).refine(value => value.trim().length > 0).optional(),
}).refine(value => [value.analysisId, value.entityRevisionId, value.entityId].filter(value => value !== undefined).length % 3 === 0,
  { message: 'Entity scope requires analysisId, entityRevisionId and entityId.' }).refine(value => !!value.sourceVersion === !!value.snapshot, { path: ['sourceVersion'], message: 'Source scope requires both snapshot and sourceVersion.' });
export type KnowledgeRetrievalRequest = z.input<typeof KnowledgeRetrievalRequestSchema>;
type Detail = ReturnType<KnowledgeApplication['detail']>;
type Segment = KnowledgeDraft['content']['segments'][number];
type Resolution = ReturnType<KnowledgeApplication['source']>;
type Unit = { detail: Detail; segment: Segment; segmentIndex: number; hits: Set<string>; documentHits: Set<string>; topicHits: Set<string> };
type SourceContext = { snapshotId: string; sourceVersion: string } & (
  { status: 'available'; sourceKind: Extract<Resolution, { status: 'available' }>['snapshot']['sourceKind']; source: SourceSummary }
  | { status: 'unavailable'; reason: string }
);
type ScopeDiagnostics = { source?: { status: 'available' | 'unavailable'; reason?: string };
  entity?: { analysisId: string; entityRevisionId: string; entityId: string; status: 'matched_segments' | 'no_eligible_segments' } };
type DerivedSummary = { status: KnowledgeAssociationSelection['status']; reviewStatus: KnowledgeAssociationSelection['reviewStatus']; bodyRef: KnowledgeBodyRef;
  revision?: { revisionId: string; bodyRef: KnowledgeBodyRef; status: 'available' | 'failed'; reviewStatus: 'pending';
    catalogRefs: { analysisId: string; entityRevisionId: string }[]; issueCount: number } };
export interface KnowledgeRetrievalResult {
  projectionKind: 'knowledge-body-segments'; schemaVersion: 3;
  rankingPolicyId: typeof KNOWLEDGE_RETRIEVAL_RANKING_POLICY_ID;
  omitted: { oversizedSegments: number; budgetSegments: number };
  scopeDiagnostics?: ScopeDiagnostics;
  knowledge: {
    bodyRef: KnowledgeBodyRef;
    generation: number; title: string; choice: 'retain' | 'discard' | null; reviewStatus: Detail['reviewStatus'];
    segmentScope: { returned: number; total: number };
    derivedAssociations: DerivedSummary;
  }[];
  sources: SourceContext[];
  items: { knowledge: number; segmentIndex: number; segment: Segment;
    evidenceChecks: { evidenceIndex: number; source: number; positionStatus: 'matched' | 'mismatch' | 'unavailable' }[] }[];
}
export class KnowledgeRetrievalBudgetError extends Error {
  constructor(readonly minimumBytes: number) {
    super(`Knowledge retrieval metadata requires at least ${minimumBytes} UTF-8 bytes.`); this.name = 'KnowledgeRetrievalBudgetError';
  }
}
/** Literal recall only: strings and Han bigrams do not establish identity or truth. */
export function knowledgeRetrievalTerms(query: string): string[] {
  const text = query.normalize('NFKC').toLowerCase();
  const terms = [...text.matchAll(/[a-z0-9_$]+(?:[.:/#-][a-z0-9_$]+)*/g)].map(match => match[0]);
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    terms.push(match[0]); const characters = Array.from(match[0]);
    for (let index = 0; index + 1 < characters.length; index++) terms.push(characters[index] + characters[index + 1]);
  }
  return [...new Set(terms)];
}
const sourceKey = (source: { snapshotId: string; sourceVersion: string }) => `${source.snapshotId}/${source.sourceVersion}`;
const sameBody = (a: KnowledgeBodyRef, b: KnowledgeBodyRef) => a.knowledgeId === b.knowledgeId && a.revisionId === b.revisionId && a.bodyDigest === b.bodyDigest;
function currentAssociation(detail: Detail) {
  const result = detail.derivedAssociations, revision = result.revision;
  return result.status === 'available' && result.reviewStatus !== 'rejected' && revision?.status === 'available' && sameBody(result.bodyRef, detail.revision)
    && sameBody(revision.bodyRef, detail.revision) ? { ...revision, segmentEntityRefs: revision.segmentEntityRefs.filter(ref => detail.derivedCatalogs.some(catalog =>
      catalog.status === 'available' && catalog.analysisId === ref.analysisId && catalog.entityRevisionId === ref.entityRevisionId)) } : undefined;
}
function derivedSummary(detail: Detail): DerivedSummary {
  const { status, reviewStatus, bodyRef, revision } = detail.derivedAssociations;
  return { status, reviewStatus, bodyRef, ...(revision ? { revision: { revisionId: revision.revisionId, bodyRef: revision.bodyRef,
    status: revision.status, reviewStatus: revision.reviewStatus, catalogRefs: revision.catalogRefs,
    issueCount: revision.issues.length } } : {}) };
}
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const measure = (value: KnowledgeRetrievalResult) => Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
function hits(fields: string[], terms: string[]): Set<string> {
  const normalized = fields.map(value => value.normalize('NFKC').toLowerCase());
  return new Set(terms.filter(term => normalized.some(value => value.includes(term))));
}
function stableOrder(a: Unit, b: Unit): number {
  return Date.parse(b.detail.revision.revisedAt) - Date.parse(a.detail.revision.revisedAt)
    || compareId(a.detail.revision.knowledgeId, b.detail.revision.knowledgeId) || a.segmentIndex - b.segmentIndex;
}
function project(units: Unit[], matched: number, oversized: number, resolutions: Map<string, Resolution>, scopeDiagnostics: ScopeDiagnostics): KnowledgeRetrievalResult {
  const result: KnowledgeRetrievalResult = { projectionKind: 'knowledge-body-segments', schemaVersion: 3,
    rankingPolicyId: KNOWLEDGE_RETRIEVAL_RANKING_POLICY_ID,
    omitted: { oversizedSegments: oversized, budgetSegments: matched - oversized - units.length },
    ...(Object.keys(scopeDiagnostics).length ? { scopeDiagnostics } : {}), knowledge: [], sources: [], items: [] };
  const knowledge = new Map<string, number>(), sources = new Map<string, number>();
  const selected = new Map<string, number>();
  for (const unit of units) selected.set(unit.detail.revision.knowledgeId, (selected.get(unit.detail.revision.knowledgeId) ?? 0) + 1);
  for (const { detail, segment, segmentIndex } of units) {
    const { revision } = detail, key = `${revision.knowledgeId}/${revision.revisionId}`;
    let knowledgeIndex = knowledge.get(key);
    if (knowledgeIndex === undefined) {
      knowledgeIndex = result.knowledge.length; knowledge.set(key, knowledgeIndex);
      result.knowledge.push({ bodyRef: { knowledgeId: revision.knowledgeId, revisionId: revision.revisionId, bodyDigest: revision.bodyDigest },
        generation: detail.history.generation, title: revision.title, choice: detail.maintenance?.choice ?? null, reviewStatus: detail.reviewStatus,
        segmentScope: { returned: selected.get(revision.knowledgeId)!, total: revision.content.segments.length },
        // Catalog size/readiness never becomes part of the canonical body budget.
        derivedAssociations: derivedSummary(detail) });
    }
    const evidenceChecks = segment.evidence.map((evidence, evidenceIndex) => {
      const key = sourceKey(evidence.source), resolution = resolutions.get(key)!; let index = sources.get(key);
      if (index === undefined) {
        index = result.sources.length; sources.set(key, index);
        result.sources.push({ ...evidence.source, ...(resolution.status === 'available'
          ? { status: 'available' as const, sourceKind: resolution.snapshot.sourceKind, source: sourceSummary(resolution.snapshot) }
          : { status: 'unavailable' as const, reason: resolution.reason }) });
      }
      return { evidenceIndex, source: index, positionStatus: resolution.status === 'unavailable' ? 'unavailable' as const
        : validateEvidenceSelection(evidence.selection, resolution.snapshot.excerpts).length ? 'mismatch' as const : 'matched' as const };
    });
    // The complete stored segment, including every evidence field, is the budget unit.
    result.items.push({ knowledge: knowledgeIndex, segmentIndex, segment, evidenceChecks });
  }
  return result;
}
/** Current canonical bodies only; no executor, mutation, source-text fallback or name-based merging. */
function retrieveForFormat(app: Pick<KnowledgeApplication, 'list' | 'detail' | 'source'>, input: KnowledgeRetrievalRequest, format: 'json' | 'text'): KnowledgeRetrievalResult {
  const request = KnowledgeRetrievalRequestSchema.parse(input), terms = knowledgeRetrievalTerms(request.query);
  const measureResult = format === 'text' ? (value: KnowledgeRetrievalResult) => Buffer.byteLength(formatKnowledgeRetrievalText(value), 'utf8') + 1 : measure;
  const asciiTerms = terms.filter(term => /^[a-z0-9_$]+(?:[.:/#-][a-z0-9_$]+)*$/.test(term));
  const fullHanRuns = new Set([...request.query.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+/gu)].map(match => match[0]));
  const derivedBigrams = new Set(terms.filter(term => /^\p{Script=Han}{2}$/u.test(term) && !fullHanRuns.has(term)));
  const source = request.snapshot ? app.source({ snapshotId: request.snapshot, sourceVersion: request.sourceVersion! }) : undefined;
  const scopeDiagnostics: ScopeDiagnostics = source ? { source: source.status === 'available' ? { status: 'available' }
    : { status: 'unavailable', reason: source.reason } } : {};
  const candidates: Unit[] = [], resolutions = new Map<string, Resolution>(); let entityMatched = false;
  for (const row of app.list()) {
    if (row.choice !== 'retain' && !(request.includeCandidates && row.choice === null)) continue;
    const detail = app.detail(row.knowledgeId, row.revisionId);
    if (detail.history.writeHeadRevisionId !== row.revisionId) throw new Error('Knowledge changed during retrieval. Reload and retry.');
    if (detail.maintenance?.choice !== 'retain' && !(request.includeCandidates && !detail.maintenance)) continue;
    const recalled = hits([detail.revision.title, ...detail.tagging.tags], terms);
    const association = request.entityId ? currentAssociation(detail) : undefined;
    const scopedSegments = detail.revision.content.segments.map((segment, segmentIndex) => ({ segment, segmentIndex })).filter(({ segment }) => {
      if (request.snapshot && !segment.evidence.some(evidence => evidence.source.snapshotId === request.snapshot
        && (!request.sourceVersion || evidence.source.sourceVersion === request.sourceVersion))) return false;
      return !request.entityId || !!association?.segmentEntityRefs.some(ref => ref.segmentId === segment.segmentId && ref.analysisId === request.analysisId && ref.entityRevisionId === request.entityRevisionId && ref.entityId === request.entityId);
    });
    const topicHits = hits([detail.revision.title, ...scopedSegments.map(({ segment }) => segment.text), ...detail.tagging.tags], asciiTerms);
    scopedSegments.forEach(({ segment, segmentIndex }) => {
      if (request.entityId) entityMatched = true;
      const local = hits([segment.text], terms);
      if (!local.size && !recalled.size) return;
      for (const evidence of segment.evidence) {
        const key = sourceKey(evidence.source);
        if (!resolutions.has(key)) resolutions.set(key, app.source(evidence.source));
      }
      candidates.push({ detail, segment, segmentIndex, hits: local, documentHits: recalled, topicHits });
    });
  }
  if (request.entityId) scopeDiagnostics.entity = { analysisId: request.analysisId!, entityRevisionId: request.entityRevisionId!, entityId: request.entityId, status: entityMatched ? 'matched_segments' : 'no_eligible_segments' };
  // Topic containment affects packing priority only, never candidate eligibility:
  // a smaller literal set cannot establish that a body's constraints are redundant.
  // With no ASCII hits (including pure Han queries), the existing recall is unchanged.
  const topics = new Map(candidates.map(unit => [unit.detail.revision.knowledgeId, unit.topicHits]));
  const dominated = new Set([...topics].filter(([, topic]) => [...topics.values()].some(other =>
    topic.size < other.size && [...topic].every(term => other.has(term)))).map(([id]) => id));
  candidates.sort(stableOrder);
  const oversized = new Set(candidates.filter(unit => measureResult(project([unit], 1, 0, resolutions, scopeDiagnostics)) > request.maxBytes));
  const chosen: Unit[] = [], remaining = new Set(candidates), covered = new Set<string>(), coveredDocuments = new Set<string>();
  const projected = (units: Unit[]) => project(units, candidates.length, [...oversized].filter(unit => !units.includes(unit)).length, resolutions, scopeDiagnostics);
  let result = projected(chosen);
  if (measureResult(result) > request.maxBytes) throw new KnowledgeRetrievalBudgetError(measureResult(result));
  while (remaining.size) {
    let best: { unit: Unit; result: KnowledgeRetrievalResult; gain: number; cost: number; novel: number; priority: number } | undefined;
    const currentBytes = measureResult(result);
    for (const unit of remaining) {
      const next = projected([...chosen, unit]), nextBytes = measureResult(next); if (nextBytes > request.maxBytes) continue;
      const novelTerms = [...unit.hits].filter(term => !covered.has(term)), novel = novelTerms.length;
      const novelty = novelTerms.reduce((gain, term) => gain + (derivedBigrams.has(term) ? 1 : 4), 0);
      const documentNovel = [...unit.documentHits].filter(term => !coveredDocuments.has(term)).length;
      const gain = Math.max(1, novelty + unit.hits.size + documentNovel), cost = Math.max(1, nextBytes - currentBytes);
      const priority = dominated.has(unit.detail.revision.knowledgeId) ? 1 : 0;
      if (!best || priority < best.priority || priority === best.priority && (gain * best.cost > best.gain * cost
        || gain * best.cost === best.gain * cost && (novel > best.novel
          || novel === best.novel && (unit.hits.size > best.unit.hits.size || unit.hits.size === best.unit.hits.size && stableOrder(unit, best.unit) < 0)))) {
        best = { unit, result: next, gain, cost, novel, priority };
      }
    }
    if (!best) break;
    chosen.push(best.unit); remaining.delete(best.unit); result = best.result;
    best.unit.hits.forEach(term => covered.add(term)); best.unit.documentHits.forEach(term => coveredDocuments.add(term));
  }
  return result;
}

/** The existing JSON selection and byte representation retain their original packing costs. */
export function retrieveKnowledge(app: Pick<KnowledgeApplication, 'list' | 'detail' | 'source'>, input: KnowledgeRetrievalRequest): KnowledgeRetrievalResult {
  return retrieveForFormat(app, input, 'json');
}
/** Text has its own actual UTF-8 + LF cost; it is never selected under the JSON budget first. */
export function retrieveKnowledgeText(app: Pick<KnowledgeApplication, 'list' | 'detail' | 'source'>, input: KnowledgeRetrievalRequest): string {
  return formatKnowledgeRetrievalText(retrieveForFormat(app, input, 'text'));
}
