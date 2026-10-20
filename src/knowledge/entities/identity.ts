import { z } from 'zod';

const text = z.string().trim().min(1).max(4096);

/** Human review guidance, not a classifier or a change to identity-confirmation semantics. */
export const ENTITY_SCOPE_REVIEW_GUIDANCE = {
  zh: '先核对实体范围：Issue／PR 概念可以是实体，具体 Issue／PR 工作记录仅保留在来源或案例上下文。若选中了具体记录，先回到来源实体修订中纠正，并在知识上下文保留编号和链接；不要通过组织或改名将它变成概念。确认是同一对象，不代表应纳入实体目录；其他有来源依据的具体实例仍可保留。',
  en: 'Review entity scope first: Issue and PR concepts can be entities; concrete Issue or PR records belong only in source or case context. Correct such records in the source entity revision and preserve their identifiers and links in knowledge context; do not turn them into concepts by organizing or renaming them. Confirming the same identity does not establish eligibility for the entity catalog. Other source-supported concrete instances remain eligible.',
} as const;

/** Shared shape for window-local IDs and host-assigned persistent IDs. */
export function entityIdentityShape(id: z.ZodType<string>) {
  const evidence = { mentionIds: z.array(id).min(1).max(64), rationale: text };
  return {
    referentKind: z.enum(['object', 'component', 'instance', 'version', 'collection', 'plan', 'activity']),
    componentRef: z.strictObject({ entityId: id, ...evidence }).nullable(),
    collection: z.strictObject({ memberEntityIds: z.array(id).max(256),
      completeness: z.enum(['complete', 'partial', 'unknown']), ...evidence }).nullable(),
  };
}

type IdentityShape = ReturnType<typeof entityIdentityShape>;
export type EntityIdentity = { [Key in keyof IdentityShape]: z.infer<IdentityShape[Key]> } & {
  entityId: string; identityStatus: 'proposed' | 'unresolved';
  possibleEntityIds: string[]; uncertainties: string[];
};
type Mention = { mentionId: string; entityId: string };

/** Rewrite every local link together; missing mappings are errors, never dropped references. */
export function mapEntityIdentity<T extends EntityIdentity>(entity: T, entityIds: ReadonlyMap<string, string>,
  mentionIds: ReadonlyMap<string, string>): T {
  const mapped = (ids: ReadonlyMap<string, string>, id: string) => {
    const value = ids.get(id);
    if (value === undefined) throw new Error('Unknown entity identity mapping.');
    return value;
  };
  return { ...entity, entityId: mapped(entityIds, entity.entityId),
    possibleEntityIds: entity.possibleEntityIds.map(id => mapped(entityIds, id)),
    componentRef: entity.componentRef ? { ...entity.componentRef,
      entityId: mapped(entityIds, entity.componentRef.entityId),
      mentionIds: entity.componentRef.mentionIds.map(id => mapped(mentionIds, id)) } : null,
    collection: entity.collection ? { ...entity.collection,
      memberEntityIds: entity.collection.memberEntityIds.map(id => mapped(entityIds, id)),
      mentionIds: entity.collection.mentionIds.map(id => mapped(mentionIds, id)) } : null,
  };
}

/** Local shape requirements; absence of identity uncertainty does not mean verified truth. */
export function entityIdentityProblems(entity: EntityIdentity): string[] {
  const problems: string[] = [];
  if (entity.componentRef && !['instance', 'version'].includes(entity.referentKind)) problems.push('unexpected_component_reference');
  if ((entity.referentKind === 'collection') !== (entity.collection !== null)) problems.push('invalid_collection_shape');
  if (entity.collection) {
    const { memberEntityIds, completeness } = entity.collection;
    if (new Set(memberEntityIds).size !== memberEntityIds.length) problems.push('duplicate_collection_member');
    if (completeness === 'unknown' && memberEntityIds.length) problems.push('unknown_collection_has_members');
    if (completeness === 'partial' && !memberEntityIds.length) problems.push('partial_collection_without_members');
    if (completeness !== 'complete' && !entity.uncertainties.length) problems.push('incomplete_collection_without_reason');
    if (entity.identityStatus === 'unresolved' && completeness !== 'unknown') problems.push('unresolved_collection_has_membership');
  }
  return problems;
}

/** Closed references only: a valid link remains a source interpretation, never a verified fact. */
export function entityIdentityReferenceProblems(entity: EntityIdentity, entities: ReadonlyMap<string, EntityIdentity>,
  mentions: readonly Mention[]): string[] {
  const problems: string[] = [];
  const byMention = new Map(mentions.map(mention => [mention.mentionId, mention]));
  const checkEvidence = (ids: readonly string[], prefix: string) => {
    if (new Set(ids).size !== ids.length) problems.push(`${prefix}:duplicate_mention`);
    if (ids.some(id => !byMention.has(id))) problems.push(`${prefix}:unknown_mention`);
    if (!ids.some(id => byMention.get(id)?.entityId === entity.entityId)) problems.push(`${prefix}:missing_entity_mention`);
  };
  for (const target of entity.possibleEntityIds) {
    if (entities.has(target) && entities.get(target)!.referentKind !== entity.referentKind) problems.push('possible_entity_level_mismatch');
  }
  if (entity.componentRef) {
    const component = entities.get(entity.componentRef.entityId);
    if (!component) problems.push('unknown_component');
    else if (component.referentKind !== 'component' || component.identityStatus !== 'proposed') problems.push('invalid_component_target');
    checkEvidence(entity.componentRef.mentionIds, 'component');
    if (entity.possibleEntityIds.some(id => {
      const candidate = entities.get(id);
      return candidate?.componentRef && candidate.componentRef.entityId !== entity.componentRef!.entityId;
    })) problems.push('possible_component_mismatch');
  }
  if (entity.collection) {
    checkEvidence(entity.collection.mentionIds, 'collection');
    if (entity.collection.memberEntityIds.some(id => !entities.has(id))) problems.push('unknown_collection_member');
    const pending = [...entity.collection.memberEntityIds]; const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === entity.entityId) { problems.push('collection_cycle'); break; }
      if (visited.has(id)) continue;
      visited.add(id); pending.push(...(entities.get(id)?.collection?.memberEntityIds ?? []));
    }
  }
  return [...new Set(problems)];
}
