import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { buildEntityDiscoveryInput, checkEntityDiscoveryResponse, ENTITY_DISCOVERY_INPUT_VERSION,
  ENTITY_DISCOVERY_OUTPUT_MAX_BYTES, ENTITY_DISCOVERY_WIRE_ID, ENTITY_DISCOVERY_WIRE_SCHEMA,
  ENTITY_DISCOVERY_WIRE_SCHEMA_JSON, type EntityDiscoveryResponse, type EntityDiscoverySource } from '../../src/knowledge/extraction/entity-discovery.js';
import { authoredDiscoverySourcePlan } from './discovered-entities-fixtures.js';
import { ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const source: EntityDiscoverySource = { snapshotId: '00000000-0000-4000-8000-000000000001',
    sourceVersion: hash('authored contract source'), limitations: ['  来源说法尚未核实。\n'],
    excerpts: [{ evidenceRef: 'r1', recordIndex: 0, eventKind: 'message', role: 'user',
      text: '😀 Alpha 组件；Alpha v1 实例；该组成员未知。Alpha 再次出现；不明实例所指未定。' }] };
  const entity = (entityId: string, label: string): EntityDiscoveryResponse['entities'][number] => ({ entityId, label,
    description: `${label} 是来源所讨论的对象。`, qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
    referentKind: 'object', componentRef: null, collection: null });
  const { planPredecessor } = authoredDiscoverySourcePlan(source, undefined, [
    { objectId: 'pc', quote: 'Alpha', occurrence: 0 }, { objectId: 'pi', quote: 'Alpha v1', occurrence: null },
    { objectId: 'pg', quote: '该组成员未知', occurrence: null }, { objectId: 'pu', quote: '不明实例', occurrence: null },
  ]);
  const response: EntityDiscoveryResponse = { responseKind: 'entity-discovery', schemaVersion: 2,
    binding: JSON.parse(buildEntityDiscoveryInput(source, planPredecessor)).binding,
    dispositions: ['c', 'i', 'g', 'u'].map((entityId, index) => ({ sourcePlanObjectId: `p${entityId}`, dispositionKind: 'retained',
      entityIds: [entityId], rationale: 'Authored mapping judgment, not semantic certification.',
      selections: [{ evidenceRef: 'r1', quote: ['Alpha', 'Alpha v1', '该组成员未知', '不明实例'][index], occurrence: index === 0 ? 0 : null }] })),
    entities: [entity('c', 'Alpha'), entity('i', 'Alpha v1'), entity('g', '该组'), entity('u', '不明实例')],
    anchors: [
      { anchorId: 'ac', entityId: 'c', selection: { evidenceRef: 'r1', quote: 'Alpha', occurrence: 0 } },
      { anchorId: 'ai', entityId: 'i', selection: { evidenceRef: 'r1', quote: 'Alpha v1', occurrence: null } },
      { anchorId: 'ag', entityId: 'g', selection: { evidenceRef: 'r1', quote: '该组成员未知', occurrence: null } },
      { anchorId: 'au', entityId: 'u', selection: { evidenceRef: 'r1', quote: '不明实例', occurrence: null } },
    ] };
  response.entities[0].referentKind = 'component';
  response.entities[1].referentKind = 'instance';
  response.entities[1].componentRef = { entityId: 'c', anchorIds: ['ai'], rationale: '来源声明实例所属组件。' };
  response.entities[2].referentKind = 'collection'; response.entities[2].uncertainties = ['组的成员身份未知。'];
  response.entities[2].collection = { memberEntityIds: [], completeness: 'unknown', anchorIds: ['ag'], rationale: '来源共同指代该组。' };
  response.entities[3].referentKind = 'instance'; response.entities[3].identityStatus = 'unresolved';
  response.entities[3].possibleEntityIds = ['i']; response.entities[3].uncertainties = ['所指尚未确定。'];
  return { source, response, planPredecessor };
}
function reject(f: ReturnType<typeof fixture>, code: string) {
  const result = checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source, f.planPredecessor);
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.issues.some(issue => issue.includes(code))).toBe(true);
}

