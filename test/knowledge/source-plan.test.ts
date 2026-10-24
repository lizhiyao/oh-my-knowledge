import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { EvidenceWindow } from '../../src/knowledge/extraction/evidence.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import {
  buildKnowledgeSourcePlanInput, checkKnowledgeSourcePlan, type KnowledgeSourcePlan,
  SOURCE_PLAN_SYSTEM, SOURCE_PLAN_SYSTEM_VERSION, SOURCE_PLAN_INPUT_VERSION, SOURCE_PLAN_WIRE_VERSION, SOURCE_PLAN_OUTPUT_NAME,
  SOURCE_PLAN_OUTPUT_MAX_BYTES, SOURCE_PLAN_WIRE_SCHEMA_JSON, SOURCE_PLAN_WIRE_CANONICAL_JSON, SOURCE_PLAN_WIRE_ID,
} from '../../src/knowledge/extraction/source-plan.js';

const digest = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
// Authored data exercises the contract and wiring; it is not evidence of model quality.
function fixture() {
  const window: EvidenceWindow = {
    snapshotId: '11111111-1111-4111-8111-111111111111', sourceVersion: digest('authored source bytes'),
    sourceKind: 'codex', sourcePath: '/private/native.jsonl', projectionVersion: 'knowledge-window-v2',
    capturedAt: '2026-10-23T00:00:00Z', startRecord: 1, endRecord: 1,
    origin: { threadId: 'private-thread', title: 'private-title', cwd: '/private/project' },
    records: [{ recordIndex: 1, raw: 'private native envelope' }], limitations: ['  仅此选定窗口。\n'],
    excerpts: [{ evidenceRef: 'r1', recordIndex: 1, eventKind: 'message', role: 'assistant', timestamp: 'source time only',
      text: '😀 苔签 与 苔签 被分别命名；本轮共同核验的卡组，成员未记录。\n  必须保留回退，但尚未执行；来源称耗时约两秒。回退策略由核验流程单独审查；本次记录 R-7 已归档。' }],
  };
  const plan: KnowledgeSourcePlan = {
    responseKind: 'knowledge-source-plan', schemaVersion: 2, snapshotId: window.snapshotId, sourceVersion: window.sourceVersion,
    objects: [{ objectId: 'cards', meaning: '  本轮共同核验的卡组\n', planningRole: 'entity_candidate',
      qualificationBasis: '原文把这批对象作为独立共同范围核验。', referentKind: 'collection', identityStatus: 'proposed',
      identityBasis: '原文明确共同核验范围。', typeBasis: '有界卡组，不凭数量补成员。',
      anchors: [{ evidenceRef: 'r1', quote: '本轮共同核验的卡组', occurrence: null }],
      uncertainties: ['具体成员未记录。'], sharedScope: { memberObjectIds: [], completeness: 'unknown', rationale: '已知组，未知成员。' } },
    { objectId: 'named', meaning: '原文第一个苔签所指对象。', planningRole: 'qualification_unknown',
      qualificationBasis: '明确被命名，但是否得到独立讨论尚不足。', referentKind: 'unknown', identityStatus: 'proposed',
      identityBasis: '已知被分别命名的对象。', typeBasis: '没有层次依据。',
      anchors: [{ evidenceRef: 'r1', quote: '苔签', occurrence: 0 }], uncertainties: ['所指层次和提炼资格未知。'], sharedScope: null },
    { objectId: 'policy', meaning: '被单独审查的回退策略。', planningRole: 'entity_candidate',
      qualificationBasis: '原文独立讨论其审查和保留要求。', referentKind: 'object', identityStatus: 'proposed',
      identityBasis: '明确被审查的策略内容。', typeBasis: '没有具体实现的层次依据，保留为普通规则对象。',
      anchors: [{ evidenceRef: 'r1', quote: '回退策略', occurrence: null }], uncertainties: [], sharedScope: null },
    { objectId: 'record', meaning: '本次已归档的记录 R-7。', planningRole: 'context_only',
      qualificationBasis: '只给出本次完成背景，没有独立概念或可复用对象讨论。', referentKind: 'object', identityStatus: 'proposed',
      identityBasis: '原文以本次记录明确指代。', typeBasis: '单一记录提供事件上下文。',
      anchors: [{ evidenceRef: 'r1', quote: '本次记录 R-7', occurrence: null }], uncertainties: [], sharedScope: null }],
    materials: [{ materialId: 'retain-fallback', retentionIntent: 'reusable_candidate',
      reuseBasis: '保留要求是有适用范围的规范，不是完成声明。', participantObjectIds: ['cards', 'policy'], contextObjectIds: ['record'],
      meaning: '保留回退是规范要求，不表示已执行。',
      conditions: ['仅此轮来源讨论。'], limits: ['不能把来源自述提升为独立执行证明。'],
      unknowns: ['事实发生时间和适用时间分别未知。'],
      anchors: [{ evidenceRef: 'r1', quote: '必须保留回退，但尚未执行', occurrence: null }] },
    { materialId: 'archive-note', retentionIntent: 'context_only', reuseBasis: '只报告本次归档状态，不给出可复用判据。',
      participantObjectIds: [], contextObjectIds: ['record'], meaning: '来源报告本次记录已经归档。',
      conditions: [], limits: ['仅本次完成背景。'], unknowns: ['没有独立归档证据。'],
      anchors: [{ evidenceRef: 'r1', quote: '本次记录 R-7 已归档', occurrence: null }] }],
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
      expect(result.plan.objects[1]).toMatchObject({ identityStatus: 'proposed', referentKind: 'unknown', planningRole: 'qualification_unknown' });
      expect(result.plan.objects[3].planningRole).toBe('context_only');
      expect(result.plan.materials[0]).toMatchObject({ retentionIntent: 'reusable_candidate', participantObjectIds: ['cards', 'policy'], contextObjectIds: ['record'] });
      expect(result.plan.materials[1]).toMatchObject({ retentionIntent: 'context_only', participantObjectIds: [], contextObjectIds: ['record'] });
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
    f.plan.objects[2].planningRole = 'context_only'; f.plan.materials[0].retentionIntent = 'context_only';
    f.plan.materials[1].retentionIntent = 'undetermined';
    f.plan.materials[1].contextObjectIds = []; // No forced carrier when both reference groups are empty.
    const result = checkKnowledgeSourcePlan(JSON.stringify(f.plan), f.window);
    expect(result).toMatchObject({ status: 'validated', semanticStatus: 'not_reviewed' });
    if (result.status === 'validated') expect(result.plan).toEqual(f.plan); // No role-based filtering or semantic repair.
    expect(result).not.toHaveProperty('goldReady'); expect(result).not.toHaveProperty('formalReceipt');
  });

  it('counts overlapping occurrences in UTF16 and permits shared evidence across different plan items', () => {
    const f = fixture(); f.window.excerpts[0].text = '😀 aaaa';
    f.plan.objects = [{ ...f.plan.objects[1], anchors: [{ evidenceRef: 'r1', quote: 'aa', occurrence: 2 }] }];
    f.plan.materials = [{ ...f.plan.materials[0], participantObjectIds: ['named'], contextObjectIds: [],
      anchors: structuredClone(f.plan.objects[0].anchors) }];
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
    { label: 'dangling participant', code: 'unknown_object_reference', change: p => { p.materials[0].participantObjectIds = ['missing']; } },
    { label: 'duplicate participant', code: 'duplicate_reference', change: p => { p.materials[0].participantObjectIds = ['cards', 'cards']; } },
    { label: 'dangling context', code: 'unknown_object_reference', change: p => { p.materials[0].contextObjectIds = ['missing']; } },
    { label: 'duplicate context', code: 'duplicate_reference', change: p => { p.materials[0].contextObjectIds = ['record', 'record']; } },
    { label: 'unknown qualification with no reason', code: 'unknown_requires_reason', change: p => {
      p.objects[2].planningRole = 'qualification_unknown'; p.objects[2].uncertainties = [];
    } },
    { label: 'undetermined reuse with no reason', code: 'unknown_requires_reason', change: p => {
      p.materials[0].retentionIntent = 'undetermined'; p.materials[0].unknowns = [];
    } },
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
    const legacy = { ...structuredClone(f.plan), schemaVersion: 1 } as unknown as KnowledgeSourcePlan;
    expect(validate(legacy)).toBe(false);
    expect(rejectedCodes(legacy, f.window)).toContain('invalid_structure');
    const oldReferences = structuredClone(f.plan) as unknown as { materials: Record<string, unknown>[] };
    oldReferences.materials[0].objectIds = ['cards'];
    delete oldReferences.materials[0].participantObjectIds; delete oldReferences.materials[0].contextObjectIds;
    expect(validate(oldReferences)).toBe(false);
    expect(rejectedCodes(oldReferences as unknown as KnowledgeSourcePlan, f.window)).toContain('invalid_structure');
    const badGrounds = structuredClone(f.plan);
    badGrounds.objects[0].qualificationBasis = ' '; badGrounds.materials[0].reuseBasis = ' ';
    const groundsResult = checkKnowledgeSourcePlan(JSON.stringify(badGrounds), f.window);
    expect(groundsResult.status).toBe('rejected');
    if (groundsResult.status === 'rejected') expect(groundsResult.issues.map(issue => issue.path.join('.')))
      .toEqual(expect.arrayContaining(['objects.0.qualificationBasis', 'materials.0.reuseBasis']));
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
    expect(SOURCE_PLAN_SYSTEM_VERSION).toBe('knowledge-source-plan-system/v3');
    expect(SOURCE_PLAN_INPUT_VERSION).toBe('knowledge-source-plan-input/v2');
    expect(SOURCE_PLAN_OUTPUT_NAME).toBe('knowledge_source_plan_v2');
    expect(SOURCE_PLAN_WIRE_VERSION).toBe('knowledge-source-plan-wire/v2');
    expect(JSON.stringify(SOURCE_PLAN_WIRE_SCHEMA_JSON)).toBe(SOURCE_PLAN_WIRE_CANONICAL_JSON);
    expect({ system: digest(SOURCE_PLAN_SYSTEM), input: digest(buildKnowledgeSourcePlanInput(fixture().window)), wire: SOURCE_PLAN_WIRE_ID })
      .toEqual({ system: 'sha256:619fd9ef315e83a7650614123c8164ab60bb83d293ec52082d8174cc713f464a',
        input: 'sha256:741694557106a0ecb477a9e4ba9a23e2ebe74df14dd6289f07c3a5935bd490bd',
        wire: 'sha256:54a52f15ecfe2700e0f1a27ac570e06e6a4d0198eb1884337bfff7ad496095f5' });
  });
});
