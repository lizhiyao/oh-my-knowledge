import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import {
  buildKnowledgeSourcePlanInput, checkKnowledgeSourcePlan, type KnowledgeSourcePlan,
  SOURCE_PLAN_SYSTEM, SOURCE_PLAN_SYSTEM_VERSION, SOURCE_PLAN_INPUT_VERSION, SOURCE_PLAN_OUTPUT_NAME,
  SOURCE_PLAN_OUTPUT_MAX_BYTES, SOURCE_PLAN_WIRE_SCHEMA_JSON, SOURCE_PLAN_WIRE_CANONICAL_JSON, SOURCE_PLAN_WIRE_ID,
} from '../../src/knowledge/extraction/source-plan.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
function fixture() {
  const window: EvidenceWindow = {
    snapshotId: '11111111-1111-4111-8111-111111111111', sourceVersion: digest('authored source bytes'),
    sourceKind: 'codex', sourcePath: '/private/native.jsonl', projectionVersion: 'knowledge-window-v2',
    capturedAt: '2026-10-23T00:00:00Z', startRecord: 1, endRecord: 1,
    origin: { threadId: 'private-thread', title: 'private-title', cwd: '/private/project' },
    records: [{ recordIndex: 1, raw: 'private native envelope' }], limitations: ['  仅此选定窗口。\n'],
    excerpts: [{ evidenceRef: 'r1', recordIndex: 1, eventKind: 'message', role: 'assistant', timestamp: 'source time only',
      text: '😀 苔签 与 苔签 被分别命名；本轮共同核验的卡组，成员未记录。\n  必须保留回退，但尚未执行；来源称耗时约两秒。' }],
  };
  const plan: KnowledgeSourcePlan = {
    responseKind: 'knowledge-source-plan', schemaVersion: 1, snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
    objects: [{ objectId: 'cards', meaning: '  本轮共同核验的卡组\n', referentKind: 'collection', identityStatus: 'proposed',
      identityBasis: '原文明确共同核验范围。', typeBasis: '有界卡组，不凭数量补成员。',
      anchors: [{ evidenceRef: 'r1', quote: '本轮共同核验的卡组', occurrence: null }],
      uncertainties: ['具体成员未记录。'], sharedScope: { memberObjectIds: [], completeness: 'unknown', rationale: '已知组，未知成员。' } },
    { objectId: 'named', meaning: '原文第一个苔签所指对象。', referentKind: 'unknown', identityStatus: 'proposed',
      identityBasis: '已知被分别命名的对象。', typeBasis: '没有层次依据。',
      anchors: [{ evidenceRef: 'r1', quote: '苔签', occurrence: 0 }], uncertainties: ['所指层次未知。'], sharedScope: null }],
    materials: [{ materialId: 'retain-fallback', objectIds: ['cards'], meaning: '保留回退是规范要求，不表示已执行。',
      conditions: ['仅此轮来源讨论。'], limits: ['不能把来源自述提升为独立执行证明。'],
      unknowns: ['事实发生时间和适用时间分别未知。'],
      anchors: [{ evidenceRef: 'r1', quote: '必须保留回退，但尚未执行', occurrence: null }] }],
  };
  return { window, plan };
}
function rejectedCodes(plan: KnowledgeSourcePlan, window: EvidenceWindow) {
  const result = checkKnowledgeSourcePlan(JSON.stringify(plan), window);
  expect(result.status).toBe('rejected');
  return result.status === 'rejected' ? result.issues.map(value => value.code) : [];
}

