import { z } from 'zod';
import { EntityMentionSchema, EvidenceSelectionSchema, type EvidenceExcerpt, type EvidenceSelection } from '../../knowledge/contracts.js';

const id = z.string().min(1).max(256);
const text = z.string().trim().min(1).max(4096);
export const QuoteLocatorSchema = EvidenceSelectionSchema.omit({ start: true, end: true }).extend({
  prefix: z.string().max(4096).optional(), suffix: z.string().max(4096).optional(),
});
export const EntityModelSchema = z.strictObject({
  entityId: id, label: text, description: text, qualifiers: z.array(text).max(32),
  identityStatus: z.enum(['proposed', 'unresolved']),
  possibleEntityIds: z.array(id).max(32), uncertainties: z.array(text).max(32),
}).superRefine((entity, context) => {
  if (entity.identityStatus === 'unresolved' && !entity.uncertainties.length) {
    context.addIssue({ code: 'custom', path: ['uncertainties'], message: 'Unresolved identity needs a reason.' });
  }
  if (entity.identityStatus === 'proposed' && entity.possibleEntityIds.length) {
    context.addIssue({ code: 'custom', path: ['possibleEntityIds'], message: 'Possible targets belong to unresolved identities.' });
  }
});
export const EntityModelMentionSchema = EntityMentionSchema.extend({ selection: QuoteLocatorSchema });
export type EntityModel = z.infer<typeof EntityModelSchema>;
export interface EntityAdmissionRejection { component: 'entity' | 'mention'; index: number; reasons: string[] }
export interface AdmittedEntityAnalysis {
  entities: EntityModel[];
  mentions: z.infer<typeof EntityMentionSchema>[];
  rejected: EntityAdmissionRejection[];
}

/** Exact adjacent context disambiguates repeated names without trusting generated offsets. */
export function locateQuote(locator: z.infer<typeof QuoteLocatorSchema>, excerpts: readonly EvidenceExcerpt[]): EvidenceSelection | string {
  const matches = excerpts.filter(excerpt => excerpt.evidenceRef === locator.evidenceRef);
  if (matches.length !== 1) return 'unknown_evidence';
  const source = matches[0].text;
  let position = source.indexOf(locator.quote); let selected: number | undefined;
  while (position >= 0) {
    const before = source.slice(0, position); const after = source.slice(position + locator.quote.length);
    if ((locator.prefix === undefined || before.endsWith(locator.prefix))
      && (locator.suffix === undefined || after.startsWith(locator.suffix))) {
      if (selected !== undefined) return 'ambiguous_quote';
      selected = position;
    }
    position = source.indexOf(locator.quote, position + 1);
  }
  if (selected === undefined) return 'quote_mismatch';
  return { evidenceRef: locator.evidenceRef, quote: locator.quote, start: selected, end: selected + locator.quote.length };
}

function duplicates(values: readonly string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

/** Invalid dependencies are rejected explicitly; retained hypotheses are never silently repaired. */
export function admitEntities(rawEntities: readonly unknown[], rawMentions: readonly unknown[], excerpts: readonly EvidenceExcerpt[]): AdmittedEntityAnalysis {
  if (rawEntities.length > 256 || rawMentions.length > 512) throw new Error('Entity output exceeds capacity.');
  if (new Set(excerpts.map(excerpt => excerpt.evidenceRef)).size !== excerpts.length) throw new Error('Ambiguous evidence window.');
  const entities = rawEntities.map(value => EntityModelSchema.safeParse(value));
  const mentions = rawMentions.map(value => EntityModelMentionSchema.safeParse(value));
  const rawIds = (values: readonly unknown[], key: string) => values.flatMap(value => {
    const parsed = id.safeParse(value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined);
    return parsed.success ? [parsed.data] : [];
  });
  const duplicateEntities = duplicates(rawIds(rawEntities, 'entityId'));
  const duplicateMentions = duplicates(rawIds(rawMentions, 'mentionId'));
  const rejected: EntityAdmissionRejection[] = [];
  const acceptedEntities = entities.flatMap((entity, index) => {
    if (!entity.success) { rejected.push({ component: 'entity', index, reasons: ['invalid_structure'] }); return []; }
    if (duplicateEntities.has(entity.data.entityId)) { rejected.push({ component: 'entity', index, reasons: ['duplicate_entity'] }); return []; }
    if (new Set(entity.data.possibleEntityIds).size !== entity.data.possibleEntityIds.length) {
      rejected.push({ component: 'entity', index, reasons: ['duplicate_possible_entity'] }); return [];
    }
    return [{ entity: entity.data, index }];
  });
  const acceptedMentions = mentions.flatMap((mention, index) => {
    if (!mention.success) { rejected.push({ component: 'mention', index, reasons: ['invalid_structure'] }); return []; }
    if (duplicateMentions.has(mention.data.mentionId)) { rejected.push({ component: 'mention', index, reasons: ['duplicate_mention'] }); return []; }
    const selection = locateQuote(mention.data.selection, excerpts);
    if (typeof selection === 'string') { rejected.push({ component: 'mention', index, reasons: [selection] }); return []; }
    return [{ mention: { ...mention.data, selection }, index }];
  });
  const positions = duplicates(acceptedMentions.map(({ mention }) => JSON.stringify([mention.selection.evidenceRef, mention.selection.start, mention.selection.end])));
  let retainedMentions = acceptedMentions.filter(({ mention, index }) => {
    if (!positions.has(JSON.stringify([mention.selection.evidenceRef, mention.selection.start, mention.selection.end]))) return true;
    rejected.push({ component: 'mention', index, reasons: ['duplicate_mention_position'] }); return false;
  });
  let retainedEntities = acceptedEntities;
  // Removing unsupported entities can invalidate an unresolved candidate list, then its mentions.
  let changed = true;
  while (changed) {
    changed = false;
    const byId = new Map(retainedEntities.map(({ entity }) => [entity.entityId, entity]));
    retainedMentions = retainedMentions.filter(({ mention, index }) => {
      if (byId.has(mention.entityId)) return true;
      rejected.push({ component: 'mention', index, reasons: ['unknown_entity'] }); changed = true; return false;
    });
    const supported = new Set(retainedMentions.map(({ mention }) => mention.entityId));
    retainedEntities = retainedEntities.filter(({ entity, index }) => {
      const reasons: string[] = [];
      if (!supported.has(entity.entityId)) reasons.push('entity_without_mention');
      if (entity.possibleEntityIds.some(target => !byId.has(target) || target === entity.entityId)) reasons.push('unknown_possible_entity');
      if (entity.possibleEntityIds.some(target => byId.get(target)?.identityStatus === 'unresolved')) reasons.push('unresolved_possible_entity');
      if (!reasons.length) return true;
      rejected.push({ component: 'entity', index, reasons }); changed = true; return false;
    });
  }
  return { entities: retainedEntities.map(({ entity }) => entity), mentions: retainedMentions.map(({ mention }) => mention),
    rejected: rejected.sort((a, b) => a.component.localeCompare(b.component) || a.index - b.index) };
}
