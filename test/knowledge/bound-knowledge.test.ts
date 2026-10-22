import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { admitEntities } from '../../src/knowledge/extraction/entities.js';
import { checkWindowExtractionResponse } from '../../src/knowledge/extraction/window-proposals.js';
import { WINDOW_EXTRACTION_WIRE_ID } from '../../src/knowledge/extraction/model-wire.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import {
  buildBoundKnowledgeInput, checkBoundKnowledgeResponse, type BoundKnowledgeCatalog, type BoundKnowledgeSource,
  BOUND_KNOWLEDGE_SYSTEM, BOUND_KNOWLEDGE_SYSTEM_VERSION, BOUND_KNOWLEDGE_INPUT_VERSION,
  BOUND_KNOWLEDGE_WIRE_VERSION, BOUND_KNOWLEDGE_CHECK_VERSION, BOUND_KNOWLEDGE_OUTPUT_NAME,
  BOUND_KNOWLEDGE_WIRE_SCHEMA, BOUND_KNOWLEDGE_WIRE_SCHEMA_JSON, BOUND_KNOWLEDGE_WIRE_ID,
  BOUND_KNOWLEDGE_WIRE_IDENTITY, BOUND_KNOWLEDGE_OUTPUT_MAX_BYTES,
} from '../../src/knowledge/extraction/bound-knowledge.js';
import { modelWindow, wireModelWindow } from './fixtures.js';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
// Authored contract fixtures do not show that a model identifies entities or preserves knowledge.
function fixture() {
  const ids: Record<string, string> = { project: uid(1), tool: uid(2), m1: uid(3), m2: uid(4) };
  const packet = JSON.parse(JSON.stringify(modelWindow(), (_key, value) => typeof value === 'string' ? ids[value] ?? value : value)) as ReturnType<typeof modelWindow>;
  const source: BoundKnowledgeSource = { snapshotId: uid(5), sourceVersion: hash('authored raw source'),
    limitations: ['  仅为来源说法，不是独立核验。\n'],
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 7, eventKind: 'message', role: 'assistant', timestamp: '2026-10-23T00:00:00Z',
      text: '😀 Alpha 使用 Beta；只限沙盒，尚未验证生产。Alpha 的后续结果未知。' }] };
  packet.mentions[0].selection.occurrence = 0;
  const admitted = admitEntities(packet.entities, packet.mentions, source.excerpts);
  const catalog: BoundKnowledgeCatalog = { analysisId: uid(6), revisionId: uid(7), snapshotId: source.snapshotId,
    sourceVersion: source.sourceVersion, entities: admitted.entities, mentions: admitted.mentions, limitations: ['成员角色尚待内容复核。'] };
  const statement = packet.proposals[0].draft.content.statements[0];
  statement.context.conditions = ['只限沙盒']; statement.context.exceptions = ['生产范围未经验证'];
  statement.context.unknowns = ['后续结果未知'];
  packet.proposals[0].citations[0].selection.quote = 'Alpha 使用 Beta；只限沙盒，尚未验证生产';
  const response = { responseKind: 'bound-knowledge', schemaVersion: 1,
    binding: JSON.parse(buildBoundKnowledgeInput(source, catalog)).binding,
    proposals: wireModelWindow(packet).proposals, catalogGaps: [] as { gapId: string; reason: string;
      anchors: { evidenceRef: string; quote: string; occurrence: number | null }[] }[] };
  return { source, catalog, response, packet };
}
function checked(f: ReturnType<typeof fixture>) {
  const result = checkBoundKnowledgeResponse(JSON.stringify(f.response), f.source, f.catalog);
  if (result.status !== 'checked') throw new Error(result.issues.join(','));
  return result;
}