describe('private entity discovery A', () => {
  it('preserves complete source and raw bytes without generating mentions or semantic acceptance', () => {
    const f = fixture(), before = structuredClone(f);
    const projected = JSON.parse(buildEntityDiscoveryInput({ ...f.source, sourcePath: '/private/raw', gold: 'answer' } as EntityDiscoverySource, f.planPredecessor));
    expect(projected).toEqual({ taskKind: 'entity_discovery', taskVersion: ENTITY_DISCOVERY_INPUT_VERSION,
      binding: f.response.binding, ...f.source, sourcePlanResponse: f.planPredecessor });
    const raw = ` \n${JSON.stringify(f.response)}\r\n`, bytes = Buffer.from(raw);
    const result = checkEntityDiscoveryResponse(bytes, f.source, f.planPredecessor); bytes.fill(0);
    expect(result).toEqual({ status: 'checked', response: f.response, dispositionIssues: [], semanticStatus: 'not_reviewed',
      raw: { encoding: 'raw-utf8', bytesBase64: Buffer.from(raw).toString('base64'), byteLength: Buffer.byteLength(raw), digest: hash(raw), text: raw } });
    expect(result).not.toHaveProperty('mentions'); expect(result).not.toHaveProperty('admission');
    expect(f).toEqual(before);
    // A known group's unknown members remain distinct from an unresolved object's identity.
    if (result.status === 'checked') {
      expect(result.response.entities[2]).toMatchObject({ identityStatus: 'proposed', collection: { completeness: 'unknown', memberEntityIds: [] } });
      expect(result.response.entities[3]).toMatchObject({ identityStatus: 'unresolved', possibleEntityIds: ['i'] });
    }
  });

  it.each([
    ['legacy response version', (f: ReturnType<typeof fixture>) => { Object.assign(f.response, { schemaVersion: 1 }); }, 'invalid_structure'],
    ['binding', (f: ReturnType<typeof fixture>) => { f.response.binding.sourceProjectionDigest = hash('other'); }, 'binding_mismatch'],
    ['missing disposition', (f: ReturnType<typeof fixture>) => { f.response.dispositions.pop(); }, 'missing_object'],
    ['duplicate disposition', (f: ReturnType<typeof fixture>) => { f.response.dispositions.push(structuredClone(f.response.dispositions[0])); }, 'duplicate_object'],
    ['unknown planning object', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].sourcePlanObjectId = 'missing'; }, 'unknown_object'],
    ['unknown disposition entity', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].entityIds = ['missing']; }, 'unknown_entity'],
    ['duplicate disposition entity', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].dispositionKind = 'corrected'; f.response.dispositions[0].entityIds = ['c', 'c']; }, 'duplicate_entity'],
    ['empty retained mapping', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].entityIds = []; }, 'invalid_targets'],
    ['multiple retained targets', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].entityIds = ['c', 'i']; }, 'invalid_targets'],
    ['empty corrected mapping', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].dispositionKind = 'corrected'; f.response.dispositions[0].entityIds = []; }, 'invalid_targets'],
    ['excluded with target', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].dispositionKind = 'excluded'; }, 'invalid_targets'],
    ['undetermined with target', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].dispositionKind = 'undetermined'; }, 'invalid_targets'],
    ['shared target with retained row', (f: ReturnType<typeof fixture>) => { f.response.dispositions[1].dispositionKind = 'corrected'; f.response.dispositions[1].entityIds = ['c']; }, 'merge_requires_correction'],
    ['missing disposition rationale', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].rationale = ' '; }, 'invalid_structure'],
    ['missing disposition evidence', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].selections = []; }, 'invalid_structure'],
    ['duplicate disposition evidence', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].selections.push(structuredClone(f.response.dispositions[0].selections[0])); }, 'duplicate_selection'],
    ['unknown disposition evidence', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].selections[0].evidenceRef = 'missing'; }, 'unknown_evidence'],
    ['ambiguous disposition occurrence', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].selections[0].occurrence = null; }, 'ambiguous_quote'],
    ['wrong disposition quote', (f: ReturnType<typeof fixture>) => { f.response.dispositions[0].selections[0].quote = 'source absent'; }, 'quote_mismatch'],
    ['duplicate entity', (f: ReturnType<typeof fixture>) => { f.response.entities.push(structuredClone(f.response.entities[0])); }, 'duplicate_entity'],
    ['duplicate anchor', (f: ReturnType<typeof fixture>) => { f.response.anchors.push(structuredClone(f.response.anchors[0])); }, 'duplicate_anchor'],
    ['duplicate position', (f: ReturnType<typeof fixture>) => { f.response.anchors.push({ ...f.response.anchors[0], anchorId: 'other' }); }, 'duplicate_anchor_position'],
    ['unknown owner', (f: ReturnType<typeof fixture>) => { f.response.anchors[0].entityId = 'missing'; }, 'unknown_entity'],
    ['missing owned anchor', (f: ReturnType<typeof fixture>) => { f.response.anchors = f.response.anchors.filter(a => a.entityId !== 'u'); }, 'entity_without_anchor'],
    ['missing identity anchor', (f: ReturnType<typeof fixture>) => { f.response.entities[1].componentRef!.anchorIds = ['missing']; }, 'unknown_mention'],
    ['foreign identity anchor', (f: ReturnType<typeof fixture>) => { f.response.entities[1].componentRef!.anchorIds = ['ac']; }, 'missing_entity_mention'],
    ['wrong component level', (f: ReturnType<typeof fixture>) => { f.response.entities[1].componentRef!.entityId = 'g'; }, 'invalid_component_target'],
    ['unknown member', (f: ReturnType<typeof fixture>) => { f.response.entities[2].collection!.completeness = 'complete'; f.response.entities[2].collection!.memberEntityIds = ['missing']; }, 'unknown_collection_member'],
    ['collection cycle', (f: ReturnType<typeof fixture>) => { f.response.entities[2].collection!.completeness = 'complete'; f.response.entities[2].collection!.memberEntityIds = ['g']; }, 'collection_cycle'],
    ['unknown membership fabricated', (f: ReturnType<typeof fixture>) => { f.response.entities[2].collection!.memberEntityIds = ['c']; }, 'unknown_collection_has_members'],
    ['partial membership empty', (f: ReturnType<typeof fixture>) => { f.response.entities[2].collection!.completeness = 'partial'; }, 'partial_collection_without_members'],
    ['identity uncertainty missing', (f: ReturnType<typeof fixture>) => { f.response.entities[3].uncertainties = []; }, 'invalid_identity'],
    ['identity candidate duplicate', (f: ReturnType<typeof fixture>) => { f.response.entities[3].possibleEntityIds = ['i', 'i']; }, 'duplicate_possible_entity'],
    ['identity candidate unknown', (f: ReturnType<typeof fixture>) => { f.response.entities[3].possibleEntityIds = ['missing']; }, 'unknown_possible_entity'],
    ['identity candidate wrong level', (f: ReturnType<typeof fixture>) => { f.response.entities[3].possibleEntityIds = ['c']; }, 'possible_entity_level_mismatch'],
    ['metadata normalization', (f: ReturnType<typeof fixture>) => { f.response.entities[0].label = ' Alpha '; }, 'normalization_required'],
    ['ambiguous source locator', (f: ReturnType<typeof fixture>) => { f.response.anchors[0].selection.occurrence = null; }, 'ambiguous_quote'],
    ['locator outside source', (f: ReturnType<typeof fixture>) => { f.response.anchors[0].selection.occurrence = 10; }, 'quote_occurrence_out_of_range'],
    ['identifier fragment', (f: ReturnType<typeof fixture>) => { f.response.anchors[0].selection.quote = 'lpha'; f.response.anchors[0].selection.occurrence = 0; }, 'mention_identifier_fragment'],
  ])('rejects %s all-or-nothing', (_name, mutate, code) => { const f = fixture(); mutate(f); reject(f, code); });

  it('permits shared contextual anchor spans across different owners, not duplicate owned anchors', () => {
    const f = fixture(); f.response.anchors[3].selection = { ...f.response.anchors[1].selection };
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source, f.planPredecessor).status).toBe('checked');
  });

  it('rejects extra M/P fields and accepts an empty A catalog only after every planning object is explicitly excluded', () => {
    const f = fixture();
    expect(checkEntityDiscoveryResponse(JSON.stringify({ ...f.response, mentions: [] }), f.source, f.planPredecessor).status).toBe('rejected');
    f.response.entities = []; f.response.anchors = [];
    f.response.dispositions.forEach(disposition => { disposition.dispositionKind = 'excluded'; disposition.entityIds = []; });
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source, f.planPredecessor).status).toBe('checked');
  });

  it('keeps unresolved dispositions checked but blocked, without manufacturing an unresolved entity', () => {
    const f = fixture(), before = structuredClone(f.response.entities);
    Object.assign(f.response.dispositions[0], { dispositionKind: 'undetermined', entityIds: [], rationale: '来源尚不足以决定这项清单主张的去向。' });
    const raw = ` \n${JSON.stringify(f.response)}\r\n`;
    expect(checkEntityDiscoveryResponse(raw, f.source, f.planPredecessor)).toMatchObject({ status: 'checked',
      dispositionIssues: ['disposition:pc:undetermined'], raw: { text: raw, digest: hash(raw) }, semanticStatus: 'not_reviewed' });
    expect(f.response.entities).toEqual(before);
  });

  it('allows source-grounded discovery outside the plan and explicitly corrected splits and merges without certifying their semantics', () => {
    const added = fixture();
    added.response.entities.push({ ...added.response.entities[0], entityId: 'source-only', label: 'Alpha again' });
    added.response.anchors.push({ anchorId: 'source-only-anchor', entityId: 'source-only', selection: { evidenceRef: 'r1', quote: 'Alpha', occurrence: 2 } });
    expect(checkEntityDiscoveryResponse(JSON.stringify(added.response), added.source, added.planPredecessor))
      .toMatchObject({ status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed' });
    const emptyPlan = authoredDiscoverySourcePlan(added.source, undefined, []);
    added.response.binding = JSON.parse(buildEntityDiscoveryInput(added.source, emptyPlan.planPredecessor)).binding;
    added.response.dispositions = [];
    expect(checkEntityDiscoveryResponse(JSON.stringify(added.response), added.source, emptyPlan.planPredecessor))
      .toMatchObject({ status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed' });
    const split = fixture();
    Object.assign(split.response.dispositions[0], { dispositionKind: 'corrected', entityIds: ['c', 'i'], rationale: 'Authored split assertion; semantic correctness remains unreviewed.' });
    Object.assign(split.response.dispositions[1], { dispositionKind: 'excluded', entityIds: [] });
    expect(checkEntityDiscoveryResponse(JSON.stringify(split.response), split.source, split.planPredecessor).status).toBe('checked');
    const merged = fixture();
    merged.response.dispositions.slice(0, 2).forEach(disposition => { disposition.dispositionKind = 'corrected'; disposition.entityIds = ['c']; });
    expect(checkEntityDiscoveryResponse(JSON.stringify(merged.response), merged.source, merged.planPredecessor))
      .toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
  });

  it('retains invalid byte evidence and rejects invalid UTF-8, JSON and capacity without repair', () => {
    const f = fixture(), invalid = Buffer.from([0xff, 0xfe]);
    expect(checkEntityDiscoveryResponse(invalid, f.source, f.planPredecessor)).toMatchObject({ status: 'rejected', issues: ['invalid_utf8'],
      raw: { text: null, bytesBase64: invalid.toString('base64'), digest: hash(invalid) } });
    expect(checkEntityDiscoveryResponse('{', f.source, f.planPredecessor)).toMatchObject({ status: 'rejected', issues: ['invalid_json'] });
    expect(checkEntityDiscoveryResponse(' '.repeat(ENTITY_DISCOVERY_OUTPUT_MAX_BYTES + 1), f.source, f.planPredecessor)).toMatchObject({ status: 'rejected', issues: ['output_capacity'] });
    f.response.entities[0].description = '\ud800';
    reject(f, 'invalid_utf8');
    expect(() => checkEntityDiscoveryResponse('\ud800', f.source, f.planPredecessor)).toThrow('not valid UTF-8');
  });

  it('validates the source projection and model input capacity before use', () => {
    const f = fixture(); f.source.excerpts.push({ ...f.source.excerpts[0] });
    expect(() => buildEntityDiscoveryInput(f.source, f.planPredecessor)).toThrow('Ambiguous');
    f.source.excerpts.pop(); f.source.excerpts[0].text = '\ud800';
    expect(() => buildEntityDiscoveryInput(f.source, f.planPredecessor)).toThrow('UTF-8');
    f.source.excerpts[0].text = '界'.repeat(400_000);
    expect(() => buildEntityDiscoveryInput(f.source, f.planPredecessor)).toThrow(ExtractionInputCapacityError);
  });

  it('publishes a frozen strict wire schema with every field required', () => {
    const f = fixture(), validate = new Ajv2020({ strict: true }).compile(ENTITY_DISCOVERY_WIRE_SCHEMA);
    expect(validate(f.response)).toBe(true);
    expect(validate({ ...f.response, proposals: [] })).toBe(false);
    expect(ENTITY_DISCOVERY_WIRE_SCHEMA_JSON).toBe(JSON.stringify(ENTITY_DISCOVERY_WIRE_SCHEMA));
    expect(ENTITY_DISCOVERY_WIRE_ID).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(ENTITY_DISCOVERY_WIRE_SCHEMA)).toBe(true);
  });
});
