import type { EntityAnalysisDraft } from '../entities/contracts.js';
import { EntityAnalysisDraftSchema } from '../entities/contracts.js';
import { mapEntityIdentity } from '../entities/identity.js';
import { validateEntityAnalysis, validateEntityMentionSelection } from '../entities/validation.js';
import { canonicalJson } from '../store.js';
import type { AssociationGenerationResponse } from './body-generation-wire.js';
import { EntityModelSchema } from './entities.js';
import { locateQuoteContext } from './quote-context.js';

/** A mention key belongs to one entity, even when two entities choose the same local key. */
export const associationMentionKey = (entityId: string, mentionKey: string) => canonicalJson([entityId, mentionKey]);

/** Compile request-local declarations; do not infer types, repair claims or relax domain validation. */
export function compileAssociationCatalog(catalog: AssociationGenerationResponse['catalogs'][number], window: { excerpts: readonly { evidenceRef: string; text: string }[] }, id: () => string): {
  draft: EntityAnalysisDraft; entityIds: Map<string, string>; mentionIds: Map<string, string>;
} {
  const entityIds = new Map(catalog.entities.map(entity => [entity.entityId, id()]));
  if (entityIds.size !== catalog.entities.length) throw new Error('Duplicate local entity identity.');
  const declared = catalog.entities.flatMap(entity => entity.mentions.map(mention => ({ entityId: entity.entityId, mention })));
  if (declared.length > 512) throw new Error('Entity catalog mention capacity exceeded.');
  const mentionIds = new Map(declared.map(({ entityId, mention }) => [associationMentionKey(entityId, mention.mentionKey), id()]));
  if (mentionIds.size !== declared.length) throw new Error('Duplicate owned mention key.');
  const mapped = (ids: ReadonlyMap<string, string>, key: string) => {
    const value = ids.get(key); if (!value) throw new Error('Unknown local catalog identity.'); return value;
  };
  const entities = catalog.entities.map(({ mentions: _mentions, componentLink, collectionLink, ...entity }) => {
    const ownKeys = (keys: string[]) => keys.map(key => {
      const qualified = associationMentionKey(entity.entityId, key);
      if (!mentionIds.has(qualified)) throw new Error('Identity evidence must belong to the declaring entity.');
      return qualified;
    });
    return EntityModelSchema.parse(mapEntityIdentity({ ...entity,
      componentRef: componentLink ? { entityId: componentLink.entityId, mentionIds: ownKeys(componentLink.mentionKeys), rationale: componentLink.rationale } : null,
      collection: collectionLink ? { memberEntityIds: collectionLink.memberEntityIds, completeness: collectionLink.completeness,
        mentionIds: ownKeys(collectionLink.mentionKeys), rationale: collectionLink.rationale } : null,
    }, entityIds, mentionIds));
  });
  const mentions = declared.map(({ entityId, mention }) => {
    const selection = locateQuoteContext(mention.selection, window.excerpts);
    if (typeof selection === 'string' || validateEntityMentionSelection(selection, window.excerpts).length) {
      throw new Error(`Entity mention locator rejected: ${typeof selection === 'string' ? selection : 'invalid_mention_boundary'}.`);
    }
    return { mentionId: mapped(mentionIds, associationMentionKey(entityId, mention.mentionKey)), entityId: mapped(entityIds, entityId),
      selection, basis: mention.basis, rationale: mention.rationale };
  });
  const draft = EntityAnalysisDraftSchema.parse({ entities, mentions,
    limitations: ['AI-derived pending associations; exact source matching and compiled references do not confirm semantic identity or truth.'] });
  const problems = validateEntityAnalysis(draft);
  if (problems.length) throw new Error(`Entity catalog reference closure rejected: ${problems.join(', ')}.`);
  return { draft, entityIds, mentionIds };
}
