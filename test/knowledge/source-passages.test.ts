import { describe, expect, it } from 'vitest';
import { buildSourcePassages, SOURCE_PASSAGE_POLICY, selectSourcePassages, sourcePassageText,
  assertSourcePassageInput } from '../../src/knowledge/extraction/source-passages.js';

const source = { snapshotId: '00000000-0000-4000-8000-000000000001', sourceVersion: `sha256:${'a'.repeat(64)}` };
const unit = (text: string, unitKey = 'excerpt') => ({ unitKey, source, text });

describe('host-owned source passage references', () => {
  it('delivers every Unicode/CRLF code unit without splitting either pair or exposing offsets', () => {
    const text = 'a'.repeat(255) + '🙂\r\n' + '中文\r\n'.repeat(110), index = buildSourcePassages([unit(text)]);
    const parts = index.passages.get('excerpt')!;
    expect(parts.map(part => part.text).join('')).toBe(text);
    for (const [i, part] of parts.entries()) {
      expect(Object.keys(part)).toEqual(['passageId', 'text']);
      expect(part.text.length).toBeLessThanOrEqual(256);
      expect(Buffer.from(part.text).toString('utf8')).toBe(part.text);
      expect(part.text.endsWith('\r') && parts[i + 1]?.text.startsWith('\n')).not.toBe(true);
    }
    expect(sourcePassageText(parts)).toBe(text);
  });

  it('binds duplicate text to different exact host positions and rejects forged or cross-unit references', () => {
    const text = 'x'.repeat(512), index = buildSourcePassages([unit(text), unit('other', 'other')]);
    const first = selectSourcePassages(index, { startPassageId: 'p0', endPassageId: 'p0' });
    const second = selectSourcePassages(index, { startPassageId: 'p1', endPassageId: 'p1' });
    expect(first.selections[0]).toEqual({ evidenceRef: 'excerpt', start: 0, end: 256, quote: 'x'.repeat(256) });
    expect(second.selections[0]).toEqual({ evidenceRef: 'excerpt', start: 256, end: 512, quote: 'x'.repeat(256) });
    expect(second.source).toEqual(source);
    expect(() => selectSourcePassages(index, { startPassageId: 'missing', endPassageId: 'p0' })).toThrow('Unknown source passage');
    expect(() => selectSourcePassages(index, { startPassageId: 'p0', endPassageId: 'p2' })).toThrow('Cross-unit');
    expect(() => selectSourcePassages(index, { startPassageId: 'p1', endPassageId: 'p0' })).toThrow('Reversed');
    expect(() => buildSourcePassages([unit('one'), unit('two')])).toThrow('Duplicate');
  });

  it('splits a long ledger range into bounded adjacent quotes without changing its selected union', () => {
    const text = '原文🙂\r\n'.repeat(6000), index = buildSourcePassages([unit(text)]), last = [...index.entries.keys()].at(-1)!;
    const range = { startPassageId: 'p0', endPassageId: last };
    expect(() => selectSourcePassages(index, range)).toThrow('quotation capacity');
    const { selections } = selectSourcePassages(index, range, true);
    expect(selections.length).toBeGreaterThan(1);
    expect(selections.map(selection => selection.quote).join('')).toBe(text);
    expect(selections[0].start).toBe(0);
    expect(selections.at(-1)!.end).toBe(text.length);
    for (const [i, selection] of selections.entries()) {
      expect(selection.quote.length).toBeLessThanOrEqual(32768);
      expect(selection.quote).toBe(text.slice(selection.start, selection.end));
      if (i) expect(selection.start).toBe(selections[i - 1].end);
    }
  });

  it('rejects substituted partitions, policy/index drift, extra model offsets and excessive input', () => {
    const index = buildSourcePassages([unit('source')]);
    const supplied = [{ unitKey: 'excerpt', passages: index.passages.get('excerpt')! }];
    const header = { passagePolicy: SOURCE_PASSAGE_POLICY.policyVersion, passageIndexDigest: index.digest };
    expect(() => assertSourcePassageInput(index, header, supplied)).not.toThrow();
    expect(() => assertSourcePassageInput(index, { ...header, passageIndexDigest: 'wrong' }, supplied)).toThrow('identity mismatch');
    expect(() => assertSourcePassageInput(index, header, [{ unitKey: 'excerpt', passages: [{ passageId: 'p1', text: 'source' }] }])).toThrow('identity mismatch');
    expect(() => sourcePassageText([{ passageId: 'p0', text: 'source', start: 0 }])).toThrow();
    expect(() => buildSourcePassages([unit('x'.repeat(1024 * 1024 + 1))])).toThrow('capacity_exceeded');
    expect(() => buildSourcePassages([unit('\ud800')])).toThrow('Unicode');
    expect(buildSourcePassages([unit('changed')]).digest).not.toBe(index.digest);
    expect(buildSourcePassages([{ ...unit('source'), source: { ...source, sourceVersion: `sha256:${'b'.repeat(64)}` } }]).digest).not.toBe(index.digest);
    const empty = buildSourcePassages([], [source]);
    expect(empty.entries.size).toBe(0);
    expect(buildSourcePassages([], [{ ...source, snapshotId: '00000000-0000-4000-8000-000000000002' }]).digest).not.toBe(empty.digest);
    expect(() => buildSourcePassages([unit('source')], [{ ...source, sourceVersion: `sha256:${'b'.repeat(64)}` }])).toThrow('outside its source set');
  });
});
