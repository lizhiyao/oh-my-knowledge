import { z } from 'zod';
import type { KnowledgeDraft } from '../contracts.js';
import { validateEvidenceSelection } from '../validation.js';
import type { KnowledgeApplication } from './application.js';
import { encodeKnowledgeContext, type KnowledgeRetrievalResult } from './retrieval-codec.js';
export { decodeKnowledgeContext, encodeKnowledgeContext, type KnowledgeRetrievalResult } from './retrieval-codec.js';

export const KNOWLEDGE_RETRIEVAL_MIN_BYTES = 1024;
export const KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES = 8192;
export const KNOWLEDGE_RETRIEVAL_MAX_BYTES = 1024 * 1024;
export const KnowledgeRetrievalRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(512).refine(value => knowledgeRetrievalTerms(value).length > 0, 'Query has no searchable literal fragments.').refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value), 'Query contains control characters.'),
  maxBytes: z.number().int().min(KNOWLEDGE_RETRIEVAL_MIN_BYTES).max(KNOWLEDGE_RETRIEVAL_MAX_BYTES).default(KNOWLEDGE_RETRIEVAL_DEFAULT_BYTES),
  includeCandidates: z.boolean().default(false), snapshot: z.string().uuid().optional(),
  sourceVersion: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), entityId: z.string().min(1).max(256).refine(value => value.trim().length > 0).optional(),
}).refine(value => !value.sourceVersion || !!value.snapshot, { path: ['sourceVersion'], message: 'sourceVersion requires snapshot.' });
export type KnowledgeRetrievalRequest = z.input<typeof KnowledgeRetrievalRequestSchema>;
type Detail = ReturnType<KnowledgeApplication['detail']>;
type Statement = KnowledgeDraft['content']['statements'][number];
type Unit = { detail: Detail; statement: Statement; hits: Set<string>; documentHits: Set<string>; costBytes: number; scopeEntityId?: string };
type ScopeDiagnostics = { source?: { status: 'available' | 'unavailable'; reason?: string }; entity?: 'matched_knowledge' | 'no_eligible_knowledge' };
export class KnowledgeRetrievalBudgetError extends Error {
  constructor(readonly minimumBytes: number) { super(`Knowledge retrieval metadata requires at least ${minimumBytes} UTF-8 bytes.`); this.name = 'KnowledgeRetrievalBudgetError'; }
}
/** Literal identifiers and Han runs/bigrams support questions, without semantic inference. */
export function knowledgeRetrievalTerms(query: string): string[] {
  const text = query.normalize('NFKC').toLowerCase();
  const terms = [...text.matchAll(/[a-z0-9_$]+(?:[.:/#-][a-z0-9_$]+)*/g)].map(match => match[0]);
  for (const match of text.matchAll(/\p{Script=Han}+/gu)) {
    terms.push(match[0]); const characters = Array.from(match[0]);
    for (let index = 0; index + 1 < characters.length; index++) terms.push(characters[index] + characters[index + 1]);
  }
  return [...new Set(terms)];
}
function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(textValues);
  return value && typeof value === 'object' ? Object.values(value).flatMap(textValues) : [];
}
function organizationContext(detail: Detail, selected: Set<string>) {
  const organization = detail.revision.content.organization;
  switch (organization.knowledgeKind) {
    case 'fact': return { knowledgeKind: 'fact' as const };
    case 'case': return { knowledgeKind: 'case' as const, situation: organization.situation, gaps: organization.gaps,
      omittedActions: organization.actionStatementIds.filter(id => !selected.has(id)).length,
      omittedOutcomes: organization.outcomeStatementIds.filter(id => !selected.has(id)).length };
    case 'method': return { knowledgeKind: 'method' as const, purpose: organization.purpose,
      omittedInstructions: organization.instructionStatementIds.filter(id => !selected.has(id)).length };
  }
}
function statementRole(detail: Detail, statementId: string) {
  const organization = detail.revision.content.organization;
  if (organization.knowledgeKind === 'case') return { action: organization.actionStatementIds.includes(statementId), outcome: organization.outcomeStatementIds.includes(statementId) };
  if (organization.knowledgeKind === 'method') return { instruction: organization.instructionStatementIds.includes(statementId) };
  return undefined;
}
function knowledgeContext(detail: Detail, selected: Set<string>) {
  const ref = detail.grounding.entityAnalysisRef;
  return { knowledgeId: detail.revision.knowledgeId, revisionId: detail.revision.revisionId, generation: detail.history.generation,
    title: detail.revision.title, choice: detail.maintenance?.choice ?? null, reviewStatus: detail.reviewStatus,
    organization: organizationContext(detail, selected), statementScope: { returned: selected.size, total: detail.revision.content.statements.length },
    identityUncertainties: detail.grounding.identityUncertainties,
    ...(ref ? { entityAnalysisRef: ref, entityBindingStatus: detail.entityAnalysis?.status !== 'available' ? 'unavailable' as const
      : detail.entityAnalysis.history.writeHeadRevisionId === ref.revisionId ? 'current' as const : 'outdated' as const } : {}) };
}
function entityContext(detail: Detail, entity: KnowledgeDraft['entities'][number], knowledge: number) {
  const identity = detail.entityAnalysis?.status === 'available' ? detail.entityAnalysis.revision.entities.find(value => value.entityId === entity.entityId) : undefined;
  return { ...entity, knowledge, ...(identity ? { referentKind: identity.referentKind, identityStatus: identity.identityStatus,
    ...(identity.qualifiers.length ? { qualifiers: identity.qualifiers } : {}), ...(identity.uncertainties.length ? { uncertainties: identity.uncertainties } : {}) }
    : { identityDetails: 'unavailable' as const }) };
}
function sourceContext(detail: Detail, index: number) {
  const binding = detail.grounding.sourceBindings[index], resolution = detail.sources[index];
  return { snapshotId: binding.snapshotId, sourceVersion: binding.sourceVersion,
    ...(resolution?.status === 'available' ? { status: 'available' as const, sourceKind: resolution.window.sourceKind }
      : { status: 'unavailable' as const, reason: resolution?.status === 'unavailable' ? resolution.reason : 'unbound_source' }) };
}
type Locator = { source: number | null; evidenceRef: string; start: number; end: number;
  positionStatus: 'matched' | 'mismatch' | 'unavailable'; sourceRole?: string; sourceTimestamp?: string };
type Evidence = { knowledge: number; evidenceLinkId: string; relation: 'supports' | 'opposes' | 'background';
  basis: 'direct_observation' | 'source_assertion' | 'inference'; locators: Locator[] };
export interface KnowledgeRetrievalProjection {
  projectionKind: 'knowledge-task-context'; schemaVersion: 2;
  omitted: { oversizedUnits: number; budgetUnits: number; identityRelations: true }; scopeDiagnostics?: ScopeDiagnostics;
  knowledge: (ReturnType<typeof knowledgeContext> & { scopeEntities?: number[] })[]; entities: ReturnType<typeof entityContext>[]; sources: ReturnType<typeof sourceContext>[]; evidence: Evidence[];
  items: { knowledge: number; statement: Statement; organizationRole?: ReturnType<typeof statementRole>; entities: number[]; evidence: number[] }[];
}
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function insert<T>(pool: T[], indices: Map<string, number>, key: string, create: () => T): number {
  const previous = indices.get(key); if (previous !== undefined) return previous;
  const index = pool.length; indices.set(key, index); pool.push(create()); return index;
}
function measure(result: KnowledgeRetrievalResult): number { return Buffer.byteLength(JSON.stringify(result), 'utf8') + 1; }
function project(units: Unit[], matchedUnits: number, oversizedUnits: number, scopeDiagnostics: ScopeDiagnostics): KnowledgeRetrievalResult {
  const result: KnowledgeRetrievalProjection = { projectionKind: 'knowledge-task-context', schemaVersion: 2,
    omitted: { oversizedUnits, budgetUnits: matchedUnits - oversizedUnits - units.length, identityRelations: true },
    ...(Object.keys(scopeDiagnostics).length ? { scopeDiagnostics } : {}),
    knowledge: [], entities: [], sources: [], evidence: [], items: [] };
  const knowledge = new Map<string, number>(), entities = new Map<string, number>(), sources = new Map<string, number>(), evidence = new Map<string, number>();
  const selected = new Map<string, Set<string>>();
  for (const unit of units) { const key = unit.detail.revision.knowledgeId; const ids = selected.get(key) ?? new Set<string>(); ids.add(unit.statement.statementId); selected.set(key, ids); }
  for (const { detail, statement, scopeEntityId } of units) {
    const key = `${detail.revision.knowledgeId}/${detail.revision.revisionId}`;
    const knowledgeIndex = insert(result.knowledge, knowledge, key, () => knowledgeContext(detail, selected.get(detail.revision.knowledgeId)!));
    const entityIds = new Set([statement.subject.entityId, ...(statement.object ? [statement.object.entityId] : [])]);
    const identityRef = detail.grounding.entityAnalysisRef;
    const addEntity = (entity: KnowledgeDraft['entities'][number]) => insert(result.entities, entities,
      `${identityRef ? `${identityRef.analysisId}/${identityRef.revisionId}` : key}/${JSON.stringify(entity)}`, () => entityContext(detail, entity, knowledgeIndex));
    const entityIndices = detail.revision.entities.filter(entity => entityIds.has(entity.entityId)).map(addEntity);
    if (scopeEntityId && !entityIds.has(scopeEntityId)) {
      const scopeEntity = detail.revision.entities.find(entity => entity.entityId === scopeEntityId)!;
      const scopeIndex = addEntity(scopeEntity), context = result.knowledge[knowledgeIndex];
      context.scopeEntities ??= []; if (!context.scopeEntities.includes(scopeIndex)) context.scopeEntities.push(scopeIndex);
    }
    const evidenceIndices = detail.revision.evidence.filter(link => link.statementIds.includes(statement.statementId)).map(link => insert(result.evidence, evidence, `${key}/${link.evidenceLinkId}`, () => ({
      knowledge: knowledgeIndex, evidenceLinkId: link.evidenceLinkId, relation: link.relation, basis: link.basis,
      locators: detail.grounding.citations.filter(value => value.evidenceLinkId === link.evidenceLinkId).map(({ selection }) => {
        const index = detail.grounding.sourceBindings.findIndex(binding => binding.evidenceRefs.includes(selection.evidenceRef));
        const resolution = detail.sources[index];
        const source = index < 0 ? null : insert(result.sources, sources, JSON.stringify(sourceContext(detail, index)), () => sourceContext(detail, index));
        const excerpt = resolution?.status === 'available' ? resolution.window.excerpts.find(value => value.evidenceRef === selection.evidenceRef) : undefined;
        return { source, evidenceRef: selection.evidenceRef, start: selection.start, end: selection.end,
          positionStatus: resolution?.status !== 'available' ? 'unavailable' as const
            : validateEvidenceSelection(selection, resolution.window.excerpts).length ? 'mismatch' as const : 'matched' as const,
          ...(excerpt?.role ? { sourceRole: excerpt.role } : {}), ...(excerpt?.timestamp ? { sourceTimestamp: excerpt.timestamp } : {}) };
      }),
    })));
    result.items.push({ knowledge: knowledgeIndex, statement, ...(statementRole(detail, statement.statementId) ? { organizationRole: statementRole(detail, statement.statementId) } : {}), entities: entityIndices, evidence: evidenceIndices });
  }
  return encodeKnowledgeContext(result);
}
function literalHits(fields: string[], terms: string[]): Set<string> {
  const normalized = fields.map(value => value.normalize('NFKC').toLowerCase());
  return new Set(terms.filter(term => normalized.some(value => value.includes(term))));
}
function entityFields(detail: Detail, ids: Set<string>): string[] {
  const fields = detail.revision.entities.filter(entity => ids.has(entity.entityId)).flatMap(entity => [entity.label, entity.description]);
  if (detail.entityAnalysis?.status === 'available') fields.push(...detail.entityAnalysis.revision.entities
    .filter(entity => ids.has(entity.entityId)).flatMap(entity => entity.qualifiers.filter(Boolean)));
  return fields;
}
function documentHits(detail: Detail, terms: string[]): Set<string> {
  return literalHits([detail.revision.title, ...detail.tagging.tags,
    ...entityFields(detail, new Set(detail.revision.entities.map(entity => entity.entityId))),
    ...textValues(organizationContext(detail, new Set()))], terms);
}
function statementHits(detail: Detail, statement: Statement, terms: string[]): Set<string> {
  return literalHits([statement.relation, ...textValues(statement.context), ...entityFields(detail,
    new Set([statement.subject.entityId, ...(statement.object ? [statement.object.entityId] : [])]))], terms);
}
function stableOrder(a: Unit, b: Unit): number {
  return Date.parse(b.detail.revision.revisedAt) - Date.parse(a.detail.revision.revisedAt)
    || compareId(a.detail.revision.knowledgeId, b.detail.revision.knowledgeId) || compareId(a.statement.statementId, b.statement.statementId);
}
/** Current revisions, no filesystem writes, executor calls, raw-source fallback or name merging. */
export function retrieveKnowledge(app: Pick<KnowledgeApplication, 'list' | 'detail' | 'source'>, input: KnowledgeRetrievalRequest): KnowledgeRetrievalResult {
  const request = KnowledgeRetrievalRequestSchema.parse(input), terms = knowledgeRetrievalTerms(request.query);
  const fullHanRuns = new Set([...request.query.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+/gu)].map(match => match[0]));
  const derivedBigrams = new Set(terms.filter(term => /^\p{Script=Han}{2}$/u.test(term) && !fullHanRuns.has(term)));
  const source = request.snapshot ? app.source(request.snapshot, request.sourceVersion) : undefined;
  let entityMatched = false; const candidates: Unit[] = [];
  for (const row of app.list()) {
    if (row.choice !== 'retain' && !(request.includeCandidates && row.choice === null)) continue;
    const detail = app.detail(row.knowledgeId, row.revisionId);
    if (detail.history.writeHeadRevisionId !== row.revisionId) throw new Error('Knowledge changed during retrieval. Reload and retry.');
    if (detail.maintenance?.choice !== 'retain' && !(request.includeCandidates && !detail.maintenance)) continue;
    if (request.snapshot && !detail.grounding.sourceBindings.some(binding => binding.snapshotId === request.snapshot && (!request.sourceVersion || binding.sourceVersion === request.sourceVersion))) continue;
    if (request.entityId && !detail.revision.entities.some(entity => entity.entityId === request.entityId)) continue;
    if (request.entityId) entityMatched = true;
    const recalled = documentHits(detail, terms);
    for (const statement of detail.revision.content.statements) {
      const hits = statementHits(detail, statement, terms);
      if (hits.size || recalled.size) candidates.push({ detail, statement, hits, documentHits: recalled, costBytes: 0,
        ...(request.entityId ? { scopeEntityId: request.entityId } : {}) });
    }
  }
  const scopeDiagnostics: ScopeDiagnostics = { ...(source ? { source: source.status === 'available' ? { status: 'available' as const } : { status: 'unavailable' as const, reason: source.reason } } : {}),
    ...(request.entityId ? { entity: entityMatched ? 'matched_knowledge' as const : 'no_eligible_knowledge' as const } : {}) };
  candidates.sort(stableOrder);
  for (const candidate of candidates) candidate.costBytes = measure(project([candidate], 1, 0, scopeDiagnostics));
  const oversized = new Set(candidates.filter(candidate => candidate.costBytes > request.maxBytes));
  const chosen: Unit[] = [], remaining = new Set(candidates), covered = new Set<string>(), coveredDocuments = new Set<string>();
  const projected = (units: Unit[]) => project(units, candidates.length, [...oversized].filter(unit => !units.includes(unit)).length, scopeDiagnostics);
  let result = projected(chosen);
  if (measure(result) > request.maxBytes) throw new KnowledgeRetrievalBudgetError(measure(result));
  while (remaining.size) {
    let best: { unit: Unit; result: KnowledgeRetrievalResult; gain: number; cost: number; novel: number } | undefined;
    const currentBytes = measure(result);
    for (const unit of remaining) {
      const next = projected([...chosen, unit]), nextBytes = measure(next);
      if (nextBytes > request.maxBytes) continue;
      const novelTerms = [...unit.hits].filter(term => !covered.has(term)), novel = novelTerms.length;
      // Overlapping Han bigrams retain literal recall but get less novelty weight than identifiers or complete query runs.
      const novelty = novelTerms.reduce((gain, term) => gain + (derivedBigrams.has(term) ? 1 : 4), 0);
      const documentNovel = [...unit.documentHits].filter(term => !coveredDocuments.has(term)).length;
      // Document fields recall a revision; only fresh document coverage is rewarded, never copied into every statement score.
      const gain = Math.max(1, novelty + unit.hits.size + documentNovel), cost = Math.max(1, nextBytes - currentBytes);
      if (!best || gain * best.cost > best.gain * cost
        || (gain * best.cost === best.gain * cost && (novel > best.novel
          || (novel === best.novel && (unit.hits.size > best.unit.hits.size
            || (unit.hits.size === best.unit.hits.size && stableOrder(unit, best.unit) < 0)))))) best = { unit, result: next, gain, cost, novel };
    }
    if (!best) break;
    chosen.push(best.unit); remaining.delete(best.unit); result = best.result;
    best.unit.hits.forEach(term => covered.add(term)); best.unit.documentHits.forEach(term => coveredDocuments.add(term));
  }
  return result;
}
