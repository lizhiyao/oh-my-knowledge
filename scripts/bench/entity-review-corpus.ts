import { z } from 'zod';

export const ENTITY_CHECK_VERSION = 'omk-entity-critical-checks/v3';
export const ENTITY_GUIDE_VERSION = 'omk-entity-annotation/v6';
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().trim().min(1).max(8192);
const exactText = z.string().min(1).max(32768).refine(value => value.trim().length > 0);
const quote = z.strictObject({ quote: exactText, occurrence: z.number().int().nonnegative() });
const referentKind = z.enum(['object', 'component', 'instance', 'version', 'collection', 'plan', 'activity']);
const entity = z.strictObject({
  entityKey: key, referentKinds: z.array(referentKind).min(1),
  identityStatus: z.enum(['proposed', 'unresolved']), possibleEntities: z.array(key),
  component: key.nullable(),
  collection: z.strictObject({ members: z.array(key), completeness: z.enum(['complete', 'partial', 'unknown']) }).nullable(),
  rationale: text,
});
export const EntityReviewCorpusSchema = z.strictObject({
  corpusVersion: z.literal('omk-entity-quality/v8'), guideVersion: z.literal(ENTITY_GUIDE_VERSION),
  provenance: z.literal('synthetic'), authors: z.array(text).min(1),
  annotationScope: z.literal('critical_mentions'),
  cases: z.array(z.strictObject({
    caseId: key, projectGroup: key, conversationGroup: key, split: z.enum(['development', 'validation']),
    messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), text: exactText })).min(1),
    limitations: z.array(text).min(1), tags: z.array(key).min(1),
    entities: z.array(entity).min(1),
    mentions: z.array(z.strictObject({ mentionKey: key, entity: key, messageIndex: z.number().int().nonnegative(),
      alternatives: z.array(quote).min(1), rationale: text })).min(1),
    roles: z.array(z.strictObject({ roleKey: key, subject: key, object: key.nullable(), messageIndex: z.number().int().nonnegative(),
      anchor: quote, interpretation: text })),
    knowledgePolicy: z.enum(['optional', 'none']), semanticChecks: z.array(text).min(1),
  })).min(2).max(64),
});
export type EntityReviewCorpus = z.infer<typeof EntityReviewCorpusSchema>;
export type EntityReviewCase = EntityReviewCorpus['cases'][number];

export function reviewSpan(sample: EntityReviewCase, messageIndex: number, selected: z.infer<typeof quote>) {
  const source = sample.messages[messageIndex]?.text;
  if (!source) throw new Error('Annotation references an absent message.');
  let start = -1;
  for (let occurrence = 0; occurrence <= selected.occurrence; occurrence += 1) {
    start = source.indexOf(selected.quote, start + 1);
    if (start < 0) throw new Error('Annotation quote occurrence is absent.');
  }
  return { evidenceRef: `${sample.caseId}:${messageIndex}`, start, end: start + selected.quote.length, quote: selected.quote };
}

export function reviewMentions(sample: EntityReviewCase) {
  return sample.mentions.map(mention => ({ ...mention,
    spans: mention.alternatives.map(selected => reviewSpan(sample, mention.messageIndex, selected)) }));
}

/** Reject leakage and contradictory gold before inspecting any model output. */
export function parseEntityReviewCorpus(raw: string): EntityReviewCorpus {
  const corpus = EntityReviewCorpusSchema.parse(JSON.parse(raw));
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(corpus.cases.map(sample => sample.caseId))) throw new Error('Duplicate case identity.');
  if (!unique(corpus.authors.map(author => author.toLowerCase()))) throw new Error('Duplicate corpus author.');
  for (const group of ['projectGroup', 'conversationGroup'] as const) {
    const splits = new Map<string, string>();
    for (const sample of corpus.cases) {
      if (splits.has(sample[group]) && splits.get(sample[group]) !== sample.split) throw new Error(`${group} leaks across splits.`);
      splits.set(sample[group], sample.split);
    }
  }
  if (new Set(corpus.cases.map(sample => sample.split)).size !== 2) throw new Error('Both splits are required.');
  // Exact duplicate windows cannot become held-out evidence through different group labels.
  const windows = new Map<string, string>();
  for (const sample of corpus.cases) {
    const window = JSON.stringify(sample.messages);
    if (windows.has(window) && windows.get(window) !== sample.split) throw new Error('Source window leaks across splits.');
    windows.set(window, sample.split);
    if (!unique(sample.entities.map(value => value.entityKey)) || !unique(sample.mentions.map(value => value.mentionKey))
      || !unique(sample.roles.map(value => value.roleKey))) throw new Error('Duplicate annotation identity.');
    const byId = new Map(sample.entities.map(value => [value.entityKey, value]));
    const refs = [...sample.mentions.map(value => value.entity), ...sample.roles.flatMap(value => [value.subject, ...(value.object ? [value.object] : [])]),
      ...sample.entities.flatMap(value => [...value.possibleEntities, ...(value.component ? [value.component] : []), ...(value.collection?.members ?? [])])];
    if (refs.some(ref => !byId.has(ref))) throw new Error('Unclosed annotation identity.');
    const positions = reviewMentions(sample).flatMap(value => value.spans.map(span => `${span.evidenceRef}:${span.start}:${span.end}`));
    if (!unique(positions)) throw new Error('Duplicate annotation position.');
    for (const role of sample.roles) reviewSpan(sample, role.messageIndex, role.anchor);
    for (const value of sample.entities) {
      if (!sample.mentions.some(mention => mention.entity === value.entityKey)) throw new Error('Annotation entity has no mention.');
      if (!unique(value.referentKinds) || !unique(value.possibleEntities) || !unique(value.collection?.members ?? [])) throw new Error('Duplicate identity choice.');
      if (value.identityStatus === 'proposed' && value.possibleEntities.length) throw new Error('Proposed gold cannot have alternatives.');
      if (value.possibleEntities.some(ref => ref === value.entityKey || byId.get(ref)!.identityStatus !== 'proposed'
        || !byId.get(ref)!.referentKinds.some(kind => value.referentKinds.includes(kind)))) throw new Error('Invalid unresolved candidate.');
      if (value.component && (!value.referentKinds.every(kind => kind === 'instance' || kind === 'version')
        || byId.get(value.component)!.identityStatus !== 'proposed' || !byId.get(value.component)!.referentKinds.includes('component'))) throw new Error('Invalid gold component.');
      if (value.referentKinds.includes('collection') !== !!value.collection || (value.collection && value.referentKinds.length !== 1)) throw new Error('Invalid gold collection.');
      if (value.collection && ((value.collection.completeness === 'unknown' && value.collection.members.length)
        || (value.collection.completeness === 'partial' && !value.collection.members.length)
        || (value.identityStatus === 'unresolved' && value.collection.completeness !== 'unknown'))) throw new Error('Invalid gold membership.');
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error('Cyclic gold membership.');
      if (visited.has(id)) return;
      visiting.add(id); for (const child of byId.get(id)!.collection?.members ?? []) visit(child);
      visiting.delete(id); visited.add(id);
    };
    for (const id of byId.keys()) visit(id);
  }
  return corpus;
}

/** Gold, group labels, roles and review criteria never enter executor input. */
export function entityReviewInput(sample: EntityReviewCase) {
  return { excerpts: sample.messages.map((message, recordIndex) => ({
    evidenceRef: `${sample.caseId}:${recordIndex}`, recordIndex, eventKind: 'message', ...message,
  })), limitations: sample.limitations };
}
