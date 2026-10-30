import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { KnowledgeApplication } from '../../src/knowledge/application/application.js';
import type { SourceCoverageData, SourceCoverageWrite, SourceLedgerData, SourceReviewManifest } from '../../src/knowledge/source-review.js';
import type { EvidenceExcerpt } from '../../src/knowledge/contracts.js';
import { readTraceSource } from '../../src/knowledge/adapters/trace-source-reader.js';
import { FileSourceStore } from '../../src/knowledge/adapters/source-store.js';

/** Authored protocol responses, never a model quality observation. */
export function authoredKnowledgeResponse(input: string, stage: 'source_ledger' | 'body' | 'source_coverage' | 'association') {
  const data = JSON.parse(input) as { excerpts?: EvidenceExcerpt[]; sources?: { sourceKey: string; excerpts: EvidenceExcerpt[] }[];
    manifest?: SourceReviewManifest; units?: { unitKey: string; unitKind: string; text: string }[]; ledger?: { data: SourceLedgerData };
    targets?: { targetKey: string; target: SourceCoverageData['checks'][number]['target'] }[];
    bodies?: { bodyKey: string; segments?: { segmentId: string; text: string }[]; content: { segments: { segmentId: string; text: string }[] } }[] };
  if (stage === 'source_ledger') {
    const units = data.units ?? [], retained = units.filter(unit => unit.unitKind === 'excerpt_text');
    return { responseKind: 'knowledge-source-ledger', schemaVersion: 2,
      unitDispositions: units.map(unit => ({ unitKey: unit.unitKey, disposition: unit.unitKind === 'excerpt_text' ? 'retain' : 'pending',
        reason: 'Authored protocol inventory, not semantic acceptance.' })),
      items: retained.map(unit => ({ itemId: unit.unitKey, statement: 'The selected excerpt contains this authored source assertion.', disposition: 'retain',
        reason: 'Authored wire fixture.', equivalentItemIds: [], evidence: [{ unitKey: unit.unitKey, quote: unit.text, contextBefore: null, contextAfter: null }], facets: [] })), limitations: ['Authored protocol output, not a model quality observation.'] };
  }
  if (stage === 'source_coverage') {
    const units = data.units ?? [], bodies = data.bodies ?? [];
    const source = (unitKey: string) => { const unit = units.find(unit => unit.unitKey === unitKey)!; return { unitKey, quote: unit.text, contextBefore: null, contextAfter: null }; };
    const bodyEvidence = bodies.flatMap(body => (body.segments ?? body.content.segments).map(segment => ({ bodyKey: body.bodyKey, segmentId: segment.segmentId, quote: segment.text, contextBefore: null, contextAfter: null })));
    const targets = (data.targets ?? []).map(({ targetKey, target }) => {
      if (target.targetKind === 'source_unit') return { targetKey, sourceEvidence: [source(target.unitKey)] };
      if (target.targetKind === 'ledger_item' || target.targetKind === 'ledger_facet') {
        const item = data.ledger!.data.items.find(item => item.itemId === target.itemId)!;
        const evidence = target.targetKind === 'ledger_facet' ? item.facets.find(facet => facet.facetId === target.facetId)!.evidence : item.evidence;
        return { targetKey, sourceEvidence: evidence.map(anchor => source(anchor.unitKey)) };
      }
      return { targetKey, sourceEvidence: units.length ? [source(units[0].unitKey)] : [] };
    });
    return { responseKind: 'knowledge-source-coverage', schemaVersion: 2, checks: targets.map((value, index) => ({ ...value, checkId: `check-${index}`, coverageTarget: 'knowledge_meaning',
      status: 'unassessable', factualValue: 'not_applicable', reason: 'Authored protocol check requiring an explicit actual disposition.', bodyEvidence, boundedInput: null })), findings: [], limitations: ['Authored fixture has no semantic or factual acceptance.'] };
  }
  const excerpt = (data.excerpts ?? data.sources?.[0].excerpts ?? [])[0];
  const sourceKey = data.sources?.[0].sourceKey ?? 's0';
  if (stage === 'body') return { responseKind: 'knowledge-body-generation', schemaVersion: 2, proposals: [{ proposalId: 'p1', title: '选定来源的完整条件', requiredContexts: [],
    segments: [{ segmentId: 's1', text: `来源报告：${excerpt.text}。事实发生时间及未来适用范围未知。`, evidence: [{ evidenceRef: excerpt.evidenceRef,
      quote: excerpt.text, contextBefore: null, contextAfter: null, basis: 'source_assertion', interpretation: null }] }], organization: null, reuseRationale: '后续核对相同条件' }] };
  return { responseKind: 'knowledge-association-generation', schemaVersion: 3,
    catalogs: [{ sourceKey, entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: `e${index}`, label, description: `所选来源中的${label}`, qualifiers: [], identityStatus: 'proposed',
      possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentLink: null, collectionLink: null,
      mentions: [{ mentionKey: `m${index}`, selection: { evidenceRef: excerpt.evidenceRef, quote: label, contextBefore: null, contextAfter: null }, basis: 'explicit', rationale: '精确来源提及' }] })) }],
    associations: (data.bodies ?? []).map(body => ({ bodyKey: body.bodyKey,
      segmentDecisions: body.content.segments.map(segment => ({ segmentId: segment.segmentId, decisionKind: 'mapped', reason: '本段引用所选来源中的明确对象。',
        entityRefs: ['Alpha', 'Beta'].map((_label, index) => ({ sourceKey, entityId: `e${index}`, mentionKeys: [`m${index}`] })) })), typedRelations: [], issues: [] })) };
}


