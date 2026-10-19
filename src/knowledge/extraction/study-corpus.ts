import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../store.js';
import { EvidenceWindowSchema } from './evidence.js';
import { locateQuoteOccurrence, QuoteOccurrenceLocatorSchema } from './quote-occurrence.js';

const text = z.string().trim().min(1).max(8192);
const id = z.string().trim().min(1).max(256);
export const ExtractionStudyDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const extractionStudyDigest = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const description = { referenceId: id, description: text, equivalentExpressions: z.array(text).min(1) };
const locator = QuoteOccurrenceLocatorSchema.strict();
export const ExtractionStudyReferenceSchema = z.strictObject({
  annotationScope: z.enum(['full', 'critical_only', 'unannotated']),
  entities: z.array(z.strictObject({ ...description, locators: z.array(locator).min(1) })),
  mentions: z.array(z.strictObject({ ...description, entityReferenceId: id, locators: z.array(locator).min(1) })),
  knowledge: z.array(z.strictObject({ ...description, coverage: z.enum(['required', 'if_selected']), locators: z.array(locator).min(1) })),
  semanticChecks: z.array(z.strictObject({ checkId: id, description: text })),
});
export const ExtractionStudyCaseSchema = z.strictObject({
  caseId: id, split: z.enum(['development', 'validation']), exposure: z.enum(['unseen', 'seen']),
  projectGroup: id, conversationGroup: id, lineageGroup: id, ancestorLineageIds: z.array(id), stratumId: id,
  originDigest: ExtractionStudyDigestSchema, transformation: text,
  sourceRecords: z.array(z.strictObject({ recordIndex: z.number().int().nonnegative(), recordId: id, originalDigest: ExtractionStudyDigestSchema })).min(1),
  window: EvidenceWindowSchema,
  reference: ExtractionStudyReferenceSchema,
});
const corpusBody = z.strictObject({
  corpusVersion: z.literal('omk-extraction-study-corpus/v1'), sourceKind: z.enum(['private-real', 'public-redacted-real']),
  authors: z.array(id).min(1), cases: z.array(ExtractionStudyCaseSchema).min(1),
});
export const ExtractionStudyCorpusSchema = corpusBody.extend({ corpusDigest: ExtractionStudyDigestSchema });
export type ExtractionStudyCase = z.infer<typeof ExtractionStudyCaseSchema>;
export type ExtractionStudyCorpus = z.infer<typeof ExtractionStudyCorpusSchema>;

/** A digest binds declarations and source bytes; it does not authenticate provenance or semantic truth. */
export function freezeExtractionStudyCorpus(input: unknown): ExtractionStudyCorpus {
  const body = corpusBody.parse(input);
  validateCorpus(body);
  return { ...body, corpusDigest: extractionStudyDigest(body) };
}
export function parseExtractionStudyCorpus(input: unknown): ExtractionStudyCorpus {
  const { corpusDigest, ...body } = ExtractionStudyCorpusSchema.parse(input);
  const corpus = freezeExtractionStudyCorpus(body);
  if (corpusDigest !== corpus.corpusDigest) throw new Error('Study corpus identity mismatch.');
  return corpus;
}

function validateCorpus(corpus: z.infer<typeof corpusBody>) {
  const unique = (values: readonly unknown[], diagnostic: string) => {
    if (new Set(values).size !== values.length) throw new Error(diagnostic);
  };
  unique(corpus.authors.map(value => value.toLowerCase()), 'Duplicate study author.');
  unique(corpus.cases.map(value => value.caseId), 'Duplicate study case.');
  const groups = new Map<string, string>(), windows = new Set<string>();
  for (const sample of corpus.cases) {
    if (sample.split === 'validation' && sample.exposure !== 'unseen') throw new Error('Seen sources cannot be validation evidence.');
    unique(sample.ancestorLineageIds, 'Duplicate study lineage ancestor.');
    const groupKeys = [`project:${sample.projectGroup}`, `conversation:${sample.conversationGroup}`,
      ...[sample.lineageGroup, ...sample.ancestorLineageIds].map(value => `lineage:${value}`), `origin:${sample.originDigest}`,
      ...sample.sourceRecords.flatMap(value => [`record:${value.recordId}`, `original:${value.originalDigest}`])];
    for (const key of groupKeys) {
      if (groups.has(key) && groups.get(key) !== sample.split) throw new Error('Study source or lineage leaks across splits.');
      groups.set(key, sample.split);
    }
    const window = sample.window;
    const contentDigest = extractionStudyDigest(window.excerpts.map(({ eventKind, role, text: value }) => ({ eventKind, role: role ?? null, text: value })));
    if (windows.has(contentDigest)) throw new Error('Duplicate study source text.');
    windows.add(contentDigest);
    unique(window.records.map(value => value.recordIndex), 'Duplicate study source record index.');
    unique(window.excerpts.map(value => value.evidenceRef), 'Duplicate study evidence reference.');
    unique(sample.sourceRecords.map(value => value.recordId), 'Duplicate study original record.');
    unique(sample.sourceRecords.map(value => value.recordIndex), 'Duplicate study original record index.');
    if (!window.excerpts.length || window.startRecord > window.endRecord
      || window.records.some(value => value.recordIndex < window.startRecord || value.recordIndex > window.endRecord)
      || sample.sourceRecords.length !== window.records.length
      || sample.sourceRecords.some(value => !window.records.some(record => record.recordIndex === value.recordIndex))
      || window.excerpts.some(value => !window.records.some(record => record.recordIndex === value.recordIndex))) {
      throw new Error('Study source records do not match the frozen evidence window.');
    }
    const reference = sample.reference;
    if (reference.annotationScope === 'unannotated' && (reference.entities.length || reference.mentions.length || reference.knowledge.length)) {
      throw new Error('Unannotated study source cannot declare reference answers.');
    }
    unique([...reference.entities, ...reference.mentions, ...reference.knowledge].map(value => value.referenceId), 'Duplicate study reference identity.');
    unique(reference.semanticChecks.map(value => value.checkId), 'Duplicate study semantic check.');
    for (const mention of reference.mentions) if (!reference.entities.some(value => value.referenceId === mention.entityReferenceId)) {
      throw new Error('Study mention references an unknown entity.');
    }
    const locators = [...reference.entities.flatMap(value => value.locators), ...reference.mentions.flatMap(value => value.locators), ...reference.knowledge.flatMap(value => value.locators)];
    for (const value of locators) if (typeof locateQuoteOccurrence(value, window.excerpts) === 'string') throw new Error('Study reference quote is not exact.');
    unique(reference.mentions.flatMap(value => value.locators.map(selected => canonicalJson(locateQuoteOccurrence(selected, window.excerpts)))), 'Duplicate study reference mention position.');
    if (reference.entities.some(value => !reference.mentions.some(mention => mention.entityReferenceId === value.referenceId))) {
      throw new Error('Study reference entity has no mention.');
    }
  }
}

/** Unsigned and deliberately invalid until a reviewer supplies identity, time and judgments. */
export function createExtractionStudyReferenceTemplate(corpusInput: unknown, reviewRole: 'author' | 'independent' = 'independent') {
  const corpus = parseExtractionStudyCorpus(corpusInput);
  return { reviewVersion: 'omk-extraction-study-reference-review/v1' as const, corpusDigest: corpus.corpusDigest,
    reviewer: { actorKind: 'human' as const, actorId: '' }, reviewRole,
    independentHuman: false, reviewedBeforeOutputs: false, reviewedAt: '',
    decisions: corpus.cases.map(sample => ({ caseId: sample.caseId, verdict: 'uncertain' as const, rationale: '' })), disputes: [] };
}
