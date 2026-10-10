import { describe, expect, it } from 'vitest';
import { applyEntityAnalysisWrite, validateEntityAnalysisHistory } from '../../src/knowledge/entities/history.js';
import { EntityAnalysisEnvelopeSchema, type EntityAnalysisWrite } from '../../src/knowledge/entities/contracts.js';
import { admitEntities, type EntityModel } from '../../src/observability/knowledge-extraction/entities.js';
import { checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/window-proposals.js';
import { identityWindow } from './fixtures.js';

const entityId = 'cf13bba6-6385-455b-b0c0-c4d4e4931b10';
const mentionId = '6ad46f7c-7959-43b4-ae97-c240f9a1c422';
const revisionId = '4b345101-b542-4ac3-87c1-f05cdf0356b7';
const actor = { actorKind: 'human' as const, actorId: 'reviewer' };
const entity = (entityId: string): EntityModel => ({ entityId, label: 'Echo', description: '选定窗口中的对象',
  qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [], referentKind: 'object', componentRef: null, collection: null });
const mention = (entityId: string, mentionId: string, quote = 'Echo') => ({ entityId, mentionId,
  selection: { evidenceRef: 'r', quote } as { evidenceRef: string; quote: string; occurrence?: number }, basis: 'explicit' as const, rationale: '原文明确出现' });
const excerpts = [{ evidenceRef: 'r', text: '😀 Echo 调用 Echo，前者是服务，后者是工具。' }];

describe('window entity admission', () => {
  it('admits one collective mention and rejects dependent entities and knowledge when a component link is broken', () => {
    const packet = identityWindow(); const source = [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta；它们共同失败。' }];
    const accepted = checkWindowExtractionResponse(packet, source);
    expect(accepted.analysis.rejected).toEqual([]); expect(accepted.accepted).toHaveLength(1);
    expect(accepted.analysis.mentions.filter(mention => mention.selection.quote === '它们')).toHaveLength(1);
    packet.entities[1].componentRef!.entityId = 'missing';
    const before = structuredClone(packet); const rejected = checkWindowExtractionResponse(packet, source);
    expect(rejected.analysis.entities.map(entity => entity.entityId)).toEqual(['project']);
    expect(rejected.analysis.rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'entity', index: 1, reasons: expect.arrayContaining(['unknown_component']) }),
      expect.objectContaining({ component: 'entity', index: 2, reasons: expect.arrayContaining(['unknown_collection_member']) }),
    ]));
    expect(rejected.accepted).toEqual([]); expect(rejected.rejected[0].reasons).toContain('unknown_entity_analysis_reference');
    expect(packet).toEqual(before);
  });
  it('preserves distinct same-named objects and immutable raw output', () => {
    const first = mention('service', 'm1'); first.selection = { ...first.selection, occurrence: 0 };
    const second = mention('tool', 'm2'); second.selection = { ...second.selection, occurrence: 1 };
    const input = { entities: [entity('service'), entity('tool')], mentions: [first, second] };
    const before = structuredClone(input);
    const result = admitEntities(input.entities, input.mentions, excerpts);
    expect(result.rejected).toEqual([]);
    expect(result.entities.map(value => value.entityId)).toEqual(['service', 'tool']);
    expect(result.mentions.map(value => value.selection.start)).toEqual([3, 11]);
    expect(input).toEqual(before);
  });
  it('rejects all colliding identities even when one object has invalid structure', () => {
    const result = admitEntities([entity('a'), { entityId: 'a' }], [mention('a', 'm')], [{ evidenceRef: 'r', text: 'Echo' }]);
    expect(result.entities).toEqual([]); expect(result.mentions).toEqual([]);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { component: 'entity', index: 0, reasons: ['duplicate_entity'] },
      { component: 'entity', index: 1, reasons: ['invalid_structure'] },
      { component: 'mention', index: 0, reasons: ['unknown_entity'] },
    ]));
  });
  it('keeps ambiguity as a local identity with possible targets rather than choosing one', () => {
    const uncertain: EntityModel = { ...entity('unknown'), identityStatus: 'unresolved',
      possibleEntityIds: ['a', 'b'], uncertainties: ['原文没有说明是哪一个'] };
    const result = admitEntities([entity('a'), entity('b'), uncertain],
      [mention('a', 'm1', 'Queue'), mention('b', 'm2', 'Cache'), { ...mention('unknown', 'm3', '它'), basis: 'inference' }],
      [{ evidenceRef: 'r', text: 'Queue 和 Cache；它失败了。' }]);
    expect(result.rejected).toEqual([]);
    expect(result.entities[2]).toEqual(uncertain);
    expect(result.mentions[2].entityId).toBe('unknown');
  });
  it('rejects unsupported dependencies through to their mentions while retaining unrelated results', () => {
    const unknown = { ...entity('unknown'), identityStatus: 'unresolved', possibleEntityIds: ['missing'], uncertainties: ['缺少先行项'] };
    const result = admitEntities([entity('good'), entity('missing'), unknown],
      [mention('good', 'good', 'Echo'), mention('missing', 'bad', 'Fabricated'), mention('unknown', 'unknown', '它')],
      [{ evidenceRef: 'r', text: 'Echo；它。' }]);
    expect(result.entities.map(value => value.entityId)).toEqual(['good']);
    expect(result.mentions.map(value => value.mentionId)).toEqual(['good']);
    expect(result.rejected).toEqual(expect.arrayContaining([
      { component: 'mention', index: 1, reasons: ['quote_mismatch'] },
      { component: 'entity', index: 1, reasons: ['entity_without_mention'] },
      { component: 'entity', index: 2, reasons: ['unknown_possible_entity'] },
    ]));
  });
  it('rejects duplicate positions and unexplained ambiguity while accepting empty output', () => {
    expect(admitEntities([], [], excerpts)).toEqual({ entities: [], mentions: [], rejected: [] });
    const duplicate = admitEntities([entity('a'), entity('b')], [mention('a', 'm1'), mention('b', 'm2')], [{ evidenceRef: 'r', text: 'Echo' }]);
    expect(duplicate.entities).toEqual([]);
    expect(duplicate.rejected.filter(value => value.component === 'mention')).toHaveLength(2);
    expect(admitEntities([{ ...entity('a'), identityStatus: 'unresolved' }], [], excerpts).rejected[0].reasons).toEqual(['invalid_structure']);
  });
  it('keeps a known partial group distinct from unknown identity and requires candidates at the same level', () => {
    const group: EntityModel = { ...entity('group'), referentKind: 'collection', uncertainties: ['其它成员未列出'],
      collection: { memberEntityIds: ['a'], completeness: 'partial', mentionIds: ['m2'], rationale: '明确的集合及一个成员' } };
    const uncertain: EntityModel = { ...entity('unknown'), referentKind: 'collection', identityStatus: 'unresolved',
      possibleEntityIds: ['group'], uncertainties: ['不确定指哪个集合'],
      collection: { memberEntityIds: [], completeness: 'unknown', mentionIds: ['m3'], rationale: '未消解集合指代' } };
    const source = [{ evidenceRef: 'r', text: 'Echo 和其它成员；它们还在；那些失败了。' }];
    const mentions = [mention('a', 'm1'), mention('group', 'm2', '它们'), mention('unknown', 'm3', '那些')];
    expect(admitEntities([entity('a'), group, uncertain], mentions, source).rejected).toEqual([]);
    uncertain.possibleEntityIds = ['a'];
    expect(admitEntities([entity('a'), group, uncertain], mentions, source).rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'entity', index: 2, reasons: ['possible_entity_level_mismatch'] }),
    ]));
  });
});

