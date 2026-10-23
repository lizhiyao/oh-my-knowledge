import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { admitEntities } from '../../src/knowledge/extraction/entities.js';
import { buildEntityReviewInput } from '../../src/knowledge/extraction/entity-review.js';
import { buildReviewedKnowledgeInput, checkReviewedKnowledgeResponse, REVIEWED_KNOWLEDGE_WIRE_SCHEMA,
  REVIEWED_KNOWLEDGE_SYSTEM, REVIEWED_KNOWLEDGE_WIRE_SCHEMA_JSON, REVIEWED_KNOWLEDGE_WIRE_ID, type EntityReviewProjection } from '../../src/knowledge/extraction/reviewed-knowledge.js';
import type { BoundKnowledgeCatalog, BoundKnowledgeSource } from '../../src/knowledge/extraction/bound-catalog.js';
import { modelWindow, wireModelWindow } from './fixtures.js';

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const uid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function fixture(status: 'supported' | 'unsupported' | 'undetermined' = 'supported') {
  const ids: Record<string, string> = { project: uid(1), tool: uid(2), m1: uid(3), m2: uid(4) };
  const packet = JSON.parse(JSON.stringify(modelWindow(), (_key, value) => typeof value === 'string' ? ids[value] ?? value : value)) as ReturnType<typeof modelWindow>;
  const source: BoundKnowledgeSource = { snapshotId: uid(5), sourceVersion: hash('authored source'), limitations: ['Authored source only.'],
    excerpts: [{ evidenceRef: 'record-1', recordIndex: 0, eventKind: 'message', role: 'assistant', text: '😀 Alpha 使用 Beta' }] };
  const analysis = admitEntities(packet.entities, packet.mentions, source.excerpts);
  const catalog: BoundKnowledgeCatalog = { analysisId: uid(6), revisionId: uid(7), snapshotId: source.snapshotId,
    sourceVersion: source.sourceVersion, entities: analysis.entities, mentions: analysis.mentions, limitations: [] };
  const reviewResponse = { responseKind: 'entity-review', schemaVersion: 1, binding: JSON.parse(buildEntityReviewInput(source, catalog)).binding,
    decisions: catalog.entities.map((entity, index) => ({ entityId: entity.entityId,
      qualification: { status: index ? status : 'supported', reason: 'Authored qualification judgment, not verified truth.' },
      referent: { status: 'supported', reason: 'Authored referent judgment.' }, type: { status: 'supported', reason: 'Authored type judgment.' },
      mentionIds: catalog.mentions.filter(mention => mention.entityId === entity.entityId).map(mention => mention.mentionId), evidenceRefs: ['record-1'] })) };
  const review: EntityReviewProjection = { receiptId: uid(8), receiptRef: { bytes: 20, digest: hash('authored receipt bytes') },
    nativeRef: { bytes: 30, digest: hash('authored native bytes') }, rawOutput: JSON.stringify(reviewResponse) };
  const response = { responseKind: 'reviewed-knowledge', schemaVersion: 1,
    binding: JSON.parse(buildReviewedKnowledgeInput(source, catalog, review)).binding,
    proposals: wireModelWindow(packet).proposals, catalogGaps: [],
    materialAccounting: [{ materialId: 'm1', meaning: 'Authored use claim.', anchors: [{ evidenceRef: 'record-1', quote: 'Alpha 使用 Beta', occurrence: null }],
      dispositionKind: 'expressed', statementRefs: [{ proposalId: 'candidate-1', statementId: 'usage' }], reason: null, catalogGapIds: [] }],
    excerptAccounting: [{ evidenceRef: 'record-1', materialIds: ['m1'], noMaterialReason: null }] };
  return { source, catalog, review, reviewResponse, response };
}

