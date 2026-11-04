import type { SourcePassageIndex } from '../../src/knowledge/extraction/source-passages.js';

/** Author a current-wire fixture by choosing the host blocks covering a known source literal. */
export function passageRange(index: SourcePassageIndex, unitKey: string, quote: string) {
  const text = index.units.get(unitKey)?.text, start = text?.indexOf(quote) ?? -1;
  if (start < 0) throw new Error('Fixture quotation is absent from its source unit.');
  const first = [...index.entries.values()].find(entry => entry.unitKey === unitKey && entry.start <= start && start < entry.end)!;
  const end = start + quote.length;
  const last = [...index.entries.values()].find(entry => entry.unitKey === unitKey && entry.start < end && end <= entry.end)!;
  return { startPassageId: first.passageId, endPassageId: last.passageId };
}
