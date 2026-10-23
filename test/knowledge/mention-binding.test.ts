import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { buildEntityDiscoveryInput, type EntityDiscoveryResponse, type EntityDiscoverySource } from '../../src/knowledge/extraction/entity-discovery.js';
import { buildMentionBindingInput, checkMentionBindingResponse, MENTION_BINDING_INPUT_VERSION,
  MENTION_BINDING_OUTPUT_MAX_BYTES, MENTION_BINDING_WIRE_SCHEMA, MENTION_BINDING_WIRE_SCHEMA_JSON, MENTION_BINDING_WIRE_ID,
  type DiscoveryForBinding, type MentionBindingResponse } from '../../src/knowledge/extraction/mention-binding.js';
import { authoredDiscoverySourcePlan } from './discovered-entities-fixtures.js';
import { ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ref = (value: string) => ({ bytes: Buffer.byteLength(value), digest: hash(value) });
function fixture() {
  const source: EntityDiscoverySource = { snapshotId: '00000000-0000-4000-8000-000000000001',
    sourceVersion: hash('authored binding source'), limitations: ['保留来源的不确定性。'],
    excerpts: [{ evidenceRef: 'r1', recordIndex: 0, eventKind: 'message', role: 'user',
      text: '😀 Alpha 组件；Alpha v1 实例；该组成员未知。Alpha 后续情况未知。它与未入目录对象待辨。' }] };
  const entity = (entityId: string, label: string): EntityDiscoveryResponse['entities'][number] => ({ entityId, label,
    description: `${label} 是被讨论的对象。`, qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
    referentKind: 'object', componentRef: null, collection: null });
  const { planPredecessor } = authoredDiscoverySourcePlan(source, undefined, [{ objectId: 'source-object', quote: 'Alpha', occurrence: 0 }]);
  const a: EntityDiscoveryResponse = { responseKind: 'entity-discovery', schemaVersion: 2,
    binding: JSON.parse(buildEntityDiscoveryInput(source, planPredecessor)).binding,
    dispositions: [{ sourcePlanObjectId: 'source-object', dispositionKind: 'retained', entityIds: ['c'],
      rationale: 'Authored mapping judgment; other independently grounded objects remain source-only discoveries.',
      selections: [{ evidenceRef: 'r1', quote: 'Alpha', occurrence: 0 }] }],
    entities: [entity('c', 'Alpha'), entity('i', 'Alpha v1'), entity('g', '该组')],
    anchors: [{ anchorId: 'ac', entityId: 'c', selection: { evidenceRef: 'r1', quote: 'Alpha 组件', occurrence: null } },
      { anchorId: 'ai', entityId: 'i', selection: { evidenceRef: 'r1', quote: 'Alpha v1 实例', occurrence: null } },
      { anchorId: 'ag', entityId: 'g', selection: { evidenceRef: 'r1', quote: '该组成员未知', occurrence: null } }] };
  a.entities[0].referentKind = 'component'; a.entities[1].referentKind = 'instance';
  a.entities[1].componentRef = { entityId: 'c', anchorIds: ['ai'], rationale: '当前实例属于该组件。' };
  a.entities[2].referentKind = 'collection'; a.entities[2].uncertainties = ['组的成员未知。'];
  a.entities[2].collection = { memberEntityIds: [], completeness: 'unknown', anchorIds: ['ag'], rationale: '共同指代这一个组。' };
  const discovery: DiscoveryForBinding = { receiptId: '00000000-0000-4000-8000-000000000002', receiptRaw: '',
    receiptRef: ref('temporary'), nativeRef: ref('authored native archive; authenticated by evidence layer'),
    requestDigest: hash('full request owned by evidence layer'), rawOutput: ` \n${JSON.stringify(a)}\n` };
  const refreshReceipt = () => {
    discovery.receiptRaw = JSON.stringify({ receiptKind: 'knowledge-entity-discovery-receipt', schemaVersion: 2,
      receiptId: discovery.receiptId, snapshotId: source.snapshotId, sourceVersion: source.sourceVersion,
      nativeRef: discovery.nativeRef, requestDigest: discovery.requestDigest,
      request: { input: buildEntityDiscoveryInput(source, planPredecessor) } });
    discovery.receiptRef = ref(discovery.receiptRaw);
  };
  refreshReceipt();
  const mention = (mentionId: string, entityId: string, quote: string, occurrence: number | null): MentionBindingResponse['mentions'][number] => ({
    mentionId, entityId, selection: { evidenceRef: 'r1', quote, occurrence }, basis: 'explicit', rationale: '来源直接提及。',
    bindingStatus: 'bound', candidateEntityIds: [], reason: null });
  const response: MentionBindingResponse = { responseKind: 'mention-binding', schemaVersion: 2,
    binding: JSON.parse(buildMentionBindingInput(source, discovery)).binding,
    mentions: [mention('mc', 'c', 'Alpha', 0), mention('mi', 'i', 'Alpha v1', null), mention('mg', 'g', '该组', null)],
    identitySupports: [{ entityId: 'i', supportKind: 'componentRef', mentionIds: ['mi'] },
      { entityId: 'g', supportKind: 'collection', mentionIds: ['mg'] }] };
  return { source, a, discovery, response, refreshReceipt, mention, planPredecessor };
}
function check(f: ReturnType<typeof fixture>) { return checkMentionBindingResponse(JSON.stringify(f.response), f.source, f.discovery); }
function reject(f: ReturnType<typeof fixture>, code: string) {
  const result = check(f); expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.issues.some(issue => issue.includes(code))).toBe(true);
}
function ready(f: ReturnType<typeof fixture>) {
  const result = check(f);
  if (result.status !== 'checked') throw new Error(result.issues.join(','));
  if (result.admission.status !== 'ready') throw new Error(result.admission.issues.join(','));
  return result.admission.analysis;
}

