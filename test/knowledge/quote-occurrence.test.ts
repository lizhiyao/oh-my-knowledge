import { describe, expect, it } from 'vitest';
import { locateQuoteOccurrence } from '../../src/observability/knowledge-extraction/quote-occurrence.js';

const excerpts = [{ evidenceRef: 'r', text: '😀 Echo 调用 Echo，前者是服务，后者是工具。' }];
const quote = { evidenceRef: 'r', quote: 'Echo' };

describe('exact quote occurrence', () => {
  it('distinguishes same-named objects without generating adjacent context or character offsets', () => {
    expect(locateQuoteOccurrence({ ...quote, occurrence: 0 }, excerpts)).toEqual({ ...quote, start: 3, end: 7 });
    expect(locateQuoteOccurrence({ ...quote, occurrence: 1 }, excerpts)).toEqual({ ...quote, start: 11, end: 15 });
    expect(locateQuoteOccurrence(quote, excerpts)).toBe('ambiguous_quote');
    expect(locateQuoteOccurrence({ ...quote, occurrence: 2 }, excerpts)).toBe('quote_occurrence_out_of_range');
  });
  it('accepts a unique quote and counts overlapping exact occurrences', () => {
    expect(locateQuoteOccurrence({ evidenceRef: 'r', quote: '前者是服务' }, excerpts)).toEqual({ evidenceRef: 'r', quote: '前者是服务', start: 16, end: 21 });
    const overlapping = [{ evidenceRef: 'r', text: 'aaaa' }];
    expect(locateQuoteOccurrence({ evidenceRef: 'r', quote: 'aaa' }, overlapping)).toBe('ambiguous_quote');
    expect(locateQuoteOccurrence({ evidenceRef: 'r', quote: 'aaa', occurrence: 1 }, overlapping)).toEqual({ evidenceRef: 'r', quote: 'aaa', start: 1, end: 4 });
  });
  it('rejects missing or duplicated sources, nonexact text, offsets, and old selectors', () => {
    expect(locateQuoteOccurrence({ ...quote, evidenceRef: 'outside' }, excerpts)).toBe('unknown_evidence');
    expect(locateQuoteOccurrence(quote, [...excerpts, ...excerpts])).toBe('unknown_evidence');
    expect(locateQuoteOccurrence({ ...quote, quote: 'ECHO' }, excerpts)).toBe('quote_mismatch');
    for (const extra of [{ start: 3 }, { prefix: '😀 ' }, { suffix: '，后者' }, { occurrence: -1 }, { occurrence: 1.5 }]) {
      expect(locateQuoteOccurrence({ ...quote, ...extra }, excerpts)).toBe('invalid_quote_locator');
    }
  });
});
