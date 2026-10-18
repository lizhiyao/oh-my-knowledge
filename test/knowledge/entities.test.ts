import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { applyEntityAnalysisWrite, validateEntityAnalysisHistory } from '../../src/knowledge/entities/history.js';
import { EntityAnalysisEnvelopeSchema, type EntityAnalysisWrite } from '../../src/knowledge/entities/contracts.js';
import { KnowledgeDraftSchema } from '../../src/knowledge/contracts.js';
import { admitEntities, type EntityModel } from '../../src/observability/knowledge-extraction/extraction/entities.js';
import { WindowExtractionModelSchema, checkWindowExtractionResponse } from '../../src/observability/knowledge-extraction/extraction/window-proposals.js';
import { identityWindow, modelWindow, wireModelWindow } from './fixtures.js';
import { decodeWindowExtractionWire, WINDOW_EXTRACTION_WIRE_HOST_ONLY, WINDOW_EXTRACTION_WIRE_ID, WINDOW_EXTRACTION_WIRE_IDENTITY, WINDOW_EXTRACTION_WIRE_SCHEMA, WINDOW_EXTRACTION_WIRE_SCHEMA_JSON } from '../../src/observability/knowledge-extraction/extraction/model-wire.js';
import { EXTRACTION_PROMPT, EXTRACTION_PROMPT_VERSION } from '../../src/observability/knowledge-extraction/extraction/prompt.js';
import { STRICT_EXTRACTION_PROMPT, STRICT_EXTRACTION_PROMPT_VERSION } from '../../src/observability/knowledge-extraction/extraction/strict-prompt.js';
import { STRICT_EXTRACTION_FEWSHOT_BLOCK, STRICT_EXTRACTION_FEWSHOT_EXAMPLES, STRICT_EXTRACTION_PARTIAL_ADMISSION_DIAGNOSTIC, renderStrictExtractionFewshotBlock } from '../../src/observability/knowledge-extraction/extraction/strict-fewshot.js';

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
  it('rejects an identifier substring at its requested occurrence without shifting to a later concept mention', () => {
    const source = [{ evidenceRef: 'r', text: '_pendingTaskStatus；固定 Task；迟到事件不影响新 Task。' }];
    const mentions = [mention('task', 'bad', 'Task'), mention('task', 'good', 'Task')];
    mentions[0].selection.occurrence = 0; mentions[1].selection.occurrence = 1;
    const input = { entities: [entity('task')], mentions };
    const before = structuredClone(input);
    const admitted = admitEntities(input.entities, mentions, source);
    expect(admitted.rejected).toEqual([{ component: 'mention', index: 0, reasons: ['mention_identifier_fragment'] }]);
    expect(admitted.mentions).toEqual([expect.objectContaining({ mentionId: 'good', selection: {
      evidenceRef: 'r', quote: 'Task', start: source[0].text.indexOf('Task', 13), end: source[0].text.indexOf('Task', 13) + 4,
    } })]);
    expect(input).toEqual(before);
    const unsupported = admitEntities(input.entities, [mentions[0]], source);
    expect(unsupported.entities).toEqual([]);
    expect(unsupported.rejected).toContainEqual({ component: 'entity', index: 0, reasons: ['entity_without_mention'] });
  });
  it.each(['TaskBoard', '_pendingTaskStatus', 'task_Task', 'Task_status', 'pre$Task', 'Task42'])('rejects a partial ASCII identifier in %s', text => {
    const result = admitEntities([entity('task')], [mention('task', 'm', 'Task')], [{ evidenceRef: 'r', text }]);
    expect(result.rejected).toContainEqual({ component: 'mention', index: 0, reasons: ['mention_identifier_fragment'] });
  });
  it.each(['固定Task对象', '*Task*', '_Task_', '`Task`', 'Task 归属适配', 'Task.js', '(Task)'])('preserves possible standalone mention boundaries in %s without asserting semantic identity', text => {
    expect(admitEntities([entity('task')], [mention('task', 'm', 'Task')], [{ evidenceRef: 'r', text }]).rejected).toEqual([]);
  });
  it('admits an entire field identifier and distinct overlapping library/version mentions with an explicit component link', () => {
    const source = [{ evidenceRef: 'r', text: 'runtime 3.2 覆写 _pendingTaskStatus。' }];
    const version: EntityModel = { ...entity('version'), referentKind: 'version',
      componentRef: { entityId: 'library', mentionIds: ['v'], rationale: '该版本属于原文持续讨论的库' } };
    const result = admitEntities([{ ...entity('library'), referentKind: 'component' }, version, entity('field')],
      [mention('library', 'l', 'runtime'), mention('version', 'v', 'runtime 3.2'), mention('field', 'f', '_pendingTaskStatus')], source);
    expect(result.rejected).toEqual([]);
    expect(result.entities[1].componentRef).toEqual(version.componentRef);
    expect(result.mentions.map(item => [item.selection.start, item.selection.end])).toEqual([[0, 7], [0, 11], [15, 33]]);
  });
  it('rejects invalid analysis references without repairing them or losing valid knowledge siblings', () => {
    const packet = identityWindow();
    packet.entities = packet.entities.slice(0, 1); packet.entities[0].referentKind = 'object';
    packet.mentions = [
      { ...packet.mentions[0], selection: { evidenceRef: 'record-1', quote: 'Alpha', occurrence: 0 } },
      { ...packet.mentions[0], mentionId: 'good', selection: { evidenceRef: 'record-1', quote: 'Alpha', occurrence: 1 } },
    ];
    const candidate = packet.proposals[0]; candidate.entityIds = ['project']; candidate.mentionIds = ['m1'];
    candidate.draft.content.statements = [{ ...candidate.draft.content.statements[0], subject: { entityId: 'project' }, object: undefined }];
    candidate.draft.content.organization = { knowledgeKind: 'fact' };
    candidate.draft.evidence[0].statementIds = candidate.draft.content.statements.map(item => item.statementId);
    candidate.citations[0].selection = { evidenceRef: 'record-1', quote: 'Alpha', occurrence: 0 };
    packet.proposals.push({ ...candidate, proposalId: 'valid', mentionIds: ['good'] });
    const before = structuredClone(packet);
    const checked = checkWindowExtractionResponse(packet, [{ evidenceRef: 'record-1', text: '_prefixAlphaSuffix；Alpha。' }]);
    expect(checked.analysis.rejected).toEqual([{ component: 'mention', index: 0, reasons: ['mention_identifier_fragment'] }]);
    expect(checked.rejected).toEqual([{ index: 0, reasons: ['unknown_mention_analysis_reference'] }]);
    expect(checked.accepted.map(item => item.proposalId)).toEqual(['valid']);
    expect(checked.accepted[0].citations[0].selection.start).toBe(7);
    expect(packet).toEqual(before);

    const duplicateReferences = identityWindow();
    const valid = duplicateReferences.proposals[0];
    duplicateReferences.proposals.unshift(
      { ...structuredClone(valid), proposalId: 'duplicate-entities', entityIds: [...valid.entityIds, valid.entityIds[0]] },
      { ...structuredClone(valid), proposalId: 'duplicate-mentions', mentionIds: [...valid.mentionIds, valid.mentionIds[0]] },
    );
    const duplicateRaw = structuredClone(duplicateReferences);
    const duplicateCheck = checkWindowExtractionResponse(duplicateReferences,
      [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta；它们共同失败。' }]);
    expect(duplicateCheck.analysis.rejected).toEqual([]);
    expect(duplicateCheck.rejected).toEqual([
      { index: 0, reasons: ['duplicate_entity_reference'] },
      { index: 1, reasons: ['duplicate_mention_reference'] },
    ]);
    expect(duplicateCheck.accepted.map(proposal => proposal.proposalId)).toEqual([valid.proposalId]);
    expect(duplicateCheck.accepted[0].draft.entities).toHaveLength(valid.entityIds.length);
    expect(duplicateCheck.accepted[0].mentions).toHaveLength(valid.mentionIds.length);
    expect(duplicateReferences).toEqual(duplicateRaw);
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

    const chained: EntityModel = { ...entity('chained'), identityStatus: 'unresolved',
      possibleEntityIds: ['unknown'], uncertainties: ['候选自身尚未消解，不能当作确定候选'] };
    const input = { entities: [entity('a'), entity('b'), uncertain, chained],
      mentions: [mention('a', 'm1', 'Queue'), mention('b', 'm2', 'Cache'),
        { ...mention('unknown', 'm3', '它'), basis: 'inference' as const },
        { ...mention('chained', 'm4', '那个'), basis: 'inference' as const }] };
    const before = structuredClone(input);
    const rejected = admitEntities(input.entities, input.mentions,
      [{ evidenceRef: 'r', text: 'Queue 和 Cache；它失败了；那个也待确认。' }]);
    expect(rejected.entities).toEqual(result.entities);
    expect(rejected.mentions).toEqual(result.mentions);
    expect(rejected.rejected).toEqual([
      { component: 'entity', index: 3, reasons: ['unresolved_possible_entity'] },
      { component: 'mention', index: 3, reasons: ['unknown_entity'] },
    ]);
    expect(input).toEqual(before);
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


// Structural wire guarantees remain separate from deterministic host admission.
describe('derived strict structural wire with original itemwise admission', () => {
  const wirePacket = wireModelWindow;
  const decode = (value: unknown) => decodeWindowExtractionWire(Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));

  it('renders source-grounded v18 examples while preserving the frozen v14 and no-fewshot control', () => {
    const control = readFileSync(new URL('../../scripts/bench/assets/entity-extraction-four-positive-strict-v1/v14-derived-strict.prompt.txt', import.meta.url));
    const frozenExamples = JSON.parse(readFileSync(new URL('../../scripts/bench/assets/entity-extraction-five-positive-strict-v4/strict-positive-examples.json', import.meta.url), 'utf8')) as { examples: unknown[] };
    expect(STRICT_EXTRACTION_PROMPT_VERSION).toBe('knowledge-extraction-v18');
    expect(STRICT_EXTRACTION_FEWSHOT_EXAMPLES).toEqual(frozenExamples.examples);
    expect(STRICT_EXTRACTION_FEWSHOT_EXAMPLES).toHaveLength(5);
    const versionExample = STRICT_EXTRACTION_FEWSHOT_EXAMPLES.find(example => example.exampleId === 'synthetic-version-artifact-v2')!;
    const source = versionExample.input.excerpts.map(excerpt => excerpt.text).join('\n');
    expect(source).toContain('当前是 v14');
    expect(source).not.toContain('knowledge-extraction-v14');
    expect(versionExample.output.entities.find(entity => entity.entityId === 'e_prompt')).toMatchObject({
      qualifiers: ['当前版本 v14'], referentKind: 'object',
    });
    expect(versionExample.output.entities.find(entity => entity.entityId === 'e_corpus')?.referentKind).toBe('version');
    expect(STRICT_EXTRACTION_FEWSHOT_BLOCK).toBe(renderStrictExtractionFewshotBlock());
    expect(STRICT_EXTRACTION_PROMPT.split(STRICT_EXTRACTION_FEWSHOT_BLOCK)).toHaveLength(2);
    expect(STRICT_EXTRACTION_PROMPT.replace(STRICT_EXTRACTION_FEWSHOT_BLOCK + '\n', '')).toBe(control.toString('utf8'));
    expect(control.length).toBe(31884);
    expect(createHash('sha256').update(control).digest('hex')).toBe('d5c14bb7809a2ccd57b5984bb39ff14ef709fd365db8df7792b697fac420736d');
    expect(STRICT_EXTRACTION_PROMPT.endsWith(WINDOW_EXTRACTION_WIRE_SCHEMA_JSON)).toBe(true);
    expect(EXTRACTION_PROMPT_VERSION).toBe('knowledge-extraction-v14');
    expect(createHash('sha256').update(EXTRACTION_PROMPT).digest('hex')).toBe('e3acd05eca278b0e34f5d8b75767176c5ede7ce7fade561975eb1f4e4c417399');
  });

  it.each(STRICT_EXTRACTION_FEWSHOT_EXAMPLES)('admits the actual production demonstration $exampleId through the wire and domain host', example => {
    const before = structuredClone(example);
    const raw = Buffer.from(JSON.stringify(example.output) + '\n');
    const decoded = decodeWindowExtractionWire(raw);
    expect(decoded.decodeStatus).toBe('decoded');
    if (decoded.decodeStatus !== 'decoded') throw new Error(decoded.error);
    expect(decoded.wireStatus).toBe('valid'); expect(decoded.wireFailures).toEqual([]);
    const admitted = checkWindowExtractionResponse(decoded.domainInput, example.input.excerpts);
    expect(admitted.analysis.rejected).toEqual([]); expect(admitted.rejected).toEqual([]);
    expect(admitted.analysis.entities.map(entity => entity.entityId)).toEqual(example.output.entities.map(entity => entity.entityId));
    expect(admitted.analysis.mentions.map(mention => mention.mentionId)).toEqual(example.output.mentions.map(mention => mention.mentionId));
    expect(admitted.accepted.map(proposal => proposal.proposalId)).toEqual(example.output.proposals.map(proposal => proposal.proposalId));
    for (const proposal of admitted.accepted) expect(KnowledgeDraftSchema.safeParse(proposal.draft).success).toBe(true);
    expect(decoded.raw.text).toBe(raw.toString('utf8'));
    expect(Buffer.from(decoded.raw.bytesBase64, 'base64')).toEqual(raw);
    expect(example).toEqual(before);
  });

  it('keeps the correct normative proposal when a diagnostic-only sibling has a non-source citation', () => {
    const diagnostic = STRICT_EXTRACTION_PARTIAL_ADMISSION_DIAGNOSTIC;
    const example = STRICT_EXTRACTION_FEWSHOT_EXAMPLES[3]; const beforeExample = structuredClone(example);
    expect(example.exampleId).toBe(diagnostic.exampleId);
    const good = example.output.proposals[0];
    const bad = { ...structuredClone(good), proposalId: diagnostic.badProposalId,
      citations: good.citations.map((citation, index) => ({ ...citation, selection: { ...citation.selection,
        quote: index === diagnostic.citationIndex ? diagnostic.badQuote : citation.selection.quote } })) };
    const packet = { ...example.output, proposals: [good, bad] }; const beforePacket = structuredClone(packet);
    const raw = Buffer.from(JSON.stringify(packet) + '\n'); const beforeRaw = Buffer.from(raw);
    const decoded = decodeWindowExtractionWire(raw);
    if (decoded.decodeStatus !== 'decoded') throw new Error(decoded.error);
    expect(decoded.wireStatus).toBe('valid'); expect(decoded.wireFailures).toEqual([]);
    const admitted = checkWindowExtractionResponse(decoded.domainInput, example.input.excerpts);
    expect(admitted.analysis.rejected).toEqual([]);
    expect(admitted.accepted.map(proposal => proposal.proposalId)).toEqual([diagnostic.goodProposalId]);
    expect(admitted.rejected).toEqual([{ index: 1, reasons: ['citation:quote_mismatch'] }]);
    expect(KnowledgeDraftSchema.safeParse(admitted.accepted[0].draft).success).toBe(true);
    expect(decoded.raw.text).toBe(beforeRaw.toString('utf8'));
    expect(Buffer.from(decoded.raw.bytesBase64, 'base64')).toEqual(beforeRaw);
    expect(raw).toEqual(beforeRaw); expect(packet).toEqual(beforePacket); expect(example).toEqual(beforeExample);
  });

  it('maps only explicit optional placeholders while preserving meaningful nulls, arrays, union branches and exact raw bytes', () => {
    const packet = identityWindow();
    packet.mentions[0].selection.occurrence = 0;
    delete packet.proposals[0].draft.content.statements[0].object;
    const wire = wirePacket(packet); const raw = Buffer.from(JSON.stringify(wire, null, 2) + '\n', 'utf8');
    const before = Buffer.from(raw); const result = decodeWindowExtractionWire(raw);
    expect(result.decodeStatus).toBe('decoded');
    if (result.decodeStatus !== 'decoded') throw new Error(result.error);
    expect(result.wireStatus).toBe('valid'); expect(result.wireFailures).toEqual([]);
    expect(result.domainInput).toEqual(JSON.parse(JSON.stringify(packet)));
    expect(WindowExtractionModelSchema.safeParse(result.domainInput).success).toBe(true);
    expect(result.raw.text).toBe(raw.toString('utf8')); expect(Buffer.from(result.raw.bytesBase64, 'base64')).toEqual(before);
    expect(raw).toEqual(before);
    expect((result.domainInput as typeof packet).entities[0].componentRef).toBeNull();
    expect((result.domainInput as typeof packet).entities[0].collection).toBeNull();
    expect((result.domainInput as typeof packet).mentions[0].selection.occurrence).toBe(0);
    expect(Object.hasOwn((result.domainInput as typeof packet).mentions[1].selection, 'occurrence')).toBe(false);
    expect(WINDOW_EXTRACTION_WIRE_ID).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.parse(WINDOW_EXTRACTION_WIRE_SCHEMA_JSON)).toEqual(WINDOW_EXTRACTION_WIRE_SCHEMA);
    expect(Object.isFrozen(WINDOW_EXTRACTION_WIRE_SCHEMA)).toBe(true);
    expect(WINDOW_EXTRACTION_WIRE_IDENTITY).toMatchObject({ domainSchemaVersion: 4, profile: 'omk-strict-structural/v1' });
    expect(WINDOW_EXTRACTION_WIRE_HOST_ONLY.nullableOptionals.map(value => value.property).sort()).toEqual(['object', 'occurrence']);
    expect(WINDOW_EXTRACTION_WIRE_HOST_ONLY.disjointUnionConversions.map(value => value.discriminator).sort()).toEqual(['boundKind', 'knowledgeKind', 'timeKind']);
  });

  it('retains malformed and unknown sibling fields as wire failures and still admits valid knowledge', () => {
    const wire = wirePacket();
    const badEntity = { ...wire.entities[0], entityId: 'bad-entity', unexpected: true };
    const badMention = { ...wire.mentions[0], mentionId: 'bad-mention', unexpected: true };
    const badProposal = { ...wire.proposals[0], proposalId: 'bad-proposal', unexpected: true };
    wire.entities.push(badEntity); wire.mentions.push(badMention); wire.proposals.push(badProposal);
    const raw = JSON.stringify(wire, null, 2) + '\n'; const result = decodeWindowExtractionWire(Buffer.from(raw));
    expect(result.decodeStatus).toBe('decoded');
    if (result.decodeStatus !== 'decoded') throw new Error(result.error);
    expect(result.wireStatus).toBe('item_failures');
    expect(result.wireFailures.map(value => [value.field, value.index])).toEqual([['entities', 2], ['mentions', 2], ['proposals', 1]]);
    expect(JSON.stringify(result.domainInput).match(/"unexpected":true/g)).toHaveLength(3);
    expect(result.raw.text).toBe(raw);
    const admitted = checkWindowExtractionResponse(result.domainInput, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta' }]);
    expect(admitted.analysis.entities).toHaveLength(2); expect(admitted.analysis.mentions).toHaveLength(2);
    expect(admitted.analysis.rejected).toEqual(expect.arrayContaining([
      { component: 'entity', index: 2, reasons: ['invalid_structure'] }, { component: 'mention', index: 2, reasons: ['invalid_structure'] },
    ]));
    expect(admitted.rejected).toEqual([{ index: 1, reasons: expect.arrayContaining(['invalid_structure:']) }]);
    expect(admitted.accepted.map(proposal => proposal.proposalId)).toEqual(['candidate-1']);
  });

  it('leaves unsupported scalar/refinement/grounding checks with the unchanged host and never repairs quote text', () => {
    const packet = modelWindow();
    const bad = structuredClone(packet.proposals[0]); bad.proposalId = 'bad-time';
    bad.draft.content.statements[0].context.occurredDuring = { timeKind: 'interval',
      start: { boundKind: 'known', at: '2026-01-01T00:00:00Z' }, end: { boundKind: 'known', at: '2026-01-01T00:00:00Z' } };
    packet.proposals.push(bad);
    const wire = wirePacket(packet); const result = decode(wire);
    expect(result.decodeStatus).toBe('decoded');
    if (result.decodeStatus !== 'decoded') throw new Error(result.error);
    expect(result.wireStatus).toBe('valid'); // Structural provider guarantee does not encode interval ordering.
    const admitted = checkWindowExtractionResponse(result.domainInput, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta' }]);
    expect(admitted.accepted.map(proposal => proposal.proposalId)).toEqual(['candidate-1']);
    expect(admitted.rejected).toEqual([{ index: 1, reasons: expect.arrayContaining(['invalid_structure:draft.content.statements.0.context.occurredDuring']) }]);
    wire.mentions[0].selection.quote = 'ALPHA';
    const nonexact = decode(wire);
    if (nonexact.decodeStatus !== 'decoded') throw new Error(nonexact.error);
    expect((nonexact.domainInput as typeof packet).mentions[0].selection.quote).toBe('ALPHA');
    expect(checkWindowExtractionResponse(nonexact.domainInput, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta' }]).analysis.rejected)
      .toContainEqual({ component: 'mention', index: 0, reasons: ['quote_mismatch'] });
    wire.mentions[0].selection.quote = 'Alpha'; wire.mentions[0].selection.occurrence = null;
    const repeated = decode(wire);
    if (repeated.decodeStatus !== 'decoded') throw new Error(repeated.error);
    expect(checkWindowExtractionResponse(repeated.domainInput, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta，Alpha 待复核' }]).analysis.rejected)
      .toContainEqual({ component: 'mention', index: 0, reasons: ['ambiguous_quote'] });
  });

  it('distinguishes bad envelopes and invalid byte/JSON evidence from item failures without swallowing semantic null', () => {
    const wire = wirePacket();
    for (const value of [{ ...wire, unexpected: true }, { ...wire, entities: null }, { ...wire, schemaVersion: 3 }]) {
      expect(decode(value)).toMatchObject({ decodeStatus: 'envelope_failure', failureKind: 'invalid_envelope' });
    }
    const requiredNull = wirePacket(); requiredNull.entities[0].label = null as unknown as string;
    const result = decode(requiredNull);
    if (result.decodeStatus !== 'decoded') throw new Error(result.error);
    expect(result.wireStatus).toBe('item_failures');
    expect((result.domainInput as typeof requiredNull).entities[0].label).toBeNull();
    expect(checkWindowExtractionResponse(result.domainInput, [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta' }]).analysis.rejected)
      .toContainEqual({ component: 'entity', index: 0, reasons: ['invalid_structure'] });
    const invalidBytes = new Uint8Array([0xff, 0x00]);
    const invalid = decodeWindowExtractionWire(invalidBytes);
    expect(invalid).toMatchObject({ decodeStatus: 'envelope_failure', failureKind: 'invalid_utf8', raw: { text: null, byteLength: 2 } });
    expect(Buffer.from(invalid.raw.bytesBase64, 'base64')).toEqual(Buffer.from(invalidBytes));
    expect(decodeWindowExtractionWire(Buffer.from('{ broken'))).toMatchObject({ decodeStatus: 'envelope_failure', failureKind: 'invalid_json', raw: { text: '{ broken' } });
  });
});