/** A named test operator must still explicitly publish this complete command. */
export function authoredSourceDecision(status: ReturnType<KnowledgeApplication['sourceCoverageStatus']>): Extract<SourceCoverageWrite, { commandKind: 'record_decision' }> {
  if (status.unresolvedIds === null) throw new Error('Authored source inventory unavailable.');
  return { commandKind: 'record_decision', coverageId: status.ref.coverageId, requestId: randomUUID(), expectedGeneration: status.history.generation, expectedHeadEventId: status.history.writeHeadEventId,
    decision: { coverageRef: status.ref, sourceSetId: status.revision.data.manifest.sourceSetId, ledgerRef: status.revision.data.ledgerRef, bodyRefs: status.revision.data.bodyRefs,
      decisionKind: 'proceed_with_limits', reason: 'Explicit authored test operator disposition; not a semantic quality acceptance.', limitations: ['Authored protocol test only; no measured model quality.'],
      dispositions: status.unresolvedIds.map(unresolvedId => ({ unresolvedId, disposition: 'accepted_limit', reason: 'Explicitly retain this authored-test limitation.' })), supersedesEventIds: [] } };
}

/** Legal public-store seed for independent CLI/host tests; no fake extraction run or native output. */
export function seedKnowledgeWorkspace(workspace: string, name: string) {
  const app = createLocalKnowledgeApplication(workspace), projection = readTraceSource({ sourceKind: 'agent_trace', sourceId: `fixture:${name}`, traceKind: 'codex', recordRanges: [{ startRecord: 1, endRecord: 1 }] },
    { sourceId: `fixture:${name}`, traceKind: 'codex', origin: { threadId: name, title: name }, source: { sourceType: 'records', records: [{ recordIndex: 1,
      raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] } }).projection;
  const source = new FileSourceStore(join(workspace, 'sources'), workspace).capture(projection).snapshot;
  const actor = { actorKind: 'human' as const, actorId: 'authored-cli-fixture' }, at = '2026-10-28T00:00:00Z', analysisId = randomUUID(), entityRevisionId = randomUUID();
  const entityIds = [randomUUID(), randomUUID()], mentionIds = [randomUUID(), randomUUID()];
  const catalog = { entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: entityIds[index], label, description: `此窗口中的${label}`, qualifiers: [], identityStatus: 'proposed' as const,
    possibleEntityIds: [], uncertainties: [], referentKind: 'object' as const, componentRef: null, collection: null })),
    mentions: ['Alpha', 'Beta'].map((quote, index) => ({ mentionId: mentionIds[index], entityId: entityIds[index], selection: { evidenceRef: source.excerpts[0].evidenceRef,
      quote, start: index ? 9 : 0, end: index ? 13 : 5 }, basis: 'explicit' as const, rationale: '作者夹具的来源提及' })), limitations: [] };
  const entities = new FileEntityAnalysisStore(join(workspace, 'entities'), workspace);
  entities.write({ requestId: randomUUID(), analysisId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion, expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { ...catalog, revisionId: entityRevisionId, revisedAt: at, revisedBy: actor, revisionReason: '公开实体存储夹具，非native结果' } }, actor);
  const draft = { title: '选定来源的完整条件', reuseRationale: '相同条件下复核', content: { segments: [{ segmentId: 's1', text: '来源报告 Alpha 使用 Beta；事实时间和其他适用条件未知。',
    evidence: [{ source: { snapshotId: source.snapshotId, sourceVersion: source.sourceVersion }, selection: { evidenceRef: source.excerpts[0].evidenceRef, quote: 'Alpha 使用 Beta', start: 0, end: 13 }, basis: 'source_assertion' as const }] }] } };
  const body = { ...draft, knowledgeId: randomUUID(), revisionId: randomUUID(), bodyDigest: knowledgeBodyDigest(draft), observationRefs: [], derivations: [],
    createdAt: at, createdBy: actor, revisedAt: at, revisedBy: actor, revisionReason: '公开正文存储夹具，非native结果' };
  const knowledge = new FileKnowledgeStore(join(workspace, 'items'), 'local', workspace);
  knowledge.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: body.knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null, revision: body }, actor);
  const associations = new FileKnowledgeAssociationStore(join(workspace, 'associations'), 'local', knowledge, entities, workspace);
  associations.write({ commandKind: 'append_revision', requestId: randomUUID(), knowledgeId: body.knowledgeId, expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { revisionId: randomUUID(), bodyRef: knowledgeBodyRef(body), status: 'available', reviewStatus: 'pending', catalogRefs: [{ analysisId, entityRevisionId }],
      segmentEntityRefs: entityIds.map((entityId, index) => ({ segmentId: 's1', analysisId, entityRevisionId, entityId, mentionIds: [mentionIds[index]] })), issues: [], revisedAt: at, revisedBy: actor, revisionReason: '独立派生夹具' } }, actor);
  return { source, body, analysis: app.entities(analysisId), ref: (index = 0) => ({ analysisId, entityId: entityIds[index] }) };
}
