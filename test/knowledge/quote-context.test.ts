import { describe, expect, it } from 'vitest';
import { locateQuoteContext, QuoteContextLocatorSchema, type QuoteContextLocator } from '../../src/knowledge/extraction/quote-context.js';

const locator = { evidenceRef: 'r', quote: '0.165.0', contextBefore: null, contextAfter: null };

describe('exact adjacent quote context', () => {
  it('distinguishes SDK and CLI versions through exact adjacent context without model offsets or ordinals', () => {
    const excerpts = [{ evidenceRef: 'r', text: 'SDK 0.165.0，CLI 0.165.0。' }];
    expect(locateQuoteContext(locator, excerpts)).toBe('ambiguous_quote');
    expect(locateQuoteContext({ ...locator, contextBefore: 'CLI ', contextAfter: '。' }, excerpts))
      .toEqual({ evidenceRef: 'r', quote: '0.165.0', start: 16, end: 23 });
    expect(locateQuoteContext({ ...locator, contextBefore: 'SDK ', contextAfter: '，' }, excerpts))
      .toEqual({ evidenceRef: 'r', quote: '0.165.0', start: 4, end: 11 });
  });

  it('accepts unique quotes with null or empty context and rejects a contradictory context', () => {
    const excerpts = [{ evidenceRef: 'r', text: 'Alpha at the beginning and Beta at the end' }];
    const quote = { ...locator, quote: 'Alpha' };
    for (const context of [{ contextBefore: null, contextAfter: null }, { contextBefore: '', contextAfter: '' }]) {
      expect(locateQuoteContext({ ...quote, ...context }, excerpts)).toEqual({ evidenceRef: 'r', quote: 'Alpha', start: 0, end: 5 });
    }
    expect(locateQuoteContext({ ...quote, contextBefore: 'Alpha' }, excerpts)).toBe('quote_context_mismatch');
    expect(locateQuoteContext({ ...locator, quote: 'end', contextAfter: 'end' }, excerpts)).toBe('quote_context_mismatch');
    expect(locateQuoteContext({ ...quote, contextAfter: ' next' }, excerpts)).toBe('quote_context_mismatch');
  });

  it('counts overlapping contextual matches and can select an overlapping quote', () => {
    const overlapping = [{ evidenceRef: 'r', text: 'aaaa' }], quote = { ...locator, quote: 'aaa' };
    expect(locateQuoteContext(quote, overlapping)).toBe('ambiguous_quote');
    expect(locateQuoteContext({ ...quote, contextBefore: 'a' }, overlapping)).toEqual({ evidenceRef: 'r', quote: 'aaa', start: 1, end: 4 });
    expect(locateQuoteContext({ ...quote, contextAfter: 'a' }, overlapping)).toEqual({ evidenceRef: 'r', quote: 'aaa', start: 0, end: 3 });
    expect(locateQuoteContext({ ...quote, contextBefore: 'a', contextAfter: 'a' }, [{ evidenceRef: 'r', text: 'aaaaaa' }])).toBe('ambiguous_quote');
  });

  it('requires literal adjacency instead of distant matching context', () => {
    const excerpts = [{ evidenceRef: 'r', text: 'before unrelated Alpha unrelated after' }], quote = { ...locator, quote: 'Alpha' };
    expect(locateQuoteContext({ ...quote, contextBefore: 'before ' }, excerpts)).toBe('quote_context_mismatch');
    expect(locateQuoteContext({ ...quote, contextAfter: ' after' }, excerpts)).toBe('quote_context_mismatch');
    expect(locateQuoteContext({ ...quote, contextBefore: 'unrelated ', contextAfter: ' unrelated' }, excerpts))
      .toEqual({ evidenceRef: 'r', quote: 'Alpha', start: 17, end: 22 });
  });

  it('preserves Unicode, whitespace and host UTF-16 positions exactly', () => {
    const excerpts = [{ evidenceRef: 'r', text: '😀\tCafe\u0301\r\nEcho\u00a0Echo。' }];
    expect(locateQuoteContext({ ...locator, quote: 'Echo', contextBefore: '\u00a0', contextAfter: '。' }, excerpts))
      .toEqual({ evidenceRef: 'r', quote: 'Echo', start: 15, end: 19 });
    expect(locateQuoteContext({ ...locator, quote: 'Cafe\u0301\r\n' }, excerpts))
      .toEqual({ evidenceRef: 'r', quote: 'Cafe\u0301\r\n', start: 3, end: 10 });
    expect(locateQuoteContext({ ...locator, quote: 'Café' }, excerpts)).toBe('quote_mismatch');
    expect(locateQuoteContext({ ...locator, quote: 'ECHO' }, excerpts)).toBe('quote_mismatch');
    expect(locateQuoteContext({ ...locator, quote: 'Cafe\u0301', contextAfter: '\n' }, excerpts)).toBe('quote_context_mismatch');
    expect(locateQuoteContext({ ...locator, quote: 'Echo', contextBefore: ' ', contextAfter: '。' }, excerpts)).toBe('quote_context_mismatch');
  });

  it('refuses missing or duplicate evidence references without searching another excerpt', () => {
    const quote = { ...locator, quote: 'Alpha' }, excerpt = { evidenceRef: 'r', text: 'Alpha' };
    expect(locateQuoteContext(quote, [])).toBe('unknown_evidence');
    expect(locateQuoteContext({ ...quote, evidenceRef: 'other' }, [excerpt])).toBe('unknown_evidence');
    expect(locateQuoteContext(quote, [excerpt, { evidenceRef: 'r', text: 'Beta' }])).toBe('unknown_evidence');
    expect(locateQuoteContext(quote, [{ evidenceRef: 'r', text: 'Beta' }, { evidenceRef: 'other', text: 'Alpha' }])).toBe('quote_mismatch');
  });

  it('rejects malformed selectors, numeric ordinals and offsets while enforcing bounded literal strings', () => {
    const excerpts = [{ evidenceRef: 'r', text: 'Alpha' }], valid = { ...locator, quote: 'Alpha' };
    const malformed: unknown[] = [null, undefined, [], { ...valid, contextBefore: undefined }, { ...valid, contextAfter: 1 },
      { ...valid, evidenceRef: '' }, { ...valid, quote: '' }, { ...valid, occurrence: 0 }, { ...valid, start: 0 }, { ...valid, end: 5 },
      { ...valid, prefix: '' }, { ...valid, contextBefore: 'x'.repeat(32_769) }, { ...valid, contextAfter: 'x'.repeat(32_769) },
      { ...valid, evidenceRef: 'r'.repeat(257) }, { ...valid, quote: 'x'.repeat(32_769) }];
    for (const value of malformed) expect(locateQuoteContext(value as QuoteContextLocator, excerpts)).toBe('invalid_quote_locator');
    expect(QuoteContextLocatorSchema.safeParse({ evidenceRef: 'r'.repeat(256), quote: 'q'.repeat(32_768),
      contextBefore: 'b'.repeat(32_768), contextAfter: 'a'.repeat(32_768) }).success).toBe(true);
  });
});
