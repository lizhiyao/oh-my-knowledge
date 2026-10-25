import { describe, expect, it } from 'vitest';
import { buildEntityRefinementInput, checkEntityRefinementResponse, ENTITY_REFINEMENT_SYSTEM,
  ENTITY_REFINEMENT_SYSTEM_VERSION, ENTITY_REFINEMENT_INPUT_VERSION, ENTITY_REFINEMENT_WIRE_VERSION,
  ENTITY_REFINEMENT_CHECK_VERSION } from '../../src/knowledge/extraction/entity-refinement.js';
import { entityRefinementExecution, mentionRebindingExecution } from '../../src/knowledge/extraction/refined-entities-evidence.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import { ENTITY_CODE_REFERENT_POLICY, ENTITY_COLLECTIVE_REFERENCE_POLICY, ENTITY_REFERENT_KIND_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import { SOURCE_PLAN_SYSTEM } from '../../src/knowledge/extraction/source-plan.js';
import { ENTITY_DISCOVERY_SYSTEM } from '../../src/knowledge/extraction/entity-discovery.js';
import { MENTION_BINDING_SYSTEM } from '../../src/knowledge/extraction/mention-binding.js';
import { refinedEntitiesFixture } from './refined-entities-fixtures.js';

type Fixture = ReturnType<typeof refinedEntitiesFixture>;
const check = (f: Fixture) => checkEntityRefinementResponse(JSON.stringify(f.refinementResponse), f.source, f.readBase().predecessor);
function rejected(f: Fixture, code: string) {
  const result = check(f); expect(result.status).toBe('rejected');
  if (result.status === 'rejected') expect(result.issues.some(issue => issue.includes(code))).toBe(true);
}

