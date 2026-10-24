import { describe, expect, it } from 'vitest';
import { buildEntityRefinementInput, checkEntityRefinementResponse, ENTITY_REFINEMENT_SYSTEM,
  ENTITY_REFINEMENT_SYSTEM_VERSION, ENTITY_REFINEMENT_INPUT_VERSION, ENTITY_REFINEMENT_WIRE_VERSION,
  ENTITY_REFINEMENT_CHECK_VERSION } from '../../src/knowledge/extraction/entity-refinement.js';
import { entityRefinementExecution, mentionRebindingExecution } from '../../src/knowledge/extraction/refined-entities-evidence.js';
import { EXTRACTION_INPUT_MAX_BYTES, ExtractionInputCapacityError } from '../../src/knowledge/extraction/model-input.js';
import { ENTITY_CODE_REFERENT_POLICY, ENTITY_REFERENT_KIND_POLICY } from '../../src/knowledge/extraction/knowledge-semantic-policy.js';
import { discoveryHash } from './discovered-entities-fixtures.js';
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
      .toEqual(['knowledge-entity-refinement-system/v2', 'knowledge-entity-refinement-input/v1', 'knowledge-entity-refinement-wire/v1', 'knowledge-entity-refinement-check/v1']);
    expect(f.refinementExecution.request.system).toBe(ENTITY_REFINEMENT_SYSTEM);
    expect(f.refinementExecution.request.system.split(ENTITY_REFERENT_KIND_POLICY)).toHaveLength(2);
    expect(f.refinementExecution.request.system.split(ENTITY_CODE_REFERENT_POLICY)).toHaveLength(2);
    expect([f.old.plan.sourcePlanReceipt.request.systemVersion, f.old.discoveryReceipt.request.systemVersion, f.old.bindingReceipt.request.systemVersion])
      .toEqual(['knowledge-source-plan-system/v4', 'knowledge-entity-discovery-system/v5', 'knowledge-mention-binding-system/v5']);
    expect([f.old.plan.sourcePlanReceipt.request.system, f.old.discoveryReceipt.request.system, f.old.bindingReceipt.request.system].map(discoveryHash))
      .toEqual(['sha256:1d48bfa88c2db0e7c1e5f652f44fea7da50eb534cd7afd61d31eed11098d1b09',
        'sha256:6184f32ecc8b817e604b94f8102d6690702e314999111668a4e6983525bf87a3',
        'sha256:e72be90277e1ffb20d31b0b9a406598c3a3feaf12fd703fa08eef715ea514695']);
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
    ['invented source evidence', (f: Fixture) => { f.refinementResponse.entityDispositions[0].selections[0].quote = 'not in source'; }, 'quote_mismatch'],
  ])('rejects %s without losing the original', (_name, mutate, code) => {
    const f = refinedEntitiesFixture(), before = f.result('refinement').output;
    mutate(f); rejected(f, code); expect(f.result('refinement').output).toBe(before);
  });

  it('permits explicitly accounted corrections while preserving the not-reviewed boundary', () => {
    const f = refinedEntitiesFixture(); f.refinementResponse.entities[0].description += ' corrected authored description';
    f.refinementResponse.entityDispositions[0].dispositionKind = 'corrected';
    expect(check(f)).toMatchObject({ status: 'checked', dispositionIssues: [], semanticStatus: 'not_reviewed' });
  });

  it.each(['entity', 'plan'] as const)('retains legal undetermined %s accounting and blocks the B′ factory', which => {
    const f = refinedEntitiesFixture(), row = which === 'entity' ? f.refinementResponse.entityDispositions[0] : f.refinementResponse.dispositions[0];
    Object.assign(row, { dispositionKind: 'undetermined', entityIds: [] });
    expect(check(f)).toMatchObject({ status: 'checked', semanticStatus: 'not_reviewed' });
    f.result('refinement').output = JSON.stringify(f.refinementResponse); f.resealRefinement();
    const refined = f.readRefinement(); expect(refined.checked.dispositionIssues).toHaveLength(1);
    f.refinedInspect.mockClear();
    expect(() => mentionRebindingExecution(f.source, f.model, refined, f.refinedEntitiesArchive)).toThrow('no successor context');
    expect(f.refinedInspect).not.toHaveBeenCalled();
  });

  it.each(['no-uncertainty', 'wrong-layer-candidate'] as const)('rejects malformed unresolved identity: %s', mode => {
    const f = refinedEntitiesFixture('codex', { collection: true, unresolved: true }), unresolved = f.refinementResponse.entities.find(row => row.entityId === 'next-u')!;
    f.refinementResponse.entityDispositions.find(row => row.previousEntityId === 'u')!.dispositionKind = 'corrected';
    if (mode === 'no-uncertainty') unresolved.uncertainties = []; else unresolved.possibleEntityIds = ['next-g'];
    expect(check(f).status).toBe('rejected');
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
