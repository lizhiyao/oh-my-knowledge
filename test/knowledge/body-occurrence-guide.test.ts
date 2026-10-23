import { describe, expect, it } from 'vitest';
import {
  BODY_OCCURRENCE_GUIDE_LIMITS, buildBodyOccurrenceGuide,
  type BodyOccurrenceGuidePosition, type BodyOccurrenceGuideResult, type BodyOccurrenceGuideSource,
} from '../../src/knowledge/extraction/body-occurrence-guide.js';
import { locateQuoteOccurrence } from '../../src/knowledge/extraction/quote-occurrence.js';

type Ready = Extract<BodyOccurrenceGuideResult, { status: 'ready' }>;
type Refused = Extract<BodyOccurrenceGuideResult, { status: 'refused' }>;
const body = (text: string, evidenceRef = 'r'): BodyOccurrenceGuideSource => ({ evidenceRef, eventKind: 'github_issue_body', text });

function bounded(result: BodyOccurrenceGuideResult) {
  expect(result.work.used).toBeLessThanOrEqual(result.work.budget);
  expect(result.highWater.candidates).toBeLessThanOrEqual(BODY_OCCURRENCE_GUIDE_LIMITS.candidates);
  expect(result.highWater.rows).toBeLessThanOrEqual(BODY_OCCURRENCE_GUIDE_LIMITS.rows);
  expect(result.highWater.positions).toBeLessThanOrEqual(BODY_OCCURRENCE_GUIDE_LIMITS.positions);
  expect(result.highWater.acceptedSourceTextCodeUnits).toBeLessThanOrEqual(BODY_OCCURRENCE_GUIDE_LIMITS.sourceTextCodeUnits);
  expect(result.highWater.outputUtf8Bytes).toBeLessThanOrEqual(BODY_OCCURRENCE_GUIDE_LIMITS.guideUtf8Bytes);
  expect(result.highWater.intervals).toBeLessThanOrEqual(result.highWater.positions);
  expect(result.highWater.panelRanges).toBeLessThanOrEqual(result.highWater.positions);
}
function ready(result: BodyOccurrenceGuideResult): Ready {
  bounded(result);
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(`Unexpected guide refusal: ${result.reason}`);
  expect(result.guide.guideKind).toBe('knowledge-body-occurrence-guide/v1');
  expect(JSON.parse(result.serializedGuide)).toEqual(result.guide);
  expect(Buffer.byteLength(result.serializedGuide, 'utf8')).toBe(result.highWater.outputUtf8Bytes);
  expect(result.countsAreComplete).toBe(true);
  return result;
}
function refused(result: BodyOccurrenceGuideResult, reason: Refused['reason']): Refused {
  bounded(result);
  expect(result).toMatchObject({ status: 'refused', reason, guide: null, serializedGuide: null, countsAreComplete: false });
  if (result.status !== 'refused') throw new Error('Expected whole-guide refusal.');
  return result;
}
function positions(result: Ready, evidenceRef: string, quote: string): BodyOccurrenceGuidePosition[] {
  return result.guide.groups.filter(group => group.evidenceRef === evidenceRef)
    .flatMap(group => group.panels.flatMap(panel => panel.terms.filter(term => term[0] === quote).flatMap(term => term[1])))
    .sort((a, b) => a[0] - b[0]);
}
/** Check the public locator and original text, without implementing guide nomination again. */
function exactContexts(result: Ready, excerpts: readonly BodyOccurrenceGuideSource[]) {
  const seen = new Set<string>();
  for (const group of result.guide.groups) {
    const source = excerpts.find(excerpt => excerpt.evidenceRef === group.evidenceRef)!;
    for (const panel of group.panels) {
      expect(panel.text).toBe(source.text.slice(panel.start, panel.end));
      for (const [quote, occurrences] of panel.terms) for (const [ordinal, start, end] of occurrences) {
        const key = JSON.stringify([group.evidenceRef, quote, ordinal]);
        expect(seen.has(key)).toBe(false); seen.add(key);
        expect(locateQuoteOccurrence({ evidenceRef: group.evidenceRef, quote, occurrence: ordinal }, excerpts))
          .toEqual({ evidenceRef: group.evidenceRef, quote, start, end });
        const left = Math.max(0, start - 24), right = Math.min(source.text.length, end + 24);
        expect(panel.start).toBeLessThanOrEqual(left); expect(panel.end).toBeGreaterThanOrEqual(right);
        expect(panel.text.slice(left - panel.start, start - panel.start)).toBe(source.text.slice(left, start));
        expect(panel.text.slice(end - panel.start, right - panel.start)).toBe(source.text.slice(end, right));
      }
    }
  }
}

