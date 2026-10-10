import type { EntityAnalysisDraft } from './contracts.js';
import { canonicalJson } from '../store.js';
import { entityIdentityProblems, entityIdentityReferenceProblems } from './identity.js';

/** Reference closure is structural admission, never semantic identity verification. */
export function validateEntityAnalysis(draft: EntityAnalysisDraft): string[] {
  const problems: string[] = [];
  const ids = new Set(draft.entities.map(entity => entity.entityId));
  if (ids.size !== draft.entities.length) problems.push('duplicate_entity');
  const mentions = new Set(draft.mentions.map(mention => mention.mentionId));
  if (mentions.size !== draft.mentions.length) problems.push('duplicate_mention');
  const positions = new Set<string>();
  const byId = new Map(draft.entities.map(entity => [entity.entityId, entity]));
  for (const mention of draft.mentions) {
    if (!ids.has(mention.entityId)) problems.push('unknown_entity');
    if (mention.selection.start >= mention.selection.end
      || mention.selection.end - mention.selection.start !== mention.selection.quote.length) problems.push('invalid_selection');
    const position = canonicalJson([mention.selection.evidenceRef, mention.selection.start, mention.selection.end]);
    if (positions.has(position)) problems.push('duplicate_mention_position');
    positions.add(position);
  }
  for (const entity of draft.entities) {
    problems.push(...entityIdentityProblems(entity), ...entityIdentityReferenceProblems(entity, byId, draft.mentions));
    if (!draft.mentions.some(mention => mention.entityId === entity.entityId)) problems.push('entity_without_mention');
    if (new Set(entity.possibleEntityIds).size !== entity.possibleEntityIds.length) problems.push('duplicate_possible_entity');
    for (const target of entity.possibleEntityIds) {
      if (!ids.has(target) || target === entity.entityId) problems.push('unknown_possible_entity');
      else if (draft.entities.find(candidate => candidate.entityId === target)?.identityStatus !== 'proposed') problems.push('unresolved_possible_entity');
    }
  }
  return [...new Set(problems)];
}
