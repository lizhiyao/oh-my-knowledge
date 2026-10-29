import { z } from 'zod';
import type { EvidenceExcerpt, EvidenceSelection } from '../contracts.js';

export const QuoteContextLocatorSchema = z.strictObject({
  evidenceRef: z.string().min(1).max(256),
  quote: z.string().min(1).max(32_768),
  contextBefore: z.string().max(32_768).nullable(),
  contextAfter: z.string().max(32_768).nullable(),
});
export type QuoteContextLocator = z.infer<typeof QuoteContextLocatorSchema>;

/** Exact adjacent context selects one quote; positions remain host-owned UTF-16 offsets. */
export function locateQuoteContext(locator: QuoteContextLocator, excerpts: readonly EvidenceExcerpt[]): EvidenceSelection | string {
  const parsed = QuoteContextLocatorSchema.safeParse(locator);
  if (!parsed.success) return 'invalid_quote_locator';
  let excerpt: EvidenceExcerpt | undefined;
  for (const candidate of excerpts) if (candidate.evidenceRef === parsed.data.evidenceRef) {
    if (excerpt) return 'unknown_evidence';
    excerpt = candidate;
  }
  if (!excerpt) return 'unknown_evidence';

  const { evidenceRef, quote, contextBefore, contextAfter } = parsed.data;
  const before = contextBefore ?? '', after = contextAfter ?? '';
  // The bounded literal needle enforces adjacency without copying the source per candidate.
  const needle = before + quote + after, first = excerpt.text.indexOf(needle);
  if (first < 0) return excerpt.text.indexOf(quote) < 0 ? 'quote_mismatch' : 'quote_context_mismatch';
  // Advancing one code unit includes overlapping matches, just as it does for quote candidates.
  if (excerpt.text.indexOf(needle, first + 1) >= 0) return 'ambiguous_quote';
  const start = first + before.length;
  return { evidenceRef, quote, start, end: start + quote.length };
}
