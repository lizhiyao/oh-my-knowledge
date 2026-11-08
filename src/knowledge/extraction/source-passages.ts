import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SourceRefSchema, sourceSetPreimage, type SourceRef } from '../sources/sources.js';
import type { EvidenceSelection } from '../contracts.js';
import { canonicalJson } from '../store.js';

/** Request-local labels select host-owned source ranges, never model-provided offsets. */
export const SOURCE_PASSAGE_POLICY = Object.freeze({ policyVersion: 'knowledge-source-passages/v1',
  maxPassageUtf16: 256, minimumLineBreakUtf16: 64, preserveSurrogatePairsAndCrlf: true,
  maxSourceTextBytes: 1024 * 1024, maxQuoteUtf16: 32_768,
  scope: 'complete-source-ref-set-including-empty-sources',
  ledgerLongRanges: 'split-at-passage-boundaries-with-identical-ordered-union' });
export const SourcePassageRangeSchema = z.strictObject({
  startPassageId: z.string().min(1).max(256), endPassageId: z.string().min(1).max(256),
});
export type SourcePassageRange = z.infer<typeof SourcePassageRangeSchema>;
const passageSchema = z.strictObject({ passageId: z.string().min(1).max(256), text: z.string() });
export const SourcePassagesSchema = z.array(passageSchema).max(100_256);
export interface SourcePassageUnit { unitKey: string; source: SourceRef; text: string }
interface Passage { passageId: string; unitKey: string; source: SourceRef; start: number; end: number; textDigest: string }
export interface SourcePassageIndex {
  digest: string;
  units: ReadonlyMap<string, SourcePassageUnit>;
  entries: ReadonlyMap<string, Passage>;
  passages: ReadonlyMap<string, readonly { passageId: string; text: string }[]>;
}
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

/** Every original code unit is delivered once; line boundaries only choose the partition. */
export function buildSourcePassages(values: readonly SourcePassageUnit[], sources?: readonly SourceRef[]): SourcePassageIndex {
  const units = new Map<string, SourcePassageUnit>(), entries = new Map<string, Passage>();
  const passages = new Map<string, { passageId: string; text: string }[]>();
  const scope = sourceSetPreimage(sources ?? [...new Map(values.map(unit => [canonicalJson(unit.source), unit.source])).values()]);
  const owners = new Set(scope.sources.map(canonicalJson));
  let sourceBytes = 0;
  for (const value of values) {
    if (!value.unitKey || units.has(value.unitKey)) throw new Error('Duplicate or empty source passage unit.');
    const source = SourceRefSchema.parse(value.source), text = value.text;
    if (!owners.has(canonicalJson(source))) throw new Error('Source passage owner is outside its source set.');
    sourceBytes += Buffer.byteLength(text);
    if (sourceBytes > SOURCE_PASSAGE_POLICY.maxSourceTextBytes) throw new Error('Source passage input capacity_exceeded (1 MiB).');
    if (Buffer.from(text).toString('utf8') !== text) throw new Error('Invalid source passage Unicode.');
    units.set(value.unitKey, { unitKey: value.unitKey, source, text });
    const parts: { passageId: string; text: string }[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + SOURCE_PASSAGE_POLICY.maxPassageUtf16, text.length);
      if (end < text.length) {
        const newline = text.lastIndexOf('\n', end - 1);
        if (newline >= start + SOURCE_PASSAGE_POLICY.minimumLineBreakUtf16) end = newline + 1;
        const previous = text.charCodeAt(end - 1), next = text.charCodeAt(end);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        if (text[end - 1] === '\r' && text[end] === '\n') end--;
      }
      const part = text.slice(start, end), passageId = `p${entries.size}`;
      entries.set(passageId, { passageId, unitKey: value.unitKey, source, start, end, textDigest: digest(part) });
      parts.push({ passageId, text: part }); start = end;
    }
    passages.set(value.unitKey, parts);
  }
  return { digest: digest(canonicalJson({ policy: SOURCE_PASSAGE_POLICY, sources: scope.sources, entries: [...entries.values()] })), units, entries, passages };
}

/** Restore only a canonical partition; supplied IDs/offsets cannot choose a different mapping. */
export function sourcePassageText(value: unknown): string {
  return SourcePassagesSchema.parse(value).map(part => part.text).join('');
}
export function assertSourcePassageInput(index: SourcePassageIndex, header: { passagePolicy?: unknown; passageIndexDigest?: unknown },
  supplied: readonly { unitKey: string; passages: unknown }[]): void {
  if (header.passagePolicy !== SOURCE_PASSAGE_POLICY.policyVersion || header.passageIndexDigest !== index.digest
    || supplied.length !== index.units.size || new Set(supplied.map(unit => unit.unitKey)).size !== index.units.size
    || supplied.some(unit => canonicalJson(unit.passages) !== canonicalJson(index.passages.get(unit.unitKey)))) {
    throw new Error('Source passage input identity mismatch.');
  }
}

/** Exact range identity is established by the immutable host index, including duplicate text. */
export function selectSourcePassages(index: SourcePassageIndex, value: SourcePassageRange, splitLongRanges = false): {
  source: SourceRef; unitKey: string; selections: EvidenceSelection[];
} {
  const range = SourcePassageRangeSchema.parse(value), first = index.entries.get(range.startPassageId), last = index.entries.get(range.endPassageId);
  if (!first || !last) throw new Error('Unknown source passage identity.');
  if (first.unitKey !== last.unitKey || canonicalJson(first.source) !== canonicalJson(last.source)) throw new Error('Cross-unit source passage range.');
  if (first.start > last.start) throw new Error('Reversed source passage range.');
  const unit = index.units.get(first.unitKey)!;
  if (!splitLongRanges && last.end - first.start > SOURCE_PASSAGE_POLICY.maxQuoteUtf16) throw new Error('Source quotation capacity exceeded.');
  const selections: EvidenceSelection[] = [];
  const append = (start: number, end: number) => selections.push({ evidenceRef: first.unitKey, start, end, quote: unit.text.slice(start, end) });
  let start = first.start, end = first.end;
  for (let ordinal = Number(first.passageId.slice(1)) + 1; ordinal <= Number(last.passageId.slice(1)); ordinal++) {
    const entry = index.entries.get(`p${ordinal}`)!;
    if (entry.end - start > SOURCE_PASSAGE_POLICY.maxQuoteUtf16) { append(start, end); start = entry.start; }
    end = entry.end;
  }
  append(start, end);
  return { source: first.source, unitKey: first.unitKey, selections };
}