describe('knowledge constrained by an independently archived entity review', () => {
  it('retains the full real revision and original UTF-16 mentions while enforcing a separate ID usage policy', () => {
    const f = fixture('undetermined'), before = structuredClone(f);
    const input = JSON.parse(buildReviewedKnowledgeInput(f.source, f.catalog, f.review));
    expect(input.entityAnalysis).toEqual(f.catalog); expect(input.entityAnalysis.entities).toHaveLength(2);
    expect(input.usage.eligibleEntityIds).toEqual([uid(1)]); expect(input.usage.eligibleMentionIds).toEqual([uid(3)]);
    expect(input.entityAnalysis.mentions[0].selection.start).toBe(3);
    expect(input.entityReview).toEqual(f.reviewResponse); expect(input.binding.entityReview.receiptRef).toEqual(f.review.receiptRef);
    expect(input.binding.entityReview.rawOutputDigest).toBe(hash(f.review.rawOutput));
    expect(REVIEWED_KNOWLEDGE_SYSTEM).toContain('responseKind=reviewed-knowledge、schemaVersion=1');
    expect(REVIEWED_KNOWLEDGE_SYSTEM).not.toContain('responseKind=bound-knowledge、schemaVersion=2');
    expect(f).toEqual(before);
  });

  it('uses the strict independent wire and retains native raw whitespace after reusing proposal admission', () => {
    const f = fixture(), raw = ` \n${JSON.stringify(f.response)}\r\n`;
    const validate = new Ajv2020({ strict: true }).compile(REVIEWED_KNOWLEDGE_WIRE_SCHEMA);
    expect(validate(f.response)).toBe(true);
    expect(hash(REVIEWED_KNOWLEDGE_SYSTEM)).toBe('sha256:6a87c1826b29ac39cb8a53b97de31a7f029076fcd2c6592f4d23f87bbe9d4d99');
    expect(hash(REVIEWED_KNOWLEDGE_WIRE_SCHEMA_JSON)).toBe('sha256:9ed5ee868838a1ef4e4b590d398d1fa1a3f9c7867ac08a9c1095d8b21fd381f3');
    expect(REVIEWED_KNOWLEDGE_WIRE_ID).toBe('sha256:8dd43ef6746b36cca4b4d401967f979d895c68030d19dd5b42267692f7326b71');
    const result = checkReviewedKnowledgeResponse(raw, f.source, f.catalog, f.review);
    expect(result).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', binding: f.response.binding, rejected: [] });
    expect(result.raw.text).toBe(raw); expect(result.raw.digest).toBe(hash(raw));
    if (result.status !== 'checked') throw new Error('Unexpected rejection');
    expect(result.accepted).toHaveLength(1); expect(result.accepted[0].mentions).toEqual(f.catalog.mentions);
    expect(result).not.toHaveProperty('goldReady'); expect(result).not.toHaveProperty('independentHuman');
    expect(validate({ ...f.response, entities: [] })).toBe(false);
  });

  it.each(['unsupported', 'undetermined'] as const)('rejects actual references to an %s entity without repairing endpoints or swallowing an independent valid proposal', status => {
    const f = fixture(status), sibling = structuredClone(f.response.proposals[0]);
    sibling.proposalId = 'alpha-only'; sibling.entityIds = [uid(1)]; sibling.mentionIds = [uid(3)];
    const statement = sibling.draft.content.statements[0]; statement.object = null; statement.relation = '在来源中被提及';
    f.response.proposals.push(sibling);
    const result = checkReviewedKnowledgeResponse(JSON.stringify(f.response), f.source, f.catalog, f.review);
    if (result.status !== 'checked') throw new Error('Unexpected envelope rejection');
    expect(result.rejected).toEqual([{ index: 0, reasons: ['entity_review:ineligible_entity', 'entity_review:ineligible_mention'] }]);
    expect(result.accepted.map(value => value.proposalId)).toEqual(['alpha-only']);
    expect(result.accepted[0].draft.entities.map(entity => entity.entityId)).toEqual([uid(1)]);
    expect(result.raw.text).toContain(uid(2)); expect(f.catalog.entities).toHaveLength(2);
    expect(result.accounting.status).toBe('has_issues'); // Claims still refer to the actually rejected P; never rewritten.
  });

  it.each(['receipt', 'native', 'raw'] as const)('binds %s review evidence into the actual new K response', change => {
    const f = fixture(), other = structuredClone(f.review);
    if (change === 'receipt') other.receiptRef.digest = hash('different receipt');
    if (change === 'native') other.nativeRef.digest = hash('different native');
    if (change === 'raw') other.rawOutput += '\n';
    expect(checkReviewedKnowledgeResponse(JSON.stringify(f.response), f.source, f.catalog, other)).toMatchObject({ status: 'rejected', issues: ['binding_mismatch'] });
  });

  it('cannot fall back to an omitted, incomplete or old bound-K task when review binding fails', () => {
    const f = fixture(); f.reviewResponse.decisions.pop(); f.review.rawOutput = JSON.stringify(f.reviewResponse);
    expect(() => buildReviewedKnowledgeInput(f.source, f.catalog, f.review)).toThrow('complete and structurally bound');
    const valid = fixture();
    expect(checkReviewedKnowledgeResponse(JSON.stringify({ ...valid.response, responseKind: 'bound-knowledge', schemaVersion: 2 }),
      valid.source, valid.catalog, valid.review)).toMatchObject({ status: 'rejected' });
    expect(() => buildReviewedKnowledgeInput(valid.source, valid.catalog, undefined as never)).toThrow();
  });
});
