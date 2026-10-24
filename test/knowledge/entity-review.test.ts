import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { admitEntities } from '../../src/knowledge/extraction/entities.js';
import type { BoundKnowledgeCatalog, BoundKnowledgeSource } from '../../src/knowledge/extraction/bound-catalog.js';
import { buildEntityReviewInput, checkEntityReviewResponse, EntityReviewResponseSchema,
  ENTITY_REVIEW_INPUT_VERSION, ENTITY_REVIEW_SYSTEM, ENTITY_REVIEW_SYSTEM_VERSION, ENTITY_REVIEW_WIRE_SCHEMA,
  ENTITY_REVIEW_WIRE_SCHEMA_JSON, ENTITY_REVIEW_WIRE_ID, ENTITY_REVIEW_OUTPUT_MAX_BYTES,
  type EntityReviewResponse } from '../../src/knowledge/extraction/entity-review.js';
import { modelWindow, identityWindow } from './fixtures.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import { ENTITY_CODE_REFERENT_POLICY, ENTITY_COLLECTIVE_REFERENCE_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';

const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
// Authored contract fixtures test evidence preservation and usage policy, not model semantic quality.
function fixture(identity = false) {
  const ids: Record<string, string> = { project: uid(1), tool: uid(2), group: uid(3), m1: uid(11), m2: uid(12), m3: uid(13) };
  const packet = JSON.parse(JSON.stringify(identity ? identityWindow() : modelWindow(), (_key, value) =>
    typeof value === 'string' ? ids[value] ?? value : value)) as ReturnType<typeof modelWindow>;
  const source: BoundKnowledgeSource = { snapshotId: uid(20), sourceVersion: hash('authored source'), limitations: ['仅为来源说法'],
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 0, eventKind: 'message', role: 'user',
      text: '😀 Alpha 使用 Beta。它们的后续结果未知。' },
    { evidenceRef: 'record-2', recordIndex: 1, eventKind: 'message', role: 'assistant',
      text: '这是另一个来源说明，不能证明身份已经核实。' }] };
  const admitted = admitEntities(packet.entities, packet.mentions, source.excerpts);
  if (admitted.rejected.length) throw new Error('Fixture entity admission failed.');
  const catalog: BoundKnowledgeCatalog = { analysisId: uid(21), revisionId: uid(22), snapshotId: source.snapshotId,
    sourceVersion: source.sourceVersion, entities: admitted.entities, mentions: admitted.mentions, limitations: ['目录未进行真人复核'] };
  const response: EntityReviewResponse = { responseKind: 'entity-review', schemaVersion: 1,
    binding: JSON.parse(buildEntityReviewInput(source, catalog)).binding,
    decisions: catalog.entities.map(entity => ({ entityId: entity.entityId,
      qualification: { status: 'supported', reason: '原文独立讨论该对象。' },
      referent: { status: 'supported', reason: '当前全部提及的所指一致，未知仍明确保留。' },
      type: { status: 'supported', reason: '当前类型有来源依据。' },
      mentionIds: catalog.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.mentionId),
      evidenceRefs: ['record-1'] })) };
  return { source, catalog, response };
}
function checked(f: ReturnType<typeof fixture>) {
  const result = checkEntityReviewResponse(JSON.stringify(f.response), f.source, f.catalog);
  if (result.status !== 'checked') throw new Error(result.issues.join(','));
  return result;
}
function refreshBinding(f: ReturnType<typeof fixture>) {
  f.response.binding = JSON.parse(buildEntityReviewInput(f.source, f.catalog)).binding;
}