describe('knowledge bound to one immutable entity analysis revision', () => {
  it('uses a complete whitelisted source/catalog projection, preserves knowledge and never returns a second analysis', () => {
    const f = fixture(), before = structuredClone(f);
    const input = buildBoundKnowledgeInput({ ...f.source, sourcePath: '/private/raw', records: ['private'] } as BoundKnowledgeSource,
      { ...f.catalog, generation: 9, writeHeadRevisionId: uid(99), review: 'not an input' } as BoundKnowledgeCatalog);
    expect(JSON.parse(input)).toEqual({ taskKind: 'bound_knowledge', taskVersion: BOUND_KNOWLEDGE_INPUT_VERSION,
      binding: f.response.binding, excerpts: f.source.excerpts, limitations: f.source.limitations, entityAnalysis: f.catalog });
    expect(input).not.toContain('/private/'); expect(input).not.toContain('writeHeadRevisionId');
    const raw = ` \n${JSON.stringify(f.response)}\r\n`, result = checkBoundKnowledgeResponse(raw, f.source, f.catalog);
    expect(result).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', wireStatus: 'valid', rejected: [] });
    expect(result.raw.text).toBe(raw); expect(Buffer.from(result.raw.bytesBase64, 'base64').toString('utf8')).toBe(raw);
    if (result.status !== 'checked') throw new Error('Unexpected rejection');
    expect(result.accepted[0].draft.content).toEqual(f.packet.proposals[0].draft.content);
    expect(result.accepted[0].draft.entities).toEqual(f.catalog.entities.map(({ entityId, label, description }) => ({ entityId, label, description })));
    expect(result.accepted[0].mentions).toEqual(f.catalog.mentions);
    expect(result.accepted[0].citations[0].selection.start).toBe(3);
    expect(result).not.toHaveProperty('analysis'); expect(result).not.toHaveProperty('formalReceipt');
    expect(f).toEqual(before);
  });

  it('binds exact source and catalog content as well as revision IDs without claiming authentication', () => {
    const f = fixture();
    for (const mutate of [
      () => { f.catalog.revisionId = uid(8); },
      () => { f.catalog.entities[0].qualifiers.push('原目录修订差异'); },
      () => { f.source.excerpts[0].text += '\n新增来源条件'; },
    ]) {
      const original = structuredClone(f); mutate();
      expect(checkBoundKnowledgeResponse(JSON.stringify(f.response), f.source, f.catalog))
        .toMatchObject({ status: 'rejected', issues: ['binding_mismatch'], semanticStatus: 'not_reviewed' });
      Object.assign(f, original);
    }
    f.catalog.sourceVersion = hash('another version');
    expect(() => buildBoundKnowledgeInput(f.source, f.catalog)).toThrow('source binding mismatch');
    f.catalog.sourceVersion = f.source.sourceVersion; f.catalog.mentions[0].selection.start++;
    expect(() => buildBoundKnowledgeInput(f.source, f.catalog)).toThrow('Invalid bound entity analysis');
    const normalized = fixture(); normalized.catalog.entities[0].label = ' Alpha ';
    expect(() => buildBoundKnowledgeInput(normalized.source, normalized.catalog)).toThrow('would require normalization');
  });

  it.each([
    ['unknown entity catalog reference', (p: ReturnType<typeof fixture>['response']['proposals'][number]) => { p.entityIds[0] = uid(90); }, 'unknown_entity_analysis_reference'],
    ['unknown mention catalog reference', (p: ReturnType<typeof fixture>['response']['proposals'][number]) => { p.mentionIds[0] = uid(90); }, 'unknown_mention_analysis_reference'],
    ['unknown statement endpoint', (p: ReturnType<typeof fixture>['response']['proposals'][number]) => { p.draft.content.statements[0].subject.entityId = uid(90); }, 'unknown_entity:content.statements.0.subject'],
    ['ambiguous quote', (p: ReturnType<typeof fixture>['response']['proposals'][number]) => { p.citations[0].selection.quote = 'Alpha'; }, 'citation:ambiguous_quote'],
  ] as const)('rejects %s without repairing it or losing valid siblings', (_name, mutate, reason) => {
    const f = fixture(), bad = structuredClone(f.response.proposals[0]); bad.proposalId = 'bad'; mutate(bad);
    f.response.proposals.push(bad); const before = structuredClone(f);
    const result = checked(f);
    expect(result.accepted.map(value => value.proposalId)).toEqual(['candidate-1']);
    expect(result.rejected).toEqual([{ index: 1, reasons: expect.arrayContaining([reason]) }]);
    expect(f).toEqual(before);
  });

  it('keeps model-declared gaps separate from structural proposal admission and preserves empty/unknown outcomes', () => {
    const f = fixture(); f.response.catalogGaps = [{ gapId: 'missing-role', reason: '目录没有独立表示该限制的所指；待复核。',
      anchors: [{ evidenceRef: 'record-1', quote: '后续结果未知', occurrence: null }] }];
    const result = checked(f);
    expect(result.catalogGaps).toEqual(f.response.catalogGaps); expect(result.accepted).toHaveLength(1);
    expect(result.groundedGapAnchors).toEqual([{ gapId: 'missing-role', anchorIndex: 0,
      selection: { evidenceRef: 'record-1', quote: '后续结果未知', start: f.source.excerpts[0].text.indexOf('后续结果未知'), end: f.source.excerpts[0].text.indexOf('后续结果未知') + 6 } }]);
    f.response.proposals = []; f.response.catalogGaps = [];
    expect(checked(f)).toMatchObject({ accepted: [], rejected: [], semanticStatus: 'not_reviewed' });
    f.response.catalogGaps = [{ gapId: 'bad', reason: '未知', anchors: [{ evidenceRef: 'record-1', quote: '不存在', occurrence: null }] }];
    expect(checkBoundKnowledgeResponse(JSON.stringify(f.response), f.source, f.catalog)).toMatchObject({ status: 'rejected', issues: ['gap:quote_mismatch'] });
  });

  it('maps only the two declared optional-null paths and rejects required nulls, extra catalogs and missing wire fields', () => {
    const f = fixture();
    f.response.proposals[0].draft.content.statements[0].object = null;
    expect(checked(f).accepted[0].draft.content.statements[0]).not.toHaveProperty('object');
    const malformed = structuredClone(f.response.proposals[0]); malformed.proposalId = 'malformed';
    malformed.draft.content.statements = null as never; f.response.proposals.push(malformed);
    expect(checked(f).rejected).toHaveLength(1); // Malformed JSON items cannot crash the shared checker.
    f.response.proposals.pop();
    f.response.proposals[0].draft.content.statements[0].subject = null as never;
    expect(checked(f)).toMatchObject({ accepted: [], rejected: [{ index: 0, reasons: expect.arrayContaining(['invalid_structure:draft.content.statements.0.subject']) }] });
    const clean = fixture();
    delete (clean.response.proposals[0].citations[0].selection as { occurrence?: number | null }).occurrence;
    expect(checked(clean)).toMatchObject({ accepted: [], rejected: [{ index: 0, reasons: ['invalid_proposal_wire'] }] });
    expect(checkBoundKnowledgeResponse(JSON.stringify({ ...f.response, entities: [] }), f.source, f.catalog)).toMatchObject({ status: 'rejected' });
  });

  it('retains invalid bytes and enforces capacities before silently truncating any source or response', () => {
    const f = fixture(), bytes = Uint8Array.from([0xff]);
    const result = checkBoundKnowledgeResponse(bytes, f.source, f.catalog);
    expect(result).toMatchObject({ status: 'rejected', issues: ['invalid_utf8'], raw: { text: null, bytesBase64: '/w==' } });
    const unencodable = `{"unpaired":"${String.fromCharCode(0xd800)}"}`;
    expect(() => checkBoundKnowledgeResponse(unencodable, f.source, f.catalog)).toThrow('no byte identity computed');
    const escaped = '{"unpaired":"\\ud800"}';
    expect(checkBoundKnowledgeResponse(escaped, f.source, f.catalog)).toMatchObject({ status: 'rejected', issues: ['invalid_utf8'], raw: { text: escaped } });
    for (const target of ['source', 'catalog'] as const) {
      const invalid = fixture(); invalid[target].limitations.push(String.fromCharCode(0xd800));
      expect(() => buildBoundKnowledgeInput(invalid.source, invalid.catalog)).toThrow('not valid UTF-8');
    }
    expect(checkBoundKnowledgeResponse('x'.repeat(BOUND_KNOWLEDGE_OUTPUT_MAX_BYTES + 1), f.source, f.catalog))
      .toMatchObject({ status: 'rejected', issues: ['output_capacity'] });
    f.source.excerpts[0].text += '😀'.repeat(EXTRACTION_INPUT_MAX_BYTES);
    expect(() => buildBoundKnowledgeInput(f.source, f.catalog)).toThrow(ExtractionInputCapacityError);
  });

  it('pins independent identities while ordinary v4 wire and shared admission remain unchanged', () => {
    const f = fixture(), validate = new Ajv2020({ strict: true }).compile(BOUND_KNOWLEDGE_WIRE_SCHEMA);
    expect(validate(f.response)).toBe(true); expect(validate({ ...f.response, schemaVersion: 4 })).toBe(false);
    expect(JSON.parse(BOUND_KNOWLEDGE_WIRE_SCHEMA_JSON)).toEqual(BOUND_KNOWLEDGE_WIRE_SCHEMA);
    expect(Object.isFrozen(BOUND_KNOWLEDGE_WIRE_SCHEMA)).toBe(true);
    expect(BOUND_KNOWLEDGE_WIRE_IDENTITY).toMatchObject({ hostChecksVersion: BOUND_KNOWLEDGE_CHECK_VERSION,
      mappingPolicy: 'proposal-nonnullable-optional-null-to-absence/v1' });
    expect([BOUND_KNOWLEDGE_SYSTEM_VERSION, BOUND_KNOWLEDGE_INPUT_VERSION, BOUND_KNOWLEDGE_WIRE_VERSION, BOUND_KNOWLEDGE_CHECK_VERSION])
      .toEqual(['knowledge-bound-knowledge-system/v1', 'knowledge-bound-knowledge-input/v1', 'knowledge-bound-knowledge-wire/v1', 'knowledge-bound-knowledge-check/v1']);
    expect(BOUND_KNOWLEDGE_OUTPUT_NAME).toBe('bound_knowledge_v1');
    expect(BOUND_KNOWLEDGE_WIRE_ID).not.toBe(WINDOW_EXTRACTION_WIRE_ID);
    expect(WINDOW_EXTRACTION_WIRE_ID).toBe('sha256:63e1a6668343df71cc33584c1b5d5f6d6c318c7e3b4e03ec9bf4bb69d7b126fe');
    expect(checkWindowExtractionResponse(modelWindow(), [{ evidenceRef: 'record-1', text: 'Alpha 使用 Beta' }]).accepted).toHaveLength(1);
    expect({ system: hash(BOUND_KNOWLEDGE_SYSTEM), wire: BOUND_KNOWLEDGE_WIRE_ID,
      schema: hash(BOUND_KNOWLEDGE_WIRE_SCHEMA_JSON) }).toEqual({
      system: 'sha256:ab6bbc9676dda3a728af9c5f36f20598e3ebcd4320db198390e9f46760307cb3',
      wire: 'sha256:64c6215b1bfa791465f2280a533ed377fd30b312cd0490a191f9b49c988c0d2c',
      schema: 'sha256:bc853e0db9924c4d4e792045ccd5048a169cdefe4995bc56a2b7c26a7f835446',
    });
  });
});