describe('private entity refinement A′ (authored only)', () => {
  it.each(['codex', 'openai-api'] as const)('authenticates %s base originals and accounts for old entities while adding Gamma', executor => {
    const f = refinedEntitiesFixture(executor), base = f.readBase(), refined = f.readRefinement();
    expect(base.binding.checked).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed', admission: { status: 'blocked' } });
    expect(refined.checked).toMatchObject({ status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed', response: f.refinementResponse });
    expect(refined.checked.response.entityDispositions.map(row => [row.previousEntityId, row.dispositionKind, row.entityIds]))
      .toEqual([['e0', 'retained', ['next-e0']], ['e1', 'retained', ['next-e1']]]);
    expect(refined.checked.response.bindingGapDispositions).toMatchObject([{ previousMentionId: 'gap', resolutionKind: 'mapped',
      targets: [{ entityId: 'next-gamma', selection: { quote: 'Gamma', occurrence: 0 } }] }]);
    expect(refined.rawOutput).toBe(f.result('refinement').output);
    expect(f.old.readB().checked).toMatchObject({ admission: { status: 'blocked' } });
  });

  it('projects each complete original once without receiptRaw and keeps independent task identities', () => {
    const f = refinedEntitiesFixture(), base = f.readBase(), input = JSON.parse(buildEntityRefinementInput(f.source, base.predecessor));
    expect(Object.keys(input.predecessors)).toEqual(['sourcePlan', 'discovery', 'binding']);
    for (const key of ['sourcePlan', 'discovery', 'binding'] as const) {
      expect(input.predecessors[key].rawOutput).toBe(base.predecessor[key].rawOutput);
      expect(input.predecessors[key]).not.toHaveProperty('receiptRaw');
    }
    expect(input.excerpts).toEqual(f.source.excerpts); expect(input.limitations).toEqual(f.source.limitations);
    expect([ENTITY_REFINEMENT_SYSTEM_VERSION, ENTITY_REFINEMENT_INPUT_VERSION, ENTITY_REFINEMENT_WIRE_VERSION, ENTITY_REFINEMENT_CHECK_VERSION])
      .toEqual(['knowledge-entity-refinement-system/v6', 'knowledge-entity-refinement-input/v3', 'knowledge-entity-refinement-wire/v3', 'knowledge-entity-refinement-check/v3']);
    expect(f.refinementExecution.request.system).toBe(ENTITY_REFINEMENT_SYSTEM);
    expect(f.refinementExecution.request.system.split(ENTITY_REFERENT_KIND_POLICY)).toHaveLength(2);
    expect(f.refinementExecution.request.system.split(ENTITY_CODE_REFERENT_POLICY)).toHaveLength(2);
    expect(f.refinementExecution.request.system.split(ENTITY_COLLECTIVE_REFERENCE_POLICY)).toHaveLength(2);
    expect([f.old.plan.sourcePlanReceipt.request.systemVersion, f.old.discoveryReceipt.request.systemVersion, f.old.bindingReceipt.request.systemVersion])
      .toEqual(['knowledge-source-plan-system/v6', 'knowledge-entity-discovery-system/v8', 'knowledge-mention-binding-system/v8']);
    expect([f.old.plan.sourcePlanReceipt.request.system, f.old.discoveryReceipt.request.system, f.old.bindingReceipt.request.system])
      .toEqual([SOURCE_PLAN_SYSTEM, ENTITY_DISCOVERY_SYSTEM, MENTION_BINDING_SYSTEM]);
    expect(checkEntityRefinementResponse(JSON.stringify(f.refinementResponse), f.source, base.predecessor).status).toBe('checked');
  });

  it.each([
    ['missing old entity', (f: Fixture) => { f.refinementResponse.entityDispositions.shift(); }, 'missing_entity'],
    ['duplicate old entity', (f: Fixture) => { f.refinementResponse.entityDispositions.push(structuredClone(f.refinementResponse.entityDispositions[0])); }, 'duplicate_entity'],
    ['unknown old entity', (f: Fixture) => { f.refinementResponse.entityDispositions[0].previousEntityId = 'never-returned'; }, 'unknown_entity'],
    ['unknown final target', (f: Fixture) => { f.refinementResponse.entityDispositions[0].entityIds = ['missing']; }, 'unknown_target'],
    ['duplicate final target', (f: Fixture) => { f.refinementResponse.entityDispositions[0].entityIds.push('next-e0'); }, 'duplicate_target'],
    ['changed retained metadata', (f: Fixture) => { f.refinementResponse.entities[0].description += ' changed'; }, 'retained_entity_changed'],
    ['changed retained source span', (f: Fixture) => { f.refinementResponse.anchors[0].selection.quote = 'Alpha 使用 Beta'; }, 'retained_entity_changed'],
    ['merge disguised as retention', (f: Fixture) => { f.refinementResponse.entityDispositions[1].entityIds = ['next-e0']; }, 'merge_requires_correction'],
    ['missing plan disposition', (f: Fixture) => { f.refinementResponse.dispositions = []; }, 'missing_object'],
    ['duplicate plan disposition', (f: Fixture) => { f.refinementResponse.dispositions.push(structuredClone(f.refinementResponse.dispositions[0])); }, 'duplicate_object'],
    ['unknown plan object', (f: Fixture) => { f.refinementResponse.dispositions[0].sourcePlanObjectId = 'unknown'; }, 'unknown_object'],
    ['unknown plan target', (f: Fixture) => { f.refinementResponse.dispositions[0].entityIds = ['unknown']; }, 'unknown_entity'],
    ['duplicate plan target', (f: Fixture) => { f.refinementResponse.dispositions[0].entityIds.push('next-e0'); }, 'duplicate_entity'],
    ['empty retained plan target', (f: Fixture) => { f.refinementResponse.dispositions[0].entityIds = []; }, 'invalid_targets'],
    ['empty corrected plan target', (f: Fixture) => { Object.assign(f.refinementResponse.dispositions[0], { dispositionKind: 'corrected', entityIds: [] }); }, 'invalid_targets'],
    ['excluded plan with target', (f: Fixture) => { f.refinementResponse.dispositions[0].dispositionKind = 'excluded'; }, 'invalid_targets'],
    ['invented plan evidence', (f: Fixture) => { f.refinementResponse.dispositions[0].selections[0].quote = 'not in source'; }, 'quote_mismatch'],
    ['duplicate plan evidence', (f: Fixture) => { f.refinementResponse.dispositions[0].selections.push(structuredClone(f.refinementResponse.dispositions[0].selections[0])); }, 'duplicate_selection'],
    ['previous SP-conditioned A-prime response', (f: Fixture) => { Object.assign(f.refinementResponse, { schemaVersion: 2 }); }, 'invalid_structure:schemaVersion'],
    ['invented source evidence', (f: Fixture) => { f.refinementResponse.entityDispositions[0].selections[0].quote = 'not in source'; }, 'quote_mismatch'],
    ['old A-prime response', (f: Fixture) => { Object.assign(f.refinementResponse, { schemaVersion: 1 }); }, 'invalid_structure:schemaVersion'],
    ['missing gap ledger', (f: Fixture) => { Object.assign(f.refinementResponse, { bindingGapDispositions: undefined }); }, 'invalid_structure:bindingGapDispositions'],
    ['missing gap', (f: Fixture) => { f.refinementResponse.bindingGapDispositions = []; }, 'binding-gap:gap:missing_mention'],
    ['duplicate gap', (f: Fixture) => { f.refinementResponse.bindingGapDispositions.push(structuredClone(f.refinementResponse.bindingGapDispositions[0])); }, 'duplicate_mention'],
    ['old bound item used as gap', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].previousMentionId = 'm0'; }, 'unknown_mention'],
    ['unknown gap target', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].targets[0].entityId = 'missing'; }, 'unknown_entity'],
    ['empty mapped gap', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].targets = []; }, 'invalid_targets'],
    ['excluded gap with targets', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].resolutionKind = 'excluded'; }, 'invalid_targets'],
    ['undetermined gap with targets', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].resolutionKind = 'undetermined'; }, 'invalid_targets'],
    ['missing old gap evidence', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].selections[0].occurrence = 1; }, 'missing_previous_position_evidence'],
    ['gap target at another occurrence', (f: Fixture) => {
      f.refinementResponse.bindingGapDispositions[0].targets[0].selection.occurrence = 1;
      f.refinementResponse.bindingGapDispositions[0].selections[0] = { evidenceRef: 'record-1', quote: 'Gamma 与 Gamma', occurrence: null };
    }, 'target_position_disjoint'],
    ['gap target outside its evidence', (f: Fixture) => {
      f.refinementResponse.bindingGapDispositions[0].targets[0].selection = { evidenceRef: 'record-1', quote: 'Gamma 与 Gamma', occurrence: null };
    }, 'missing_target_position_evidence'],
    ['same gap position assigned to two entities', (f: Fixture) => {
      const row = f.refinementResponse.bindingGapDispositions[0]; row.targets.push({ ...structuredClone(row.targets[0]), entityId: 'next-e0' });
    }, 'duplicate_target_position'],
    ['invented gap target quote', (f: Fixture) => { f.refinementResponse.bindingGapDispositions[0].targets[0].selection.quote = 'not in source'; }, 'quote_mismatch'],
  ])('rejects %s without losing the original', (_name, mutate, code) => {
    const f = refinedEntitiesFixture(), before = f.result('refinement').output;
    mutate(f); rejected(f, code); expect(f.result('refinement').output).toBe(before);
  });

  it.each(['context_only', 'qualification_unknown'] as const)('keeps independent SP %s objects in the first coordination account', planningRole => {
    const f = refinedEntitiesFixture(), beforeA = f.old.bytesA(), beforeB = f.old.bytesB();
    f.old.plan.sourcePlanResponse.objects[0].planningRole = planningRole;
    if (planningRole === 'qualification_unknown') f.old.plan.sourcePlanResponse.objects[0].uncertainties = ['Authored qualification remains undecided.'];
    const outcome = f.old.plan.sourcePlanNative.outcome;
    if (outcome.outcomeKind !== 'result') throw new Error('Authored plan fixture is not a result.');
    outcome.result.output = JSON.stringify(f.old.plan.sourcePlanResponse);
    f.old.plan.resealSourcePlan();
    const base = f.readBase();
    f.refinementResponse.binding = JSON.parse(buildEntityRefinementInput(f.source, base.predecessor)).binding;
    expect(check(f)).toMatchObject({ status: 'checked', dispositionIssues: [] });
    f.refinementResponse.dispositions = []; rejected(f, 'missing_object');
    expect(f.old.bytesA()).toEqual(beforeA); expect(f.old.bytesB()).toEqual(beforeB);
  });

  it('requires corrected SP merges and permits explicit splits, without treating either as semantic truth', () => {
    const f = refinedEntitiesFixture(), plan = f.old.plan;
    plan.sourcePlanResponse.objects.push({ ...structuredClone(plan.sourcePlanResponse.objects[0]), objectId: 'second-object' });
    const outcome = plan.sourcePlanNative.outcome;
    if (outcome.outcomeKind !== 'result') throw new Error('Authored plan fixture is not a result.');
    outcome.result.output = JSON.stringify(plan.sourcePlanResponse);
    plan.resealSourcePlan(); f.refinementResponse.binding = JSON.parse(buildEntityRefinementInput(f.source, f.readBase().predecessor)).binding;
    f.refinementResponse.dispositions.push({ ...structuredClone(f.refinementResponse.dispositions[0]), sourcePlanObjectId: 'second-object' });
    rejected(f, 'merge_requires_correction');
    f.refinementResponse.dispositions.forEach(row => { row.dispositionKind = 'corrected'; });
    expect(check(f)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
    f.refinementResponse.dispositions[0].entityIds = ['next-e0', 'next-e1'];
    Object.assign(f.refinementResponse.dispositions[1], { dispositionKind: 'excluded', entityIds: [] });
    expect(check(f)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
  });

  it('permits explicitly accounted corrections while preserving the not-reviewed boundary', () => {
    const f = refinedEntitiesFixture(); f.refinementResponse.entities[0].description += ' corrected authored description';
    f.refinementResponse.entityDispositions[0].dispositionKind = 'corrected';
    expect(check(f)).toMatchObject({ status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed' });
  });

  it.each(['entity', 'plan', 'ambiguous-gap'] as const)('retains legal undetermined %s accounting and blocks the B′ factory', which => {
    const f = refinedEntitiesFixture('codex', { ambiguousGap: which === 'ambiguous-gap' });
    if (which === 'ambiguous-gap') Object.assign(f.refinementResponse.bindingGapDispositions[0], { resolutionKind: 'undetermined', targets: [] });
    else Object.assign(which === 'entity' ? f.refinementResponse.entityDispositions[0] : f.refinementResponse.dispositions[0],
      { dispositionKind: 'undetermined', entityIds: [] });
    expect(check(f)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
    f.result('refinement').output = JSON.stringify(f.refinementResponse); f.resealRefinement();
    const refined = f.readRefinement(); expect(refined.checked.dispositionIssues).toHaveLength(1);
    f.refinedInspect.mockClear();
    expect(() => mentionRebindingExecution(f.source, f.model, refined, f.refinedEntitiesArchive)).toThrow('no successor context');
    expect(f.refinedInspect).not.toHaveBeenCalled();
  });

  it.each(['valid', 'no-uncertainty', 'wrong-layer-candidate'] as const)('checks an ambiguous gap mapped to an explicit unresolved object: %s', mode => {
    const f = refinedEntitiesFixture('codex', { collection: true, ambiguousGap: true }), unresolved = f.refinementResponse.entities.find(row => row.entityId === 'next-gamma')!;
    Object.assign(unresolved, { identityStatus: 'unresolved', possibleEntityIds: ['next-e0', 'next-e1'], uncertainties: ['Authored identity remains unknown.'] });
    if (mode === 'no-uncertainty') unresolved.uncertainties = [];
    if (mode === 'wrong-layer-candidate') unresolved.possibleEntityIds = ['next-g'];
    expect(check(f)).toMatchObject({ status: mode === 'valid' ? 'checked' : 'rejected', semanticStatus: 'not_reviewed' });
    expect(f.old.bindingResponse.mentions.at(-1)).toMatchObject({ bindingStatus: 'ambiguous', entityId: null });
  });

  it('accepts exactly 1 MiB of actual system/input bytes and refuses one more before producer inspection', () => {
    const f = refinedEntitiesFixture(), raw = f.old.result('binding').output!;
    const inputBytes = (input: string) => Buffer.byteLength(input, 'utf8') + Buffer.byteLength(ENTITY_REFINEMENT_SYSTEM, 'utf8');
    const baseBytes = inputBytes(f.refinementExecution.request.input);
    let padding = EXTRACTION_INPUT_MAX_BYTES - baseBytes - 64;
    const prepare = () => {
      f.old.result('binding').output = raw + ' '.repeat(padding); f.old.resealB();
      return f.readBase();
    };
    let base = prepare(), execution = entityRefinementExecution(f.source, f.model, base, f.refinedEntitiesArchive);
    padding += EXTRACTION_INPUT_MAX_BYTES - inputBytes(execution.request.input);
    base = prepare(); execution = entityRefinementExecution(f.source, f.model, base, f.refinedEntitiesArchive);
    expect(inputBytes(execution.request.input)).toBe(EXTRACTION_INPUT_MAX_BYTES);
    padding++; base = prepare(); f.refinedInspect.mockClear();
    expect(() => entityRefinementExecution(f.source, f.model, base, f.refinedEntitiesArchive)).toThrow(ExtractionInputCapacityError);
    expect(f.refinedInspect).not.toHaveBeenCalled();
  });
});