describe('fixed entity review and explicit downstream usage policy', () => {
  it('sends the complete immutable source/catalog projection and preserves the native return without acceptance claims', () => {
    const f = fixture(), before = structuredClone(f);
    const input = JSON.parse(buildEntityReviewInput({ ...f.source, sourcePath: '/private/raw' } as BoundKnowledgeSource,
      { ...f.catalog, review: 'gold answer', writeHeadRevisionId: uid(90) } as BoundKnowledgeCatalog));
    expect(input).toEqual({ taskKind: 'entity_review', taskVersion: ENTITY_REVIEW_INPUT_VERSION, binding: f.response.binding,
      excerpts: f.source.excerpts, limitations: f.source.limitations, entityAnalysis: f.catalog });
    const raw = ` \n${JSON.stringify(f.response)}\r\n`, result = checkEntityReviewResponse(raw, f.source, f.catalog);
    expect(result).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', response: f.response, usageBlockers: [],
      eligibleEntityIds: f.catalog.entities.map(entity => entity.entityId), eligibleMentionIds: f.catalog.mentions.map(mention => mention.mentionId) });
    expect(result.raw).toEqual({ encoding: 'raw-utf8', bytesBase64: Buffer.from(raw).toString('base64'), byteLength: Buffer.byteLength(raw),
      digest: hash(raw), text: raw });
    expect(result).not.toHaveProperty('formalReceipt'); expect(result).not.toHaveProperty('goldReady');
    expect(f).toEqual(before);
  });

  it.each([
    ['qualification', 'unsupported', 'exclude'], ['referent', 'unsupported', 'exclude'], ['type', 'unsupported', 'exclude'],
    ['qualification', 'undetermined', 'uncertain'], ['referent', 'undetermined', 'uncertain'], ['type', 'undetermined', 'uncertain'],
  ] as const)('keeps %s %s separate from structural acceptance and maps it to %s', (axis, status, disposition) => {
    const f = fixture(); f.response.decisions[0][axis] = { status, reason: '  待核对的原文判断。\n' };
    const before = structuredClone(f), result = checked(f);
    expect(result.decisions[0]).toEqual({ ...f.response.decisions[0], disposition });
    expect(result.eligibleEntityIds).toEqual([uid(2)]); expect(result.eligibleMentionIds).toEqual([uid(12)]);
    expect(result.usageBlockers).toEqual([]); expect(result.semanticStatus).toBe('not_reviewed');
    expect(f).toEqual(before);
  });

  it('exclusion takes precedence over uncertainty without rewriting either model assessment', () => {
    const f = fixture(); f.response.decisions[0].qualification.status = 'undetermined'; f.response.decisions[0].type.status = 'unsupported';
    const result = checked(f);
    expect(result.decisions[0]).toMatchObject({ disposition: 'exclude', qualification: { status: 'undetermined' }, type: { status: 'unsupported' } });
  });

  it('accepts reordered decision and complete mention sets while deriving IDs in original catalog order', () => {
    const f = fixture();
    f.catalog.mentions.push({ ...f.catalog.mentions[0], mentionId: uid(14), selection: {
      evidenceRef: 'record-1', quote: '后续结果', start: f.source.excerpts[0].text.indexOf('后续结果'), end: f.source.excerpts[0].text.indexOf('后续结果') + 4 } });
    f.response.decisions[0].mentionIds.push(uid(14)); f.response.decisions[0].mentionIds.reverse(); f.response.decisions.reverse(); refreshBinding(f);
    const result = checked(f);
    expect(result.response.decisions).toEqual(f.response.decisions);
    expect(result.decisions.map(decision => decision.entityId)).toEqual(f.catalog.entities.map(entity => entity.entityId));
    expect(result.eligibleMentionIds).toEqual(f.catalog.mentions.map(mention => mention.mentionId));
  });

  it.each([
    ['missing decision', (r: EntityReviewResponse) => { r.decisions.pop(); }, 'missing_entity:'],
    ['duplicate decision', (r: EntityReviewResponse) => { r.decisions.push(structuredClone(r.decisions[0])); }, ':duplicate_entity'],
    ['new entity', (r: EntityReviewResponse) => { r.decisions[0].entityId = uid(90); }, ':unknown_entity'],
    ['new mention', (r: EntityReviewResponse) => { r.decisions[0].mentionIds.push(uid(90)); }, ':mention_set_mismatch'],
    ['foreign mention', (r: EntityReviewResponse) => { r.decisions[0].mentionIds = [r.decisions[1].mentionIds[0]]; }, ':mention_set_mismatch'],
    ['duplicate mention', (r: EntityReviewResponse) => { r.decisions[0].mentionIds.push(r.decisions[0].mentionIds[0]); }, ':duplicate_mention'],
    ['unknown source', (r: EntityReviewResponse) => { r.decisions[0].evidenceRefs = ['outside']; }, ':unknown_evidence'],
    ['duplicate source', (r: EntityReviewResponse) => { r.decisions[0].evidenceRefs.push('record-1'); }, ':duplicate_evidence'],
    ['empty source list', (r: EntityReviewResponse) => { r.decisions[0].evidenceRefs = []; }, 'invalid_structure:'],
    ['blank reason', (r: EntityReviewResponse) => { r.decisions[0].qualification.reason = ' \n'; }, 'invalid_structure:'],
    ['new quote', (r: EntityReviewResponse) => { Object.assign(r.decisions[0], { quote: 'Alpha' }); }, 'invalid_structure:'],
    ['model disposition', (r: EntityReviewResponse) => { Object.assign(r.decisions[0], { disposition: 'retain' }); }, 'invalid_structure:'],
    ['new directory', (r: EntityReviewResponse) => { Object.assign(r, { entities: [] }); }, 'invalid_structure:'],
  ] as const)('rejects the whole review for %s, preserving raw instead of selecting good siblings', (_label, mutate, reason) => {
    const f = fixture(); mutate(f.response); const raw = JSON.stringify(f.response), before = structuredClone(f);
    const result = checkEntityReviewResponse(raw, f.source, f.catalog);
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('Unexpected review acceptance.');
    expect(result.issues.some(issue => issue.includes(reason))).toBe(true);
    expect(result.raw.text).toBe(raw); expect(result).not.toHaveProperty('eligibleEntityIds'); expect(f).toEqual(before);
  });

  it('requires all existing mentions, not just one correctly grounded mention', () => {
    const f = fixture(); f.response.decisions[0].mentionIds = [];
    expect(checkEntityReviewResponse(JSON.stringify(f.response), f.source, f.catalog)).toMatchObject({ status: 'rejected' });
  });

  it('binds exact source and immutable revision content, and refuses invalid catalogs before judging model output', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.source.excerpts[1].text += '新增限制'; },
      (f: ReturnType<typeof fixture>) => { f.catalog.revisionId = uid(91); },
      (f: ReturnType<typeof fixture>) => { f.catalog.entities[0].uncertainties.push('新目录主张'); },
    ]) {
      const f = fixture(); mutate(f);
      expect(checkEntityReviewResponse(JSON.stringify(f.response), f.source, f.catalog)).toMatchObject({ status: 'rejected', issues: ['binding_mismatch'] });
    }
    const f = fixture(); f.catalog.mentions[0].selection.start++;
    expect(() => buildEntityReviewInput(f.source, f.catalog)).toThrow('Invalid bound entity analysis');
    expect(() => checkEntityReviewResponse(JSON.stringify(f.response), f.source, f.catalog)).toThrow('Invalid bound entity analysis');
    const oversized = fixture(); oversized.source.excerpts[1].text = 'x'.repeat(EXTRACTION_INPUT_MAX_BYTES);
    expect(() => buildEntityReviewInput(oversized.source, oversized.catalog)).toThrow(ExtractionInputCapacityError);
  });

  it('blocks transitive identity dependencies without changing model decisions, collection membership or original mentions', () => {
    const f = fixture(true); f.catalog.entities.reverse(); f.response.decisions.reverse(); refreshBinding(f);
    f.response.decisions.find(decision => decision.entityId === uid(1))!.qualification.status = 'unsupported';
    const before = structuredClone(f), result = checked(f);
    expect(result.decisions.map(decision => [decision.entityId, decision.disposition])).toEqual([[uid(3), 'retain'], [uid(2), 'retain'], [uid(1), 'exclude']]);
    expect(result.eligibleEntityIds).toEqual([]); expect(result.eligibleMentionIds).toEqual([]);
    expect(result.usageBlockers).toEqual([
      { entityId: uid(3), reasons: [`entity_dependency_unavailable:${uid(1)}`, `entity_dependency_unavailable:${uid(2)}`] },
      { entityId: uid(2), reasons: [`entity_dependency_unavailable:${uid(1)}`] },
    ]);
    expect(result.response).toEqual(f.response); expect(f).toEqual(before);
  });

  it('blocks an unavailable identity-evidence mention independently of explicit member IDs', () => {
    const f = fixture(true), group = f.catalog.entities[2];
    group.collection = { ...group.collection!, completeness: 'unknown', memberEntityIds: [], mentionIds: [uid(13), uid(12)] };
    group.uncertainties = ['成员未知，不补造成员。']; refreshBinding(f);
    f.response.decisions[1].referent.status = 'undetermined';
    const before = structuredClone(f), result = checked(f);
    expect(result.eligibleEntityIds).toEqual([uid(1)]);
    expect(result.usageBlockers).toEqual([{ entityId: uid(3), reasons: [`identity_mention_unavailable:${uid(12)}`] }]);
    expect(result.decisions[2].disposition).toBe('retain'); expect(f).toEqual(before);
  });

  it('blocks a retained unresolved identity when its explicit possible target is unavailable', () => {
    const f = fixture(); f.catalog.entities[1].identityStatus = 'unresolved';
    f.catalog.entities[1].possibleEntityIds = [uid(1)]; f.catalog.entities[1].uncertainties = ['可能指向前者，尚未核实。']; refreshBinding(f);
    f.response.decisions[0].type.status = 'unsupported';
    const result = checked(f);
    expect(result.eligibleEntityIds).toEqual([]);
    expect(result.usageBlockers).toEqual([{ entityId: uid(2), reasons: [`entity_dependency_unavailable:${uid(1)}`] }]);
  });

  it('accepts an empty fixed catalog without inventing decisions or eligibility', () => {
    const f = fixture(); f.catalog.entities = []; f.catalog.mentions = []; f.response.decisions = []; refreshBinding(f);
    expect(checked(f)).toMatchObject({ decisions: [], eligibleEntityIds: [], eligibleMentionIds: [], usageBlockers: [] });
  });

  it('preserves malformed byte evidence, enforces capacity, and refuses lossy native strings', () => {
    const f = fixture();
    for (const [input, issue] of [[Buffer.from([0xff]), 'invalid_utf8'], [Buffer.from('{'), 'invalid_json'],
      [Buffer.alloc(ENTITY_REVIEW_OUTPUT_MAX_BYTES + 1, 32), 'output_capacity']] as const) {
      const result = checkEntityReviewResponse(input, f.source, f.catalog);
      expect(result).toMatchObject({ status: 'rejected', issues: [issue] });
      expect(result.raw.digest).toBe(hash(input)); expect(Buffer.from(result.raw.bytesBase64, 'base64')).toEqual(input);
    }
    expect(() => checkEntityReviewResponse('\ud800', f.source, f.catalog)).toThrow('no byte identity computed');
    const escaped = JSON.stringify(f.response).replace('原文独立讨论该对象。', '\\ud800');
    expect(checkEntityReviewResponse(escaped, f.source, f.catalog)).toMatchObject({ status: 'rejected', issues: ['invalid_utf8'] });
  });

  it('provides one immutable strict wire contract and keeps semantic policy separate from host proof', () => {
    const f = fixture(), ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(ajv.compile(ENTITY_REVIEW_WIRE_SCHEMA)(f.response)).toBe(true);
    expect(EntityReviewResponseSchema.safeParse(f.response).success).toBe(true);
    expect(ENTITY_REVIEW_WIRE_SCHEMA_JSON).toBe(JSON.stringify(ENTITY_REVIEW_WIRE_SCHEMA));
    expect(ENTITY_REVIEW_SYSTEM_VERSION).toBe('knowledge-entity-review-system/v3');
    expect(ENTITY_REVIEW_SYSTEM.split(ENTITY_CODE_REFERENT_POLICY)).toHaveLength(2);
    expect(ENTITY_REVIEW_SYSTEM.split(ENTITY_COLLECTIVE_REFERENCE_POLICY)).toHaveLength(2);
    expect(hash(ENTITY_REVIEW_SYSTEM)).toBe('sha256:e2e21984ced35d3e4cd182070b4035f068de9a5ec952f17a1858bda7fd3440e8');
    expect(hash(ENTITY_REVIEW_WIRE_SCHEMA_JSON)).toBe('sha256:658dab325cf4a0648404f42b23c3c7621ca4027cf7881778235892150e310b20');
    expect(ENTITY_REVIEW_WIRE_ID).toBe('sha256:b466259a6e04c95bc4581d9bb224e774af681a8e512174601f8f22f81b675d0f');
    expect(Object.isFrozen(ENTITY_REVIEW_WIRE_SCHEMA)).toBe(true);
    expect(ENTITY_REVIEW_SYSTEM).toContain('全部既有 mentions');
    expect(ENTITY_REVIEW_SYSTEM).toContain('不是签名或归档认证');
    expect(checked(f).semanticStatus).toBe('not_reviewed');
  });
});