describe('body occurrence guide (pure deterministic research input, not entity quality)', () => {
  it('preserves UTF-16, overlapping matches and matches inside longer identifiers with exact ordinals', () => {
    const excerpts = [body('😀 it github it', 'emoji'), body('aba ababa', 'overlap')];
    const result = ready(buildBodyOccurrenceGuide(excerpts));
    expect(positions(result, 'emoji', 'it')).toEqual([[0, 3, 5], [1, 7, 9], [2, 13, 15]]);
    expect(positions(result, 'overlap', 'aba')).toEqual([[0, 0, 3], [1, 4, 7], [2, 6, 9]]);
    expect(locateQuoteOccurrence({ evidenceRef: 'emoji', quote: 'it' }, excerpts)).toBe('ambiguous_quote');
    exactContexts(result, excerpts);
  });

  it('keeps source inputs intact, excludes metadata text and leaves unlisted unique quotes locatable', () => {
    const excerpts = Object.freeze([
      Object.freeze({ ...body('Echo Echo', 'metadata'), eventKind: 'github_public_message_metadata' }),
      Object.freeze(body('Echo Solo', 'unique')),
      Object.freeze({ ...body('Echo Echo', 'comment'), eventKind: 'github_issue_comment_body' }),
    ]);
    const before = structuredClone(excerpts), result = ready(buildBodyOccurrenceGuide(excerpts));
    expect(excerpts).toEqual(before);
    expect(result.guide.groups.map(group => [group.evidenceRef, group.eventKind])).toEqual([
      ['unique', 'github_issue_body'], ['comment', 'github_issue_comment_body'],
    ]);
    expect(result.guide.groups[0].panels).toEqual([]);
    expect(positions(result, 'comment', 'Echo')).toEqual([[0, 0, 4], [1, 5, 9]]);
    expect(locateQuoteOccurrence({ evidenceRef: 'unique', quote: 'Solo' }, excerpts)).toMatchObject({ start: 5, end: 9 });
    exactContexts(result, excerpts);
  });

  it('nominates only complete runs of length 2..64, without cutting long or invalid-prefix tokens', () => {
    const skipped = ready(buildBodyOccurrenceGuide([body(`${'L'.repeat(65)} ${'L'.repeat(65)} 7alpha 7alpha --flag --flag`)]));
    expect(skipped.highWater.candidates).toBe(0); expect(skipped.guide.groups[0].panels).toEqual([]);
    const quote = 'A'.repeat(64), excerpts = [body(`${quote} ${'A'.repeat(65)}`)];
    const accepted = ready(buildBodyOccurrenceGuide(excerpts));
    expect(positions(accepted, 'r', quote)).toEqual([[0, 0, 64], [1, 65, 129], [2, 66, 130]]);
    exactContexts(accepted, excerpts);
  });

  it.each([[47, 2], [46, 1], [45, 1]])('unions only touching or overlapping context intervals (gap filler %i)', (filler, panels) => {
    const excerpts = [body(`Echo ${'x'.repeat(filler)} Echo`)];
    const result = ready(buildBodyOccurrenceGuide(excerpts));
    expect(result.guide.groups[0].panels).toHaveLength(panels);
    expect(positions(result, 'r', 'Echo')).toHaveLength(2);
    if (panels === 1) expect(result.guide.groups[0].panels[0]).toMatchObject({ start: 0, end: excerpts[0].text.length, text: excerpts[0].text });
    exactContexts(result, excerpts);
  });

  it('round-trips literal escaped text and reconstructs code-unit contexts cut at surrogate boundaries', () => {
    const excerpts = [body(`😀${'x'.repeat(22)} it it`, 'left'), body(`it ${'x'.repeat(22)}😀 it`, 'right'), body('Echo "😀"\\\nEcho', 'escaped')];
    const result = ready(buildBodyOccurrenceGuide(excerpts));
    expect(result.guide.groups[0].panels[0].text.charCodeAt(0)).toBe(0xde00);
    exactContexts(result, excerpts);
  });

  it('uses the lower-only work budget exactly and shares it across the entire selected window', () => {
    const first = [body('Echo Echo')], second = [body('Beta Beta', 'other')];
    const a = ready(buildBodyOccurrenceGuide(first)), b = ready(buildBodyOccurrenceGuide(second));
    const exact = ready(buildBodyOccurrenceGuide(first, { workBudget: a.work.used }));
    expect(exact.work.used).toBe(a.work.used);
    refused(buildBodyOccurrenceGuide(first, { workBudget: a.work.used - 1 }), 'work_budget');
    refused(buildBodyOccurrenceGuide([...first, ...second], { workBudget: Math.max(a.work.used, b.work.used) }), 'work_budget');
    refused(buildBodyOccurrenceGuide(first, { workBudget: 0 }), 'work_budget');
  });

  it('bounds nominations before matching a window containing more than 512 unique tokens', () => {
    const text = Array.from({ length: 513 }, (_, i) => `u${String(i).padStart(3, '0')}`).join(' ');
    const result = refused(buildBodyOccurrenceGuide([body(text)]), 'max_candidates');
    expect(result.highWater).toMatchObject({ candidates: 512, rows: 0, positions: 0 });
    expect(result.observed.candidatePairsAtLeast).toBe(513);
  });

  it('bounds rows and positions across the whole window before allocating the next item', () => {
    const tokens = Array.from({ length: 257 }, (_, i) => `k${String(i).padStart(3, '0')}`).join(' ');
    const rows = refused(buildBodyOccurrenceGuide([body(`${tokens}\n${tokens}`)]), 'max_rows');
    expect(rows.highWater.rows).toBe(256);
    const half = Array.from({ length: 129 }, (_, i) => `k${String(i).padStart(3, '0')}`).join(' ');
    const shared = refused(buildBodyOccurrenceGuide([body(`${half}\n${half}`, 'one'), body(`${half}\n${half}`, 'two')]), 'max_rows');
    expect(shared.highWater.rows).toBe(256);
    const matches = refused(buildBodyOccurrenceGuide([body(`aa ${'a'.repeat(4097)}`)]), 'max_positions');
    expect(matches.highWater.positions).toBe(4096);
  });

  it('rejects byte overflow without publishing the accumulated prefix or claiming a complete table', () => {
    const result = refused(buildBodyOccurrenceGuide([body('Echo '.repeat(3000))]), 'guide_utf8_bytes');
    expect(result.highWater).toMatchObject({ rows: 1, positions: 3000 });
    expect(result.highWater.outputUtf8Bytes).toBeGreaterThan(0);
    expect(result.countsAreComplete).toBe(false);
  });

  it.each([
    ['non-array', (): null => null, 'invalid_excerpts'],
    ['missing reference', () => [{ eventKind: 'github_issue_body', text: 'Echo Echo' }], 'invalid_excerpt'],
    ['duplicate reference', () => [body('Echo Echo'), body('Beta Beta')], 'duplicate_evidence_ref'],
    ['invalid source Unicode', () => [body('Echo \ud800 Echo')], 'invalid_source_unicode'],
    ['huge reference', () => [body('Echo Echo', 'r'.repeat(65537))], 'reference_too_large'],
    ['huge source', () => [body('x'.repeat(1048577))], 'source_text_code_units'],
    ['1025 excerpts', () => Array.from({ length: 1025 }, (_, i) => body('A', `r${i}`)), 'max_excerpts'],
  ] as const)('refuses invalid input before guide publication: %s', (_name, input, reason) => {
    const result = refused(buildBodyOccurrenceGuide(input() as unknown as BodyOccurrenceGuideSource[]), reason);
    expect(result.highWater.outputUtf8Bytes).toBe(0);
    expect(result.highWater.panelLiteralTempCodeUnits).toBe(0);
  });

  it('rejects invalid or higher work budgets instead of expanding the fixed algorithm envelope', () => {
    for (const workBudget of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, BODY_OCCURRENCE_GUIDE_LIMITS.work + 1]) {
      expect(() => buildBodyOccurrenceGuide([body('Echo Echo')], { workBudget })).toThrow(/work budget/);
    }
  });
});
