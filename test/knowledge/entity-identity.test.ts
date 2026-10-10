import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { entityIdentityProblems, entityIdentityReferenceProblems, entityIdentityShape,
  type EntityIdentity } from '../../src/knowledge/entity-identity.js';

const entity = (entityId: string, referentKind: EntityIdentity['referentKind'] = 'object'): EntityIdentity => ({
  entityId, referentKind, componentRef: null, collection: null,
  identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
});
const mentions = ['component', 'test', 'production', 'a', 'b', 'group'].map(entityId => ({ entityId, mentionId: `m-${entityId}` }));
const references = (current: EntityIdentity, others: EntityIdentity[] = []) => entityIdentityReferenceProblems(current,
  new Map([current, ...others].map(value => [value.entityId, value])), mentions);
const collection = (members: string[], completeness: 'complete' | 'partial' | 'unknown' = 'complete'): EntityIdentity => ({
  ...entity('group', 'collection'), collection: { memberEntityIds: members, completeness, mentionIds: ['m-group'], rationale: '原文共同指代这些对象' },
});

describe('entity identity policy', () => {
  it('requires explicit level and relation slots without accepting arbitrary new fields', () => {
    const schema = z.strictObject(entityIdentityShape(z.string().min(1)));
    expect(schema.parse({ referentKind: 'object', componentRef: null, collection: null }))
      .toEqual({ referentKind: 'object', componentRef: null, collection: null });
    expect(schema.safeParse({ referentKind: 'object' }).success).toBe(false);
    expect(schema.safeParse({ referentKind: 'object', componentRef: null, collection: null, kind: 'entity' }).success).toBe(false);
  });
  it('keeps component identity separate from distinct instances and their changing conditions', () => {
    const component = entity('component', 'component');
    const test = { ...entity('test', 'instance'), componentRef: { entityId: 'component', mentionIds: ['m-test'], rationale: '原文说明实例属于组件' } };
    const production = { ...test, entityId: 'production', componentRef: { ...test.componentRef, mentionIds: ['m-production'] } };
    expect(references(test, [component, production])).toEqual([]);
    expect(references(production, [component, test])).toEqual([]);
    expect(entityIdentityProblems(component)).toEqual([]);
    expect(entityIdentityProblems({ ...component, componentRef: test.componentRef })).toContain('unexpected_component_reference');
    expect(references(test, [entity('component', 'object')])).toContain('invalid_component_target');
    expect(references(test)).toContain('unknown_component');
  });
  it('distinguishes known collections with incomplete membership from ambiguous identities', () => {
    const complete = collection(['a', 'b']);
    expect(entityIdentityProblems(complete)).toEqual([]);
    expect(references(complete, [entity('a'), entity('b')])).toEqual([]);
    const partial = { ...collection(['a'], 'partial'), uncertainties: ['还有一个成员未识别'] };
    expect(entityIdentityProblems(partial)).toEqual([]);
    expect(partial.identityStatus).toBe('proposed');
    const unresolved = { ...collection([], 'unknown'), identityStatus: 'unresolved' as const,
      uncertainties: ['窗口缺少复数指代的先行项'], possibleEntityIds: ['other-group'] };
    expect(entityIdentityProblems(unresolved)).toEqual([]);
    expect(references(unresolved, [{ ...collection(['a']), entityId: 'other-group' }, entity('a')])).toEqual([]);
    expect(references(unresolved, [entity('other-group')])).toContain('possible_entity_level_mismatch');
    expect(entityIdentityProblems({ ...complete, identityStatus: 'unresolved', uncertainties: ['身份待定'] })).toContain('unresolved_collection_has_membership');
  });
  it('rejects membership contradictions, dangling members and containment cycles', () => {
    expect(entityIdentityProblems(collection(['a', 'a']))).toContain('duplicate_collection_member');
    expect(entityIdentityProblems(collection(['a'], 'unknown'))).toContain('unknown_collection_has_members');
    expect(entityIdentityProblems(collection([], 'partial'))).toContain('partial_collection_without_members');
    expect(entityIdentityProblems(collection([], 'unknown'))).toContain('incomplete_collection_without_reason');
    expect(entityIdentityProblems(entity('group', 'collection'))).toContain('invalid_collection_shape');
    expect(references(collection(['missing']))).toContain('unknown_collection_member');
    expect(references(collection(['group']))).toContain('collection_cycle');
    const nested = { ...collection(['group']), entityId: 'nested' };
    expect(references(collection(['nested']), [nested])).toContain('collection_cycle');
  });
  it('requires retained supporting mentions for each link rather than a plausible name', () => {
    const group = collection(['a']); group.collection!.mentionIds = ['m-a'];
    expect(references(group, [entity('a')])).toContain('collection:missing_entity_mention');
    group.collection!.mentionIds = ['m-group', 'lost'];
    expect(references(group, [entity('a')])).toContain('collection:unknown_mention');
    group.collection!.mentionIds = ['m-group', 'm-group'];
    expect(references(group, [entity('a')])).toContain('collection:duplicate_mention');
    const instance = { ...entity('test', 'instance'), componentRef: { entityId: 'component', mentionIds: ['m-production'], rationale: '同名不能替代来源' } };
    expect(references(instance, [entity('component', 'component')])).toContain('component:missing_entity_mention');
  });
});
