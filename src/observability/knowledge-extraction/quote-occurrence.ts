import { z } from 'zod';
import { EvidenceSelectionSchema, type EvidenceExcerpt, type EvidenceSelection } from '../../knowledge/contracts.js';

export const QuoteOccurrenceLocatorSchema = EvidenceSelectionSchema.omit({ start: true, end: true }).extend({
  occurrence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** Exact zero-based occurrence, including overlaps. An omitted index never chooses among repeats. */
export function locateQuoteOccurrence(locator: z.infer<typeof QuoteOccurrenceLocatorSchema>,
  excerpts: readonly EvidenceExcerpt[]): EvidenceSelection | string {
  const parsed = QuoteOccurrenceLocatorSchema.safeParse(locator);
  if (!parsed.success) return 'invalid_quote_locator';
  const matches = excerpts.filter(excerpt => excerpt.evidenceRef === parsed.data.evidenceRef);
  if (matches.length !== 1) return 'unknown_evidence';
  const { quote, occurrence } = parsed.data;
  const source = matches[0].text;
  let position = source.indexOf(quote);
  if (position < 0) return 'quote_mismatch';
  if (occurrence === undefined) {
    if (source.indexOf(quote, position + 1) >= 0) return 'ambiguous_quote';
  } else {
    for (let index = 0; index < occurrence; index += 1) {
      position = source.indexOf(quote, position + 1);
      if (position < 0) return 'quote_occurrence_out_of_range';
    }
  }
  return { evidenceRef: locator.evidenceRef, quote, start: position, end: position + quote.length };
}