function command(): EntityAnalysisWrite {
  return { requestId: '74f1de95-fb7e-4127-9d92-b3eec8995f6f', analysisId: '3a6a21a3-54aa-4f54-952f-e605917db9e1',
    snapshotId: '98626a7c-7cc2-401b-862d-38e178396ecb', sourceVersion: `sha256:${'a'.repeat(64)}`,
    expectedGeneration: 0, expectedHeadRevisionId: null,
    revision: { revisionId, revisedAt: '2026-10-10T00:00:00Z', revisedBy: actor, revisionReason: '核对来源',
      entities: [{ ...entity(entityId) }], mentions: [{ ...mention(entityId, mentionId), selection: { evidenceRef: 'r', quote: 'Echo', start: 0, end: 4 } }], limitations: [] },
  };
}
describe('entity correction history', () => {
  it('appends corrections without changing the old revision and checks idempotency before generation', () => {
    const birth = command(); const first = applyEntityAnalysisWrite(undefined, birth, actor, 'birth');
    expect(applyEntityAnalysisWrite(first, birth, actor, 'birth')).toBe(first);
    expect(() => applyEntityAnalysisWrite(first, birth, actor, 'changed')).toThrow('idempotency');
    const edit = structuredClone(birth);
    edit.requestId = '33c0660d-2d8d-45f6-9e58-1d96f12ed7d5'; edit.expectedGeneration = 1; edit.expectedHeadRevisionId = revisionId;
    edit.revision.revisionId = '10eb73c8-97c4-4d87-9f6b-0200b6746c39'; edit.revision.parentRevisionId = revisionId;
    edit.revision.entities[0].label = '构建服务 Echo';
    const next = applyEntityAnalysisWrite(first, edit, actor, 'edit');
    expect(next.revisions[0]).toEqual(birth.revision);
    expect(next.revisions[1].entities[0].label).toBe('构建服务 Echo');
    expect(() => applyEntityAnalysisWrite(next, { ...edit, requestId: '7bf2d5bd-7884-4d74-92c7-9793ff113189' }, actor, 'stale')).toThrow('conflict');
    expect(EntityAnalysisEnvelopeSchema.parse(next)).toEqual(next);
  });
  it('rejects author impersonation and moving a mention identity to another position', () => {
    expect(() => applyEntityAnalysisWrite(undefined, command(), { ...actor, actorId: 'other' }, 'birth')).toThrow('unauthorized');
    const history = applyEntityAnalysisWrite(undefined, command(), actor, 'birth');
    const edited = structuredClone(history.revisions[0]);
    edited.revisionId = '10eb73c8-97c4-4d87-9f6b-0200b6746c39'; edited.parentRevisionId = revisionId;
    edited.mentions[0].selection.start = 5; edited.mentions[0].selection.end = 9;
    expect(() => applyEntityAnalysisWrite(history, { ...command(), requestId: '33c0660d-2d8d-45f6-9e58-1d96f12ed7d5',
      expectedGeneration: 1, expectedHeadRevisionId: revisionId, revision: edited }, actor, 'edit')).toThrow('moved');
    const corrupt = structuredClone(history); corrupt.receipts[0].committedGeneration = 9;
    expect(() => validateEntityAnalysisHistory(corrupt)).toThrow('receipts');
  });
  it('permits removing false mentions to leave an empty independent result', () => {
    const input = command(); input.revision.entities = []; input.revision.mentions = [];
    expect(applyEntityAnalysisWrite(undefined, input, actor, 'empty').revisions[0].entities).toEqual([]);
  });
});
