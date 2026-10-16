import { z } from 'zod';

export const ENTITY_LINK_CORPUS_VERSION = 'omk-entity-link-quality/v1';
export const ENTITY_LINK_GUIDE_VERSION = 'omk-entity-link-annotation/v1';
export const ENTITY_LINK_CHECK_VERSION = 'omk-entity-link-checks/v1';
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().trim().min(1).max(8192);
export const EntityLinkReviewCorpusSchema = z.strictObject({
  corpusVersion: z.literal(ENTITY_LINK_CORPUS_VERSION), guideVersion: z.literal(ENTITY_LINK_GUIDE_VERSION),
  provenance: z.literal('synthetic'), authors: z.array(text).min(1),
  cases: z.array(z.strictObject({
    caseId: key, projectGroup: key, conversationGroup: key, split: z.enum(['development', 'validation']),
    tags: z.array(key).min(1), input: z.record(z.string(), z.json()),
    expectedAssessment: z.enum(['same_object', 'different_objects', 'insufficient_evidence']),
    referenceRationale: text, semanticChecks: z.array(text).min(1), limitations: z.array(text).min(1),
  })).min(6).max(64),
});
export interface EntityLinkReviewSide {
  binding: { analysisId: string; entityId: string; mentionIds: string[] };
  entity: { entityId: string };
  mentions: { mentionId: string; entityId: string; selection: { evidenceRef: string; start: number; end: number; quote: string } }[];
  limitations: string[];
}
export interface EntityLinkReviewInput { protocolId: 'entity-link-model-input/v1'; left: EntityLinkReviewSide; right: EntityLinkReviewSide }
export type EntityLinkReviewCase = Omit<z.infer<typeof EntityLinkReviewCorpusSchema>['cases'][number], 'input'> & { input: EntityLinkReviewInput };
export type EntityLinkReviewCorpus = Omit<z.infer<typeof EntityLinkReviewCorpusSchema>, 'cases'> & { cases: EntityLinkReviewCase[] };
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);

/** Production input validation is injected by the fixed built composition root, never by corpus data. */
export function parseEntityLinkReviewCorpus(raw: string, validateInput: (input: unknown) => EntityLinkReviewInput): EntityLinkReviewCorpus {
  const parsed = EntityLinkReviewCorpusSchema.parse(JSON.parse(raw));
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(parsed.authors.map(author => author.toLowerCase())) || !unique(parsed.cases.map(sample => sample.caseId))) throw new Error('Duplicate author/case identity.');
  const groups = new Map<string, string>(); const windows = new Map<string, string>();
  const cases = parsed.cases.map(sample => {
    for (const field of ['projectGroup', 'conversationGroup'] as const) {
      const group = field + ':' + sample[field];
      if (groups.has(group) && groups.get(group) !== sample.split) throw new Error('Source group leaks across splits.');
      groups.set(group, sample.split);
    }
    const input = validateInput(sample.input);
    if (canonical(input) !== canonical(sample.input) || input.left.binding.analysisId === input.right.binding.analysisId) throw new Error('Model input changed or is not cross-window.');
    for (const side of [input.left, input.right]) {
      if (side.entity.entityId !== side.binding.entityId || !unique(side.binding.mentionIds)
        || !unique(side.mentions.map(mention => mention.mentionId))
        || canonical([...side.binding.mentionIds].sort()) !== canonical(side.mentions.map(mention => mention.mentionId).sort())
        || side.mentions.some(mention => mention.entityId !== side.binding.entityId || mention.selection.end - mention.selection.start !== mention.selection.quote.length)) {
        throw new Error('Input entity/selected mention binding is not closed.');
      }
    }
    for (const side of [input.left, input.right]) {
      const { entityId: _entityId, ...description } = side.entity;
      const sourceContent = canonical({ description, quotes: side.mentions.map(mention => mention.selection.quote), limitations: side.limitations });
      if (windows.has(sourceContent) && windows.get(sourceContent) !== sample.split) throw new Error('Source content leaks across splits.');
      windows.set(sourceContent, sample.split);
    }
    return { ...sample, input };
  });
  for (const split of ['development', 'validation']) for (const assessment of ['same_object', 'different_objects', 'insufficient_evidence']) {
    if (!cases.some(sample => sample.split === split && sample.expectedAssessment === assessment)) throw new Error('Each split needs all three assessments.');
  }
  return { ...parsed, cases };
}

/** Reference decisions, split/group labels and review checks never enter the executor payload. */
export const entityLinkReviewInput = (sample: Pick<EntityLinkReviewCase, 'input'>) => sample.input;
