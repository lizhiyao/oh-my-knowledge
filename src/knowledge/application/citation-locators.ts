import { z } from 'zod';
import { KnowledgeEvidenceLinkSchema, type EvidenceExcerpt } from '../contracts.js';
import { locateQuoteOccurrence, QuoteOccurrenceLocatorSchema } from '../extraction/quote-occurrence.js';
import type { KnowledgeGrounding } from '../store.js';

/** Explicit replacement citations for a new revision; offsets remain host-owned. */
export const KnowledgeCitationLocatorSchema = z.strictObject({
  evidenceLinkId: KnowledgeEvidenceLinkSchema.shape.evidenceLinkId,
  selection: QuoteOccurrenceLocatorSchema,
});
export const KnowledgeCitationLocatorsSchema = z.array(KnowledgeCitationLocatorSchema).min(1).max(512);
export type KnowledgeCitationLocator = z.infer<typeof KnowledgeCitationLocatorSchema>;

/** Hosts expose only the failure code, never source text or arbitrary exception details. */
export class KnowledgeCitationRevisionError extends Error {
  constructor() { super('Knowledge citations invalid.'); this.name = 'KnowledgeCitationRevisionError'; }
}

export function resolveKnowledgeCitationLocators(input: unknown,
  excerpts: readonly EvidenceExcerpt[]): KnowledgeGrounding['citations'] {
  const parsed = KnowledgeCitationLocatorsSchema.safeParse(input);
  if (!parsed.success) throw new KnowledgeCitationRevisionError();
  return parsed.data.map(locator => {
    const selection = locateQuoteOccurrence(locator.selection, excerpts);
    if (typeof selection === 'string') throw new KnowledgeCitationRevisionError();
    return { evidenceLinkId: locator.evidenceLinkId, selection };
  });
}
