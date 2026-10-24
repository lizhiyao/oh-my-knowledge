import { describe, expect, it } from 'vitest';
import { buildMentionRebindingInput, checkMentionRebindingResponse, MENTION_REBINDING_SYSTEM,
  MENTION_REBINDING_SYSTEM_VERSION, MENTION_REBINDING_INPUT_VERSION, MENTION_REBINDING_WIRE_VERSION,
  MENTION_REBINDING_CHECK_VERSION } from '../../src/knowledge/extraction/mention-rebinding.js';
import { mentionRebindingExecution } from '../../src/knowledge/extraction/refined-entities-evidence.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import { ENTITY_MENTION_BOUNDARY_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import { refinedEntitiesFixture } from './refined-entities-fixtures.js';

type Fixture = ReturnType<typeof refinedEntitiesFixture>;
const check = (f: Fixture) => checkMentionRebindingResponse(JSON.stringify(f.rebindingResponse), f.source,
  f.readBase().predecessor, f.readRefinement().predecessor);
function rejected(f: Fixture, code: string) {
  const result = check(f); expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.issues.some(issue => issue.includes(code))).toBe(true);
}

describe('private mention rebinding B′ (authored only)', () => {
  it.each(['codex', 'openai-api'] as const)('composes %s only after complete old mention accounting and a source-supported addition', executor => {
    const f = refinedEntitiesFixture(executor), result = f.readRebinding();
    expect(result.checked).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', admission: { status: 'ready' } });
    if (result.checked.status !== 'checked' || result.checked.admission.status !== 'ready') throw new Error('Authored fixture not ready.');
    expect(result.checked.admission.analysis.mentions[0].selection).toEqual({ evidenceRef: 'record-1', quote: 'Alpha', start: 3, end: 8 });
    expect(f.rebindingResponse.mentionDispositions.map(row => [row.previousMentionId, row.dispositionKind, row.mentionIds]))
      .toEqual([['m0', 'retained', ['next-m0']], ['m1', 'retained', ['next-m1']], ['gap', 'corrected', ['next-gap']]]);
    expect(result.rawOutput).toBe(f.result('rebinding').output);
  });

  it('keeps original collection support and an explicitly unresolved identity as unreviewed authored assertions', () => {
    const f = refinedEntitiesFixture('codex', { collection: true, unresolved: true }), result = f.readRebinding();
    expect(result.checked).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', admission: { status: 'ready' } });
    expect(f.rebindingResponse.supportDispositions).toMatchObject([{ previousSupport: { entityId: 'g', supportKind: 'collection' },
      dispositionKind: 'retained', supports: [{ entityId: 'next-g', supportKind: 'collection' }] }]);
    expect(f.refinementResponse.entities.find(row => row.entityId === 'next-u')).toMatchObject({ identityStatus: 'unresolved', possibleEntityIds: ['next-e0', 'next-e1'] });
    const refinement = f.readRefinement(), input = JSON.parse(buildMentionRebindingInput(f.source, f.readBase().predecessor, refinement.predecessor));
    expect(Object.keys(input.predecessors)).toEqual(['sourcePlan', 'discovery', 'binding', 'refinement']);
    expect(input.predecessors.refinement.rawOutput).toBe(refinement.rawOutput);
    expect(Object.values(input.predecessors).every(row => !Object.hasOwn(row as object, 'receiptRaw'))).toBe(true);
    for (const stage of ['sourcePlan', 'discovery', 'binding'] as const) expect(input.predecessors[stage].rawOutput).toBe(f.readBase().predecessor[stage].rawOutput);
    expect(f.rebindingExecution.request.system.split(ENTITY_MENTION_BOUNDARY_POLICY)).toHaveLength(2);
    expect([MENTION_REBINDING_SYSTEM_VERSION, MENTION_REBINDING_INPUT_VERSION, MENTION_REBINDING_WIRE_VERSION, MENTION_REBINDING_CHECK_VERSION])
      .toEqual(['knowledge-mention-rebinding-system/v1', 'knowledge-mention-rebinding-input/v1', 'knowledge-mention-rebinding-wire/v1', 'knowledge-mention-rebinding-check/v1']);
  });

  it.each([
    ['missing old bound mention', (f: Fixture) => { f.rebindingResponse.mentionDispositions.shift(); }, 'missing_mention'],
    ['missing old unbound mention', (f: Fixture) => { f.rebindingResponse.mentionDispositions.pop(); }, 'missing_mention'],
    ['duplicate old mention', (f: Fixture) => { f.rebindingResponse.mentionDispositions.push(structuredClone(f.rebindingResponse.mentionDispositions[0])); }, 'duplicate_mention'],
    ['unknown old mention', (f: Fixture) => { f.rebindingResponse.mentionDispositions[0].previousMentionId = 'absent'; }, 'unknown_mention'],
    ['unknown new mention', (f: Fixture) => { f.rebindingResponse.mentionDispositions[0].mentionIds = ['absent']; }, 'unknown_target'],
    ['duplicate target', (f: Fixture) => { f.rebindingResponse.mentionDispositions[0].mentionIds.push('next-m0'); }, 'duplicate_target'],
    ['changed retained target', (f: Fixture) => { f.rebindingResponse.mentions[0].entityId = 'next-e1'; }, 'retained_mention_changed'],
    ['changed retained span', (f: Fixture) => { f.rebindingResponse.mentions[0].selection.quote = 'Alpha 使用 Beta'; }, 'retained_mention_changed'],
    ['changed retained rationale', (f: Fixture) => { f.rebindingResponse.mentions[0].rationale += ' changed'; }, 'retained_mention_changed'],
    ['another repeated occurrence', (f: Fixture) => {
      f.rebindingResponse.mentions[2].selection.occurrence = 1;
      f.rebindingResponse.mentionDispositions[2].selections = [{ evidenceRef: 'record-1', quote: 'Gamma 与 Gamma', occurrence: null }];
    }, 'corrected_position_disjoint'],
    ['evidence from another occurrence', (f: Fixture) => { f.rebindingResponse.mentionDispositions[2].selections[0].occurrence = 1; }, 'missing_previous_position_evidence'],
    ['retained merge', (f: Fixture) => { f.rebindingResponse.mentionDispositions[1].mentionIds = ['next-m0']; }, 'merge_requires_correction'],
  ])('rejects %s while retaining the original raw output', (_name, mutate, code) => {
    const f = refinedEntitiesFixture(), raw = f.result('rebinding').output;
    mutate(f); rejected(f, code); expect(f.result('rebinding').output).toBe(raw);
  });

  it('allows an explicit corrected boundary only at the overlapping original position', () => {
    const f = refinedEntitiesFixture('codex', { wideGap: true });
    expect(f.old.bindingResponse.mentions.at(-1)?.selection.quote).toBe('Gamma 与 Gamma');
    expect(f.rebindingResponse.mentions.at(-1)?.selection).toEqual({ evidenceRef: 'record-1', quote: 'Gamma', occurrence: 0 });
    expect(check(f)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', admission: { status: 'ready' } });
  });

  it.each([
    ['missing old support', (f: Fixture) => { f.rebindingResponse.supportDispositions = []; }, 'missing_support'],
    ['duplicate old support', (f: Fixture) => { f.rebindingResponse.supportDispositions.push(structuredClone(f.rebindingResponse.supportDispositions[0])); }, 'duplicate_support'],
    ['unknown old support', (f: Fixture) => { f.rebindingResponse.supportDispositions[0].previousSupport.entityId = 'absent'; }, 'unknown_support'],
    ['unknown support target', (f: Fixture) => { f.rebindingResponse.supportDispositions[0].supports[0].entityId = 'absent'; }, 'unknown_target'],
    ['excluded then silently rebuilt declaration', (f: Fixture) => { Object.assign(f.rebindingResponse.supportDispositions[0], { dispositionKind: 'excluded', supports: [] }); }, 'excluded_declaration_survives'],
  ])('rejects %s from the prior support account', (_name, mutate, code) => {
    const f = refinedEntitiesFixture('codex', { collection: true }); mutate(f); rejected(f, code);
  });

  it('requires corrected support accounting when the A′ owner was substantively corrected', () => {
    const f = refinedEntitiesFixture('codex', { collection: true });
    f.refinementResponse.entities.find(row => row.entityId === 'next-g')!.description += ' corrected';
    f.refinementResponse.entityDispositions.find(row => row.previousEntityId === 'g')!.dispositionKind = 'corrected';
    f.result('refinement').output = JSON.stringify(f.refinementResponse); f.resealRefinement();
    f.rebindingResponse.binding = JSON.parse(buildMentionRebindingInput(f.source, f.readBase().predecessor, f.readRefinement().predecessor)).binding;
    rejected(f, 'retained_support_changed');
    f.rebindingResponse.supportDispositions[0].dispositionKind = 'corrected';
    expect(check(f)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', admission: { status: 'ready' } });
  });

  it('does not move a corrected old support to an independently added collection owner', () => {
    const f = refinedEntitiesFixture('codex', { collection: true }), group = structuredClone(f.refinementResponse.entities.find(row => row.entityId === 'next-g')!);
    group.entityId = 'next-h'; group.label = '前两者'; group.description = 'Authored separately added collection.';
    group.collection!.anchorIds = ['next-ah']; f.refinementResponse.entities.push(group);
    f.refinementResponse.anchors.push({ anchorId: 'next-ah', entityId: 'next-h', selection: { evidenceRef: 'record-1', quote: '前两者', occurrence: null } });
    f.result('refinement').output = JSON.stringify(f.refinementResponse); f.resealRefinement();
    f.rebindingResponse.binding = JSON.parse(buildMentionRebindingInput(f.source, f.readBase().predecessor, f.readRefinement().predecessor)).binding;
    f.rebindingResponse.mentions.push({ mentionId: 'next-mh', selection: { evidenceRef: 'record-1', quote: '前两者', occurrence: null },
      basis: 'inference', rationale: 'Authored source reference to the added group.', bindingStatus: 'bound',
      entityId: 'next-h', candidateEntityIds: [], reason: null });
    f.rebindingResponse.identitySupports.push({ entityId: 'next-h', supportKind: 'collection', mentionIds: ['next-mh'] });
    expect(check(f)).toMatchObject({ status: 'checked', admission: { status: 'ready' } });
    Object.assign(f.rebindingResponse.supportDispositions[0], { dispositionKind: 'corrected', supports: [{ entityId: 'next-h', supportKind: 'collection' }] });
    rejected(f, 'target_owner_mapping_mismatch');
  });

  it.each(['undetermined-mention', 'undetermined-support', 'unbound', 'ambiguous'] as const)('keeps %s as a whole-analysis blocker', mode => {
    const f = refinedEntitiesFixture('codex', { collection: true });
    if (mode === 'undetermined-mention') Object.assign(f.rebindingResponse.mentionDispositions.at(-1)!, { dispositionKind: 'undetermined', mentionIds: [] });
    else if (mode === 'undetermined-support') Object.assign(f.rebindingResponse.supportDispositions[0], { dispositionKind: 'undetermined', supports: [] });
    else Object.assign(f.rebindingResponse.mentions.at(-1)!, { bindingStatus: mode, entityId: null,
      candidateEntityIds: mode === 'ambiguous' ? ['next-e0', 'next-e1'] : [], reason: 'Authored necessary uncertainty.' });
    const result = check(f);
    expect(result).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', admission: { status: 'blocked' } });
    if (result.status === 'checked') expect(result.admission).not.toHaveProperty('analysis');
  });

  it('rejects directory edits and an old task response instead of interpreting them as B′', () => {
    const f = refinedEntitiesFixture(), base = f.readBase().predecessor, refinement = f.readRefinement().predecessor;
    for (const extra of [{ entities: f.refinementResponse.entities }, { responseKind: 'mention-binding', schemaVersion: 2 }]) {
      expect(checkMentionRebindingResponse(JSON.stringify({ ...f.rebindingResponse, ...extra }), f.source, base, refinement).status).toBe('rejected');
    }
  });

  it('checks the actual flat B′ system/input at exactly 1 MiB before producer inspection', () => {
    const f = refinedEntitiesFixture(), raw = f.result('refinement').output!;
    const inputBytes = (input: string) => Buffer.byteLength(input, 'utf8') + Buffer.byteLength(MENTION_REBINDING_SYSTEM, 'utf8');
    let padding = EXTRACTION_INPUT_MAX_BYTES - inputBytes(f.rebindingExecution.request.input) - 64;
    const prepare = () => {
      f.result('refinement').output = raw + ' '.repeat(padding); f.resealRefinement(); return f.readRefinement();
    };
    let refinement = prepare(), execution = mentionRebindingExecution(f.source, f.model, refinement, f.refinedEntitiesArchive);
    padding += EXTRACTION_INPUT_MAX_BYTES - inputBytes(execution.request.input);
    refinement = prepare(); execution = mentionRebindingExecution(f.source, f.model, refinement, f.refinedEntitiesArchive);
    expect(inputBytes(execution.request.input)).toBe(EXTRACTION_INPUT_MAX_BYTES);
    padding++; refinement = prepare(); f.refinedInspect.mockClear();
    expect(() => mentionRebindingExecution(f.source, f.model, refinement, f.refinedEntitiesArchive)).toThrow(ExtractionInputCapacityError);
    expect(f.refinedInspect).not.toHaveBeenCalled();
  });
});