describe('private immutable-catalog mention binding B', () => {
  it('sends full A receipt/raw plus the same full source, and converts only explicit B identity supports', () => {
    const f = fixture(), before = structuredClone({ source: f.source, discovery: f.discovery, response: f.response });
    const input = JSON.parse(buildMentionBindingInput({ ...f.source, gold: 'never sent' } as EntityDiscoverySource, f.discovery));
    expect(input).toEqual({ taskKind: 'mention_binding', taskVersion: MENTION_BINDING_INPUT_VERSION,
      binding: f.response.binding, ...f.source, discovery: { receiptRaw: f.discovery.receiptRaw, rawOutput: f.discovery.rawOutput } });
    expect(input.binding.discoveryRawDigest).toBe(hash(f.discovery.rawOutput));
    const analysis = ready(f);
    expect(analysis.entities[1].componentRef).toEqual({ entityId: 'c', rationale: f.a.entities[1].componentRef!.rationale, mentionIds: ['mi'] });
    expect(analysis.entities[2].collection).toEqual({ completeness: 'unknown', memberEntityIds: [], rationale: f.a.entities[2].collection!.rationale, mentionIds: ['mg'] });
    expect(analysis.entities[2].identityStatus).toBe('proposed');
    expect(analysis.mentions.map(m => m.mentionId)).toEqual(['mc', 'mi', 'mg']);
    expect(analysis.mentions[0].selection).toEqual({ evidenceRef: 'r1', quote: 'Alpha', start: 3, end: 8 });
    expect({ source: f.source, discovery: f.discovery, response: f.response }).toEqual(before);
    const raw = ` \n${JSON.stringify(f.response)}\r\n`, bytes = Buffer.from(raw);
    const result = checkMentionBindingResponse(bytes, f.source, f.discovery); bytes.fill(0);
    expect(result).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', raw: { text: raw, digest: hash(raw), byteLength: Buffer.byteLength(raw) } });
  });

  it('preserves ambiguous and unbound source mentions as checked blockers without synthesizing unresolved entities', () => {
    const f = fixture();
    f.response.mentions.push({ ...f.mention('amb', 'c', '它', null), bindingStatus: 'ambiguous', entityId: null,
      candidateEntityIds: ['c', 'i'], reason: '此处原文对应尚未明确。' },
    { ...f.mention('gap', 'c', '未入目录对象', null), bindingStatus: 'unbound', entityId: null,
      candidateEntityIds: [], reason: '原文的“未入目录对象”没有可绑定的目录项。' });
    const result = check(f);
    expect(result).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', response: f.response,
      admission: { status: 'blocked', issues: ['mention:amb:ambiguous', 'mention:gap:unbound'] } });
    if (result.status === 'checked') expect(result.admission).not.toHaveProperty('analysis');
    expect(f.a.entities).toHaveLength(3);
  });

  it('blocks an omitted entity mention and never turns its owned anchor into a replacement', () => {
    const f = fixture(); f.response.mentions.shift();
    expect(check(f)).toMatchObject({ status: 'checked', admission: { status: 'blocked', issues: ['entity:c:missing_bound_anchor_mention'] } });
  });

  it('requires an owned anchor match even when a bound mention exists elsewhere in source', () => {
    const f = fixture(); f.response.mentions[0].selection.occurrence = 2;
    expect(check(f)).toMatchObject({ status: 'checked', admission: { status: 'blocked', issues: ['entity:c:missing_bound_anchor_mention'] } });
  });

  it.each([
    ['new directory id', (f: ReturnType<typeof fixture>) => { f.response.mentions[0].entityId = 'new'; }, 'unknown_entity'],
    ['bound candidates', (f: ReturnType<typeof fixture>) => { f.response.mentions[0].candidateEntityIds = ['i']; }, 'invalid_bound_shape'],
    ['bound reason', (f: ReturnType<typeof fixture>) => { f.response.mentions[0].reason = '猜测'; }, 'invalid_bound_shape'],
    ['ambiguous one candidate', (f: ReturnType<typeof fixture>) => { Object.assign(f.response.mentions[0], { bindingStatus: 'ambiguous', entityId: null, candidateEntityIds: ['c'], reason: '未决' }); }, 'invalid_ambiguous_shape'],
    ['unbound two candidates', (f: ReturnType<typeof fixture>) => { Object.assign(f.response.mentions[0], { bindingStatus: 'unbound', entityId: null, candidateEntityIds: ['c', 'i'], reason: '未决' }); }, 'invalid_unbound_shape'],
    ['unknown candidate', (f: ReturnType<typeof fixture>) => { Object.assign(f.response.mentions[0], { bindingStatus: 'unbound', entityId: null, candidateEntityIds: ['new'], reason: '未决' }); }, 'unknown_candidate'],
    ['duplicate candidate', (f: ReturnType<typeof fixture>) => { Object.assign(f.response.mentions[0], { bindingStatus: 'ambiguous', entityId: null, candidateEntityIds: ['c', 'c'], reason: '未决' }); }, 'duplicate_candidate'],
    ['duplicate mention id', (f: ReturnType<typeof fixture>) => { f.response.mentions.push({ ...f.response.mentions[0], selection: { evidenceRef: 'r1', quote: '它', occurrence: null } }); }, 'duplicate_mention'],
    ['duplicate source position', (f: ReturnType<typeof fixture>) => { f.response.mentions.push({ ...f.response.mentions[0], mentionId: 'other' }); }, 'duplicate_mention_position'],
    ['unknown source', (f: ReturnType<typeof fixture>) => { f.response.mentions[0].selection.evidenceRef = 'outside'; }, 'unknown_evidence'],
    ['ambiguous locator', (f: ReturnType<typeof fixture>) => { f.response.mentions[0].selection.occurrence = null; }, 'ambiguous_quote'],
    ['identifier fragment', (f: ReturnType<typeof fixture>) => { f.response.mentions[0].selection.quote = 'lpha'; }, 'mention_identifier_fragment'],
    ['missing identity support', (f: ReturnType<typeof fixture>) => { f.response.identitySupports.shift(); }, 'missing_support'],
    ['duplicate identity support', (f: ReturnType<typeof fixture>) => { f.response.identitySupports.push(structuredClone(f.response.identitySupports[0])); }, 'duplicate_support'],
    ['invented identity declaration', (f: ReturnType<typeof fixture>) => { f.response.identitySupports.push({ entityId: 'c', supportKind: 'collection', mentionIds: ['mc'] }); }, 'unexpected_support'],
    ['duplicate identity mention', (f: ReturnType<typeof fixture>) => { f.response.identitySupports[0].mentionIds.push('mi'); }, 'duplicate_mention'],
    ['missing identity mention', (f: ReturnType<typeof fixture>) => { f.response.identitySupports[0].mentionIds = ['missing']; }, 'unknown_or_unbound_mention'],
    ['foreign identity owner', (f: ReturnType<typeof fixture>) => { f.response.identitySupports[0].mentionIds = ['mc']; }, 'missing_entity_mention'],
    ['outside identity anchor', (f: ReturnType<typeof fixture>) => { f.response.mentions[1].selection = { evidenceRef: 'r1', quote: 'Alpha', occurrence: 2 }; }, 'outside_identity_anchor'],
    ['B binding changed', (f: ReturnType<typeof fixture>) => { f.response.binding.discoveryRawDigest = hash('different raw'); }, 'binding_mismatch'],
  ])('rejects %s without partial admission', (_name, mutate, code) => { const f = fixture(); mutate(f); reject(f, code); });

  it('rejects supporting a declaration with ambiguous mention rather than manufacturing an identity', () => {
    const f = fixture(); Object.assign(f.response.mentions[1], { bindingStatus: 'ambiguous', entityId: null, candidateEntityIds: ['c', 'i'], reason: '来源未决定。' });
    reject(f, 'unknown_or_unbound_mention');
  });

  it('keeps one-candidate unbound distinct from a bound mention and blocks admission', () => {
    const f = fixture(); Object.assign(f.response.mentions[0], { bindingStatus: 'unbound', entityId: null, candidateEntityIds: ['c'], reason: '候选不足以确认绑定。' });
    expect(check(f)).toMatchObject({ status: 'checked', admission: { status: 'blocked', issues: ['mention:mc:unbound', 'entity:c:missing_bound_anchor_mention'] } });
  });

  it('preserves permitted mention rationale whitespace through existing admission', () => {
    const f = fixture(); f.response.mentions[0].rationale = '  来源直接提及。 ';
    expect(ready(f).mentions[0].rationale).toBe(f.response.mentions[0].rationale);
  });

  it('authenticates the minimal predecessor association and rechecks A before build and check', () => {
    const f = fixture(); f.discovery.receiptRaw += ' ';
    expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow('byte reference mismatch');
    expect(() => check(f)).toThrow('byte reference mismatch');
    f.discovery.receiptRef = ref(f.discovery.receiptRaw); f.discovery.nativeRef = ref('other native');
    expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow('binding mismatch');
    f.refreshReceipt(); f.discovery.rawOutput = JSON.stringify({ ...f.a, mentions: [] });
    expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow('predecessor rejected');
    f.discovery.rawOutput = JSON.stringify(f.a); f.source.limitations.push('changed source');
    expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow('binding mismatch');
  });

  it('rejects receipt substitution with refreshed byte ref when identity or source input does not match', () => {
    for (const field of ['receiptId', 'snapshotId', 'sourceVersion', 'requestDigest', 'input'] as const) {
      const f = fixture(), receipt = JSON.parse(f.discovery.receiptRaw);
      if (field === 'input') receipt.request.input += ' ';
      else receipt[field] = 'other';
      f.discovery.receiptRaw = JSON.stringify(receipt); f.discovery.receiptRef = ref(f.discovery.receiptRaw);
      expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow('binding mismatch');
    }
  });

  it('blocks a complete but undecided A disposition before producing a B task, with A raw intact', () => {
    const f = fixture(); Object.assign(f.a.dispositions[0], { dispositionKind: 'undetermined', entityIds: [] });
    f.discovery.rawOutput = ` \n${JSON.stringify(f.a)}\r\n`;
    const before = f.discovery.rawOutput;
    expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow('undetermined');
    expect(() => check(f)).toThrow('undetermined');
    expect(f.discovery.rawOutput).toBe(before); expect(f.a.entities).toHaveLength(3);
  });

  it('rechecks the exact plan predecessor in A input instead of accepting matching catalog objects', () => {
    for (const mode of ['raw', 'receipt-ref', 'source'] as const) {
      const f = fixture(), receipt = JSON.parse(f.discovery.receiptRaw);
      if (mode === 'raw') receipt.request.input = JSON.stringify({ ...JSON.parse(receipt.request.input),
        sourcePlanResponse: { ...f.planPredecessor, rawOutput: `${f.planPredecessor.rawOutput} ` } });
      if (mode === 'receipt-ref') receipt.request.input = JSON.stringify({ ...JSON.parse(receipt.request.input),
        sourcePlanResponse: { ...f.planPredecessor, receiptRef: ref('other plan receipt') } });
      if (mode === 'source') receipt.request.input = JSON.stringify({ ...JSON.parse(receipt.request.input), sourceVersion: hash('other source') });
      f.discovery.receiptRaw = JSON.stringify(receipt); f.discovery.receiptRef = ref(f.discovery.receiptRaw);
      expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow();
    }
  });

  it('accepts an empty catalog only with zero mentions and zero support declarations', () => {
    const f = fixture(); f.a.entities = []; f.a.anchors = [];
    Object.assign(f.a.dispositions[0], { dispositionKind: 'excluded', entityIds: [] });
    f.discovery.rawOutput = JSON.stringify(f.a);
    f.response.binding = JSON.parse(buildMentionBindingInput(f.source, f.discovery)).binding;
    f.response.mentions = []; f.response.identitySupports = [];
    expect(ready(f)).toEqual({ entities: [], mentions: [] });
    f.response.mentions.push({ ...f.mention('gap', 'c', '它', null), bindingStatus: 'unbound', entityId: null, reason: '无目录项。' });
    reject(f, 'empty_catalog_has_mentions');
  });

  it('rejects foreign directory fields, invalid raw bytes/Unicode/JSON and oversized output', () => {
    const f = fixture();
    expect(checkMentionBindingResponse(JSON.stringify({ ...f.response, entities: f.a.entities }), f.source, f.discovery).status).toBe('rejected');
    const bytes = Buffer.from([0xff]);
    expect(checkMentionBindingResponse(bytes, f.source, f.discovery)).toMatchObject({ status: 'rejected', issues: ['invalid_utf8'], raw: { text: null, digest: hash(bytes) } });
    expect(checkMentionBindingResponse('{', f.source, f.discovery)).toMatchObject({ status: 'rejected', issues: ['invalid_json'] });
    expect(checkMentionBindingResponse(' '.repeat(MENTION_BINDING_OUTPUT_MAX_BYTES + 1), f.source, f.discovery)).toMatchObject({ status: 'rejected', issues: ['output_capacity'] });
    f.response.mentions[0].rationale = '\ud800'; reject(f, 'invalid_utf8');
    expect(() => checkMentionBindingResponse('\ud800', f.source, f.discovery)).toThrow('not valid UTF-8');
  });

  it('checks the capacity of full receipt plus raw A and source, without shortening originals', () => {
    const f = fixture(), receipt = JSON.parse(f.discovery.receiptRaw);
    receipt.padding = '界'.repeat(400_000); f.discovery.receiptRaw = JSON.stringify(receipt); f.discovery.receiptRef = ref(f.discovery.receiptRaw);
    expect(() => buildMentionBindingInput(f.source, f.discovery)).toThrow(ExtractionInputCapacityError);
  });

  it('publishes a frozen strict B wire with no catalog rewrite lane', () => {
    const f = fixture(), validate = new Ajv2020({ strict: true }).compile(MENTION_BINDING_WIRE_SCHEMA);
    expect(validate(f.response)).toBe(true); expect(validate({ ...f.response, entities: [] })).toBe(false);
    expect(MENTION_BINDING_WIRE_SCHEMA_JSON).toBe(JSON.stringify(MENTION_BINDING_WIRE_SCHEMA));
    expect(MENTION_BINDING_WIRE_ID).toMatch(/^sha256:[a-f0-9]{64}$/); expect(Object.isFrozen(MENTION_BINDING_WIRE_SCHEMA)).toBe(true);
  });
});
