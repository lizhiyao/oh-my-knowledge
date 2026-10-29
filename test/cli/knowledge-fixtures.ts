import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createLocalKnowledgeApplication } from '../../src/knowledge/application/local.js';
import { FileKnowledgeStore } from '../../src/knowledge/adapters/knowledge-store.js';
import { FileEntityAnalysisStore } from '../../src/knowledge/adapters/entity-store.js';
import { FileKnowledgeAssociationStore } from '../../src/knowledge/adapters/association-store.js';
import { knowledgeBodyDigest, knowledgeBodyRef } from '../../src/knowledge/adapters/body-digest.js';
import type { EvidenceExcerpt } from '../../src/knowledge/contracts.js';

/** Authored protocol responses, never a model quality observation. */
export function authoredKnowledgeResponse(input: string, stage: 'body' | 'association') {
  const data = JSON.parse(input) as { excerpts?: EvidenceExcerpt[]; sources?: { sourceKey: string; excerpts: EvidenceExcerpt[] }[]; bodies?: { bodyKey: string }[] };
  const excerpt = (data.excerpts ?? data.sources?.[0].excerpts ?? [])[0];
  const sourceKey = data.sources?.[0].sourceKey ?? 's0';
  if (stage === 'body') return { responseKind: 'knowledge-body-generation', schemaVersion: 1, proposals: [{ proposalId: 'p1', title: '选定来源的完整条件',
    segments: [{ segmentId: 's1', text: `来源报告：${excerpt.text}。事实发生时间及未来适用范围未知。`, evidence: [{ evidenceRef: excerpt.evidenceRef,
      quote: excerpt.text, occurrence: null, basis: 'source_assertion', interpretation: null }] }], organization: null, reuseRationale: '后续核对相同条件' }] };
  return { responseKind: 'knowledge-association-generation', schemaVersion: 2,
    catalogs: [{ sourceKey, entities: ['Alpha', 'Beta'].map((label, index) => ({ entityId: `e${index}`, label, description: `所选来源中的${label}`, qualifiers: [], identityStatus: 'proposed',
      possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null })),
    mentions: ['Alpha', 'Beta'].map((quote, index) => ({ mentionId: `m${index}`, entityId: `e${index}`, selection: { evidenceRef: excerpt.evidenceRef, quote, occurrence: null }, basis: 'explicit', rationale: '精确来源提及' })) }],
    associations: (data.bodies ?? []).map(body => ({ bodyKey: body.bodyKey,
      segmentEntityRefs: ['Alpha', 'Beta'].map((_label, index) => ({ segmentId: 's1', sourceKey, entityId: `e${index}`, mentionIds: [`m${index}`] })), typedRelations: [], issues: [] })) };
}

/** Legal public-store seed for independent CLI/host tests; no fake extraction run or native output. */
export function seedKnowledgeWorkspace(workspace: string, name: string) {
  const app = createLocalKnowledgeApplication(workspace), source = app.capture({ path: join(workspace, `${name}.jsonl`), origin: { threadId: name, title: name }, records: [{ recordIndex: 1,
    raw: JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Alpha 使用 Beta' }] } }) }] });
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
