import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { buildEntityDiscoveryInput, checkEntityCatalogBody, checkEntityDiscoveryResponse, ENTITY_DISCOVERY_INPUT_VERSION,
  ENTITY_DISCOVERY_SYSTEM_VERSION, ENTITY_DISCOVERY_WIRE_VERSION, ENTITY_DISCOVERY_CHECK_VERSION, ENTITY_DISCOVERY_OUTPUT_NAME,
  ENTITY_DISCOVERY_OUTPUT_MAX_BYTES, ENTITY_DISCOVERY_WIRE_ID, ENTITY_DISCOVERY_WIRE_SCHEMA,
  ENTITY_DISCOVERY_WIRE_SCHEMA_JSON, type EntityDiscoveryResponse, type EntityDiscoverySource } from '../../src/knowledge/extraction/entity-discovery.js';
import { ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import { authoredQualification } from './discovered-entities-fixtures.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const source: EntityDiscoverySource = { snapshotId: '00000000-0000-4000-8000-000000000001',
    sourceVersion: hash('authored contract source'), limitations: ['  来源说法尚未核实。\n'],
    excerpts: [{ evidenceRef: 'r1', recordIndex: 0, eventKind: 'message', role: 'user',
      text: '😀 Alpha 组件；Alpha v1 实例；该组成员未知。Alpha 再次出现；不明实例所指未定。' }] };
  const entity = (entityId: string, label: string): EntityDiscoveryResponse['entities'][number] => ({ entityId, label,
    description: `${label} 是来源所讨论的对象。`, qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
    referentKind: 'object', componentRef: null, collection: null, qualificationEvidence: authoredQualification(`a${entityId}`) });
  const response: EntityDiscoveryResponse = { responseKind: 'entity-discovery', schemaVersion: 4,
    binding: JSON.parse(buildEntityDiscoveryInput(source)).binding,
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
  response.entities[2].qualificationEvidence = authoredQualification('ag', { basisKind: 'collective_scope', memberRole: 'work_targets' });
  response.entities[2].collection = { memberEntityIds: [], completeness: 'unknown', anchorIds: ['ag'], rationale: '来源共同指代该组。' };
  response.entities[3].referentKind = 'instance'; response.entities[3].identityStatus = 'unresolved';
  response.entities[3].possibleEntityIds = ['i']; response.entities[3].uncertainties = ['所指尚未确定。'];
  return { source, response };
}
function reject(f: ReturnType<typeof fixture>, code: string) {
  const result = checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source);
  expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.issues.some(issue => issue.includes(code))).toBe(true);
}

