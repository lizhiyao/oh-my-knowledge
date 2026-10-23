import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { buildEntityDiscoveryInput, checkEntityDiscoveryResponse, ENTITY_DISCOVERY_INPUT_VERSION,
  ENTITY_DISCOVERY_OUTPUT_MAX_BYTES, ENTITY_DISCOVERY_WIRE_ID, ENTITY_DISCOVERY_WIRE_SCHEMA,
  ENTITY_DISCOVERY_WIRE_SCHEMA_JSON, type EntityDiscoveryResponse, type EntityDiscoverySource } from '../../src/knowledge/extraction/entity-discovery.js';
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
  const response: EntityDiscoveryResponse = { responseKind: 'entity-discovery', schemaVersion: 1,
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

  it('permits shared contextual anchor spans across different owners, not duplicate owned anchors', () => {
    const f = fixture(); f.response.anchors[3].selection = { ...f.response.anchors[1].selection };
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
  });

  it('rejects extra M/P fields and accepts a genuinely empty A catalog', () => {
    const f = fixture();
    expect(checkEntityDiscoveryResponse(JSON.stringify({ ...f.response, mentions: [] }), f.source).status).toBe('rejected');
    f.response.entities = []; f.response.anchors = [];
    expect(checkEntityDiscoveryResponse(JSON.stringify(f.response), f.source).status).toBe('checked');
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
    expect(ENTITY_DISCOVERY_WIRE_SCHEMA_JSON).toBe(JSON.stringify(ENTITY_DISCOVERY_WIRE_SCHEMA));
    expect(ENTITY_DISCOVERY_WIRE_ID).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(ENTITY_DISCOVERY_WIRE_SCHEMA)).toBe(true);
  });
});