describe('source-only semantic planning', () => {
  it('sends only the exact source projection and preserves complete raw planning evidence', () => {
    const f = fixture(), before = structuredClone(f), input = buildKnowledgeSourcePlanInput(f.window);
    const body = JSON.parse(input);
    expect(body).toEqual({ taskKind: 'source_plan', taskVersion: SOURCE_PLAN_INPUT_VERSION,
      snapshotId: f.window.snapshotId, sourceVersion: f.window.sourceVersion,
      excerpts: f.window.excerpts, limitations: f.window.limitations });
    expect(input).not.toContain('/private/'); expect(input).not.toContain('private native envelope');
    expect(input).not.toContain('previousResponse'); expect(SOURCE_PLAN_SYSTEM).not.toContain('苔签');
    const rawOutput = ` \n${JSON.stringify(f.plan)}\r\n\t`, result = checkKnowledgeSourcePlan(rawOutput, f.window);
    expect(result.status).toBe('validated'); expect(result.rawOutput).toBe(rawOutput);
    expect(result.semanticStatus).toBe('not_reviewed');
    if (result.status === 'validated') {
      expect(result.plan).toEqual(f.plan);
      expect(result.plan.objects[0].sharedScope).toEqual({ memberObjectIds: [], completeness: 'unknown', rationale: '已知组，未知成员。' });
      expect(result.plan.objects[1]).toMatchObject({ identityStatus: 'proposed', referentKind: 'unknown' });
      expect(result.groundedAnchors.find(value => value.path.join('.') === 'objects.1.anchors.0')?.selection)
        .toEqual({ evidenceRef: 'r1', quote: '苔签', start: 3, end: 5 });
    }
    expect(f).toEqual(before);
  });

  it('keeps empty plans and structurally valid semantic mistakes unreviewed, rather than proving model behavior', () => {
    const f = fixture();
    expect(checkKnowledgeSourcePlan(JSON.stringify({ ...f.plan, objects: [], materials: [] }), f.window))
      .toMatchObject({ status: 'validated', semanticStatus: 'not_reviewed' });
    // Authored counterexample: exact grounding does not decide whether the source group was mislabeled.
    f.plan.objects[0].referentKind = 'object'; f.plan.objects[0].sharedScope = null;
    const result = checkKnowledgeSourcePlan(JSON.stringify(f.plan), f.window);
    expect(result).toMatchObject({ status: 'validated', semanticStatus: 'not_reviewed' });
    expect(result).not.toHaveProperty('goldReady'); expect(result).not.toHaveProperty('formalReceipt');
  });

  it('counts overlapping occurrences in UTF16 and permits shared evidence across different plan items', () => {
    const f = fixture(); f.window.excerpts[0].text = '😀 aaaa';
    f.plan.objects = [{ ...f.plan.objects[1], anchors: [{ evidenceRef: 'r1', quote: 'aa', occurrence: 2 }] }];
    f.plan.materials[0].objectIds = ['named']; f.plan.materials[0].anchors = structuredClone(f.plan.objects[0].anchors);
    const result = checkKnowledgeSourcePlan(JSON.stringify(f.plan), f.window);
    expect(result.status).toBe('validated');
    if (result.status === 'validated') expect(result.groundedAnchors.map(value => value.selection))
      .toEqual([{ evidenceRef: 'r1', quote: 'aa', start: 5, end: 7 }, { evidenceRef: 'r1', quote: 'aa', start: 5, end: 7 }]);
  });

  const badPlans: { label: string; code: string; change: (plan: KnowledgeSourcePlan) => void }[] = [
    { label: 'missing quote', code: 'quote_mismatch', change: p => { p.objects[0].anchors[0].quote = '原文没有这句话'; } },
    { label: 'unknown excerpt', code: 'unknown_evidence', change: p => { p.materials[0].anchors[0].evidenceRef = 'missing'; } },
    { label: 'ambiguous occurrence', code: 'ambiguous_quote', change: p => { p.objects[1].anchors[0].occurrence = null; } },
    { label: 'out of range occurrence', code: 'quote_occurrence_out_of_range', change: p => { p.objects[1].anchors[0].occurrence = 2; } },
    { label: 'negative occurrence', code: 'invalid_structure', change: p => { p.objects[1].anchors[0].occurrence = -1; } },
    { label: 'duplicate anchor', code: 'duplicate_anchor', change: p => { p.objects[0].anchors.push(structuredClone(p.objects[0].anchors[0])); } },
    { label: 'duplicate object', code: 'duplicate_object_id', change: p => { p.objects[1].objectId = 'cards'; } },
    { label: 'duplicate material', code: 'duplicate_material_id', change: p => { p.materials.push(structuredClone(p.materials[0])); } },
    { label: 'dangling material object', code: 'unknown_object_reference', change: p => { p.materials[0].objectIds = ['missing']; } },
    { label: 'duplicate object reference', code: 'duplicate_reference', change: p => { p.materials[0].objectIds = ['cards', 'cards']; } },
    { label: 'unknown with no reason', code: 'unknown_requires_reason', change: p => { p.objects[1].uncertainties = []; } },
    { label: 'collection without shared scope', code: 'shared_scope_shape', change: p => { p.objects[0].sharedScope = null; } },
    { label: 'noncollection with shared scope', code: 'shared_scope_shape', change: p => { p.objects[0].referentKind = 'object'; } },
    { label: 'unknown members asserted', code: 'unknown_members_not_empty', change: p => { p.objects[0].sharedScope!.memberObjectIds = ['named']; } },
    { label: 'partial members empty', code: 'partial_members_empty', change: p => { p.objects[0].sharedScope!.completeness = 'partial'; } },
    { label: 'member gap without reason', code: 'member_gap_requires_reason', change: p => { p.objects[0].uncertainties = []; } },
    { label: 'dangling member', code: 'unknown_member_reference', change: p => {
      p.objects[0].sharedScope = { memberObjectIds: ['missing'], completeness: 'partial', rationale: '仅有部分成员。' };
    } },
    { label: 'direct membership cycle', code: 'cyclic_member_reference', change: p => {
      p.objects[0].sharedScope = { memberObjectIds: ['cards'], completeness: 'complete', rationale: '错误的自包含。' };
    } },
    { label: 'snapshot mismatch', code: 'snapshot_mismatch', change: p => { p.snapshotId = '22222222-2222-4222-8222-222222222222'; } },
    { label: 'source version mismatch', code: 'source_version_mismatch', change: p => { p.sourceVersion = digest('different source'); } },
  ];
  it.each(badPlans)('rejects $label as a whole without selecting or repairing siblings', ({ change, code }) => {
    const f = fixture(); change(f.plan); const before = structuredClone(f), rawOutput = JSON.stringify(f.plan);
    expect(rejectedCodes(f.plan, f.window)).toContain(code);
    const result = checkKnowledgeSourcePlan(rawOutput, f.window);
    expect(result.rawOutput).toBe(rawOutput); expect(result.semanticStatus).toBe('not_reviewed');
    expect(result).not.toHaveProperty('plan'); expect(result).not.toHaveProperty('groundedAnchors'); expect(f).toEqual(before);
  });

  it('retains a valid partial membership and rejects an indirect cycle without inferring missing members', () => {
    const f = fixture();
    f.window.excerpts[0].text += '卡组明确包含第一处苔签，其余成员未知。';
    f.plan.objects[0].anchors.push({ evidenceRef: 'r1', quote: '卡组明确包含第一处苔签', occurrence: null });
    f.plan.objects[0].sharedScope = { memberObjectIds: ['named'], completeness: 'partial', rationale: '仅陈列有据部分。' };
    expect(checkKnowledgeSourcePlan(JSON.stringify(f.plan), f.window).status).toBe('validated');
    f.plan.objects[1] = { ...f.plan.objects[1], referentKind: 'collection', sharedScope: {
      memberObjectIds: ['cards'], completeness: 'complete', rationale: '形成间接循环。',
    } };
    expect(rejectedCodes(f.plan, f.window)).toContain('cyclic_member_reference');
  });

  it('uses one strict schema for the private wire and stronger host checks without accepting final E/M/P fields', () => {
    const f = fixture(), validate = new Ajv2020({ strict: true }).compile(SOURCE_PLAN_WIRE_SCHEMA_JSON);
    expect(validate(f.plan)).toBe(true);
    expect(validate({ ...f.plan, entities: [] })).toBe(false);
    expect(rejectedCodes({ ...f.plan, entities: [] } as KnowledgeSourcePlan, f.window)).toContain('invalid_structure');
    const noOccurrence = structuredClone(f.plan) as unknown as { objects: { anchors: Record<string, unknown>[] }[] };
    delete noOccurrence.objects[0].anchors[0].occurrence;
    expect(validate(noOccurrence)).toBe(false);
    f.plan.objects[1].anchors[0].occurrence = -1;
    expect(validate(f.plan)).toBe(true); // Bounds are enforced by the original host schema.
    expect(rejectedCodes(f.plan, f.window)).toContain('invalid_structure');
    expect(Object.isFrozen(SOURCE_PLAN_WIRE_SCHEMA_JSON)).toBe(true);
    expect(Object.isFrozen(SOURCE_PLAN_WIRE_SCHEMA_JSON.properties)).toBe(true);
  });

  it.each(['text', 'limitation', 'role'] as const)('rejects non-roundtripping source UTF8 in %s and duplicate source references', field => {
    const f = fixture();
    if (field === 'text') f.window.excerpts[0].text = '\ud800';
    if (field === 'limitation') f.window.limitations = ['\ud800'];
    if (field === 'role') f.window.excerpts[0].role = '\ud800';
    expect(() => buildKnowledgeSourcePlanInput(f.window)).toThrow('UTF-8');
    f.window = fixture().window; f.window.excerpts.push(structuredClone(f.window.excerpts[0]));
    expect(() => buildKnowledgeSourcePlanInput(f.window)).toThrow('duplicate evidence');
  });

  it('rejects invalid decoded text, malformed JSON and deeply nested nonplans while retaining original bytes', () => {
    const f = fixture(); f.plan.materials[0].meaning = '\ud800';
    for (const [rawOutput, code] of [
      [JSON.stringify(f.plan), 'invalid_utf8'], ['\ud800', 'invalid_utf8'], [' {broken JSON ', 'invalid_json'],
      ['['.repeat(10_000) + '0' + ']'.repeat(10_000), 'invalid_structure'],
    ]) {
      const result = checkKnowledgeSourcePlan(rawOutput, f.window);
      expect(result).toMatchObject({ status: 'rejected', rawOutput, issues: expect.arrayContaining([expect.objectContaining({ code })]) });
    }
  });

  it('enforces exact combined input and full output byte capacities without truncation', () => {
    const f = fixture(); f.window.limitations = ['a'];
    const base = buildKnowledgeSourcePlanInput(f.window);
    const available = EXTRACTION_INPUT_MAX_BYTES - Buffer.byteLength(SOURCE_PLAN_SYSTEM, 'utf8') - Buffer.byteLength(base, 'utf8');
    f.window.limitations[0] = 'a'.repeat(available + 1);
    const input = buildKnowledgeSourcePlanInput(f.window);
    expect(Buffer.byteLength(input, 'utf8') + Buffer.byteLength(SOURCE_PLAN_SYSTEM, 'utf8')).toBe(EXTRACTION_INPUT_MAX_BYTES);
    expect(JSON.parse(input).limitations).toEqual(f.window.limitations);
    f.window.limitations[0] += 'a';
    expect(() => buildKnowledgeSourcePlanInput(f.window)).toThrow(ExtractionInputCapacityError);
    const raw = JSON.stringify(f.plan), boundary = ' '.repeat(SOURCE_PLAN_OUTPUT_MAX_BYTES - Buffer.byteLength(raw, 'utf8')) + raw;
    expect(checkKnowledgeSourcePlan(boundary, f.window)).toMatchObject({ status: 'validated', rawOutput: boundary });
    expect(checkKnowledgeSourcePlan(`${boundary} `, f.window)).toMatchObject({ status: 'rejected', rawOutput: `${boundary} `,
      issues: [{ code: 'output_capacity', path: [], message: 'output_capacity' }] });
  });

  it('pins independent system, source input and wire identities without claiming semantic improvement', () => {
    expect(SOURCE_PLAN_SYSTEM_VERSION).toBe('knowledge-source-plan-system/v1');
    expect(SOURCE_PLAN_INPUT_VERSION).toBe('knowledge-source-plan-input/v1');
    expect(SOURCE_PLAN_OUTPUT_NAME).toBe('knowledge_source_plan_v1');
    expect(JSON.stringify(SOURCE_PLAN_WIRE_SCHEMA_JSON)).toBe(SOURCE_PLAN_WIRE_CANONICAL_JSON);
    expect({ system: digest(SOURCE_PLAN_SYSTEM), input: digest(buildKnowledgeSourcePlanInput(fixture().window)), wire: SOURCE_PLAN_WIRE_ID })
      .toEqual({ system: 'sha256:60a2b7b1728470056231787e688d95f6de1bbfd027e7895563b44d5552d26205',
        input: 'sha256:291cbbeaa39843e6a5f9a1d59ef78fd7641f7bc2c4d4993da469dd27fd809701',
        wire: 'sha256:9e1515a5c3f35d07ec6187c68e6c696322f7d97acc16978c540a571a34c7b760' });
  });
});