describe('private entity discovery A', () => {
  it('preserves complete source and raw bytes without generating mentions or semantic acceptance', () => {
    const f = fixture(), before = structuredClone(f);
    const projected = JSON.parse(buildEntityDiscoveryInput({ ...f.source, sourcePath: '/private/raw', gold: 'answer' } as EntityDiscoverySource));
    expect(projected).toEqual({ taskKind: 'entity_discovery', taskVersion: ENTITY_DISCOVERY_INPUT_VERSION,
      binding: f.response.binding, ...f.source });
    const raw = ` \n${JSON.stringify(f.response)}\r\n`, bytes = Buffer.from(raw);
    const result = checkEntityDiscoveryResponse(bytes, f.source); bytes.fill(0);
    expect(result).toEqual({ status: 'checked', response: f.response, semanticStatus: 'not_reviewed',
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
    ['legacy response version', (f: ReturnType<typeof fixture>) => { Object.assign(f.response, { schemaVersion: 3 }); }, 'invalid_structure'],
    ['missing qualification', (f: ReturnType<typeof fixture>) => { Reflect.deleteProperty(f.response.entities[0], 'qualificationEvidence'); }, 'invalid_structure:entities.0.qualificationEvidence'],
    ['unknown qualification basis', (f: ReturnType<typeof fixture>) => { Object.assign(f.response.entities[0].qualificationEvidence, { basisKind: 'guess' }); }, 'invalid_structure'],
    ['missing nullable role', (f: ReturnType<typeof fixture>) => { Reflect.deleteProperty(f.response.entities[0].qualificationEvidence, 'activityStatus'); }, 'invalid_structure'],
    ['empty qualification reason', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.rationale = ' '; }, 'invalid_structure'],
    ['empty qualification evidence', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.anchorIds = []; }, 'invalid_structure'],
    ['too many qualification anchors', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.anchorIds = Array(5).fill('ac'); }, 'invalid_structure'],
    ['duplicate qualification anchor', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.anchorIds = ['ac', 'ac']; }, 'qualification:duplicate_anchor'],
    ['unknown qualification anchor', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.anchorIds = ['missing']; }, 'qualification:unknown_anchor'],
    ['foreign qualification anchor', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.anchorIds = ['ai']; }, 'qualification:foreign_anchor'],
    ['operation without role', (f: ReturnType<typeof fixture>) => { f.response.entities[0].referentKind = 'object'; f.response.entities[0].qualificationEvidence.basisKind = 'operation_rule'; }, 'qualification:incompatible_roles'],
    ['independent with operation role', (f: ReturnType<typeof fixture>) => { f.response.entities[0].qualificationEvidence.operationRole = 'action_prerequisite'; }, 'qualification:incompatible_roles'],
    ['operation at component level', (f: ReturnType<typeof fixture>) => { Object.assign(f.response.entities[0].qualificationEvidence, { basisKind: 'operation_rule', operationRole: 'definition_or_behavior' }); }, 'qualification:incompatible_referent_kind'],
    ['collection with independent basis', (f: ReturnType<typeof fixture>) => { f.response.entities[2].qualificationEvidence.basisKind = 'independent_referent'; }, 'qualification:incompatible_referent_kind'],
    ['execution members at component level', (f: ReturnType<typeof fixture>) => {
      f.response.entities[2].collection!.completeness = 'complete'; f.response.entities[2].collection!.memberEntityIds = ['c'];
      f.response.entities[2].qualificationEvidence.memberRole = 'execution_occurrences';
    }, 'qualification:incompatible_member_level'],
    ['unknown member role without uncertainty', (f: ReturnType<typeof fixture>) => { f.response.entities[2].qualificationEvidence.memberRole = 'undetermined'; f.response.entities[2].uncertainties = []; }, 'qualification:missing_uncertainty'],
    ['binding', (f: ReturnType<typeof fixture>) => { f.response.binding.sourceProjectionDigest = hash('other'); }, 'binding_mismatch'],
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

  it('records bounded operation/activity claims without interpreting their source meaning or inventing plan correspondence', () => {
    const f = fixture(), value = f.response.entities[0];
    f.response.entities = [value]; f.response.anchors = [f.response.anchors[0]];
    value.referentKind = 'object';
    for (const operationRole of ['definition_or_behavior', 'action_prerequisite'] as const) {
      value.qualificationEvidence = authoredQualification('ac', { basisKind: 'operation_rule', operationRole });
      expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
    }
    value.referentKind = 'activity';
    for (const activityStatus of ['planned', 'source_reported_actual', 'undetermined'] as const) {
      value.uncertainties = activityStatus === 'undetermined' ? ['来源没有确定实际或计划状态。'] : [];
      value.qualificationEvidence = authoredQualification('ac', { basisKind: 'bounded_activity', activityStatus });
      expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
    }
    value.uncertainties = []; reject(f, 'qualification:missing_uncertainty');
    value.referentKind = 'plan'; value.qualificationEvidence = authoredQualification('ac');
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
    expect(value).not.toHaveProperty('planRef');
    Object.assign(value.qualificationEvidence, { basisKind: 'bounded_activity', activityStatus: 'source_reported_actual' });
    reject(f, 'qualification:incompatible_referent_kind');
  });

  it('checks declared member levels while keeping targets, operation concepts and execution occurrences distinct', () => {
    const f = fixture(), member = f.response.entities[0], group = f.response.entities[2];
    f.response.entities = [member, group]; f.response.anchors = f.response.anchors.filter(a => ['c', 'g'].includes(a.entityId));
    group.collection!.completeness = 'complete'; group.collection!.memberEntityIds = ['c'];
    member.referentKind = 'object'; member.qualificationEvidence = authoredQualification('ac', { basisKind: 'operation_rule', operationRole: 'definition_or_behavior' });
    group.qualificationEvidence.memberRole = 'operation_concepts';
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
    group.qualificationEvidence.memberRole = 'execution_occurrences'; reject(f, 'qualification:incompatible_member_level');
    member.referentKind = 'activity'; member.qualificationEvidence = authoredQualification('ac', { basisKind: 'bounded_activity', activityStatus: 'planned' });
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
    group.qualificationEvidence.memberRole = 'operation_concepts'; reject(f, 'qualification:incompatible_member_level');
    for (const memberRole of ['work_targets', 'mixed', 'undetermined'] as const) {
      group.qualificationEvidence.memberRole = memberRole;
      expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
    }
  });

  it('permits shared contextual anchor spans across different owners, not duplicate owned anchors', () => {
    const f = fixture(); f.response.anchors[3].selection = { ...f.response.anchors[1].selection };
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
  });

  it('rejects removed predecessor fields and permits an empty source-only catalog', () => {
    const f = fixture();
    for (const extra of [{ mentions: [] }, { proposals: [] }, { dispositions: [] }]) {
      expect(checkEntityDiscoveryResponse(JSON.stringify({ ...f.response, ...extra }), f.source).status).toBe('rejected');
    }
    const oldBinding = { ...f.response, binding: { ...f.response.binding,
      sourcePlanReceiptId: '00000000-0000-4000-8000-000000000002', sourcePlanRawDigest: hash('old plan') } };
    expect(checkEntityDiscoveryResponse(JSON.stringify(oldBinding), f.source).status).toBe('rejected');
    f.response.entities = []; f.response.anchors = [];
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
  });

  it('cannot consume another task through builder arguments or source metadata', () => {
    const f = fixture(), expected = buildEntityDiscoveryInput(f.source);
    const otherTask = new Proxy({}, { get() { throw new Error('Another task was read.'); }, ownKeys() { throw new Error('Another task was enumerated.'); } });
    expect(Reflect.apply(buildEntityDiscoveryInput, undefined, [f.source, otherTask])).toBe(expected);
    expect(buildEntityDiscoveryInput({ ...f.source, sourcePlanResponse: otherTask, sourcePlanReceiptId: 'not-a-source-field' } as EntityDiscoverySource)).toBe(expected);
    const payload = JSON.parse(expected);
    expect(Object.keys(payload).sort()).toEqual(['binding', 'excerpts', 'limitations', 'snapshotId', 'sourceVersion', 'taskKind', 'taskVersion']);
    expect(Object.keys(payload.binding).sort()).toEqual(['snapshotId', 'sourceProjectionDigest', 'sourceVersion']);
  });

  it.each(['content', 'limitations', 'version'] as const)('binds a change in source %s without silently reusing the prior response', mode => {
    const f = fixture(), before = JSON.parse(buildEntityDiscoveryInput(f.source));
    if (mode === 'content') f.source.excerpts[0].text += ' 新来源。';
    if (mode === 'limitations') f.source.limitations.push('本次范围进一步受限。');
    if (mode === 'version') f.source.sourceVersion = hash('different source version');
    const changed = JSON.parse(buildEntityDiscoveryInput(f.source));
    expect(changed.binding.sourceProjectionDigest).not.toBe(before.binding.sourceProjectionDigest);
    expect(changed.excerpts).toEqual(f.source.excerpts); expect(changed.limitations).toEqual(f.source.limitations);
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source)).toMatchObject({ status: 'rejected', issues: ['binding_mismatch'] });
  });

  it('reuses complete catalog checks without a predecessor ledger or semantic certification', () => {
    const f = fixture();
    f.response.entities.push({ ...f.response.entities[0], entityId: 'new-object', label: 'Alpha again', qualificationEvidence: authoredQualification('new-anchor') });
    f.response.anchors.push({ anchorId: 'new-anchor', entityId: 'new-object', selection: { evidenceRef: 'r1', quote: 'Alpha', occurrence: 2 } });
    const body = { entities: f.response.entities, anchors: f.response.anchors };
    expect(checkEntityCatalogBody(f.source, body)).toEqual({ issues: [] });
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
    body.entities[1].componentRef!.anchorIds = ['ac'];
    expect(checkEntityCatalogBody(f.source, body).issues).toContain('entity:i:component:missing_entity_mention');
  });

  it('retains invalid byte evidence and rejects invalid UTF-8, JSON and capacity without repair', () => {
    const f = fixture(), invalid = Buffer.from([0xff, 0xfe]);
    expect(checkEntityDiscoveryResponse(invalid, f.source)).toMatchObject({ status: 'rejected', issues: ['invalid_utf8'],
      raw: { text: null, bytesBase64: invalid.toString('base64'), digest: hash(invalid) } });
    expect(checkEntityDiscoveryResponse('{', f.source)).toMatchObject({ status: 'rejected', issues: ['invalid_json'] });
    expect(checkEntityDiscoveryResponse(' '.repeat(ENTITY_DISCOVERY_OUTPUT_MAX_BYTES + 1), f.source)).toMatchObject({ status: 'rejected', issues: ['output_capacity'] });
    f.response.entities[0].description = '\ud800';
    reject(f, 'invalid_utf8');
    expect(() => checkEntityDiscoveryResponse('\ud800', f.source)).toThrow('not valid UTF-8');
  });

  it('validates the source projection and model input capacity before use', () => {
    const f = fixture(); f.source.excerpts.push({ ...f.source.excerpts[0] });
    expect(() => buildEntityDiscoveryInput(f.source)).toThrow('Ambiguous');
    f.source.excerpts.pop(); f.source.excerpts[0].text = '\ud800';
    expect(() => buildEntityDiscoveryInput(f.source)).toThrow('UTF-8');
    f.source.excerpts[0].text = '界'.repeat(400_000);
    expect(() => buildEntityDiscoveryInput(f.source)).toThrow(ExtractionInputCapacityError);
  });

  it('publishes a frozen strict wire schema with every field required', () => {
    const f = fixture(), validate = new Ajv2020({ strict: true }).compile(ENTITY_DISCOVERY_WIRE_SCHEMA);
    expect(validate(f.response)).toBe(true);
    expect(validate({ ...f.response, proposals: [] })).toBe(false);
    expect(ENTITY_DISCOVERY_SYSTEM_VERSION).toBe('knowledge-entity-discovery-system/v9');
    expect(ENTITY_DISCOVERY_INPUT_VERSION).toBe('knowledge-entity-discovery-input/v4');
    expect(ENTITY_DISCOVERY_WIRE_VERSION).toBe('knowledge-entity-discovery-wire/v4');
    expect(ENTITY_DISCOVERY_CHECK_VERSION).toBe('knowledge-entity-discovery-check/v4');
    expect(ENTITY_DISCOVERY_OUTPUT_NAME).toBe('entity_discovery_v4');
    expect(ENTITY_DISCOVERY_WIRE_SCHEMA_JSON).toBe(JSON.stringify(ENTITY_DISCOVERY_WIRE_SCHEMA));
    expect(ENTITY_DISCOVERY_WIRE_ID).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(ENTITY_DISCOVERY_WIRE_SCHEMA)).toBe(true);
  });
});
