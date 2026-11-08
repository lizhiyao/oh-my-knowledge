import { z } from 'zod';
import type { EvidenceSelection } from '../contracts.js';
import { SourceRefSchema, type SourceExcerpt, type SourceRef, type SourceSnapshot } from '../sources/sources.js';
import type { KnowledgeApplication } from './application.js';

const RANKING_POLICY_ID = 'source-evidence-bm25/v1' as const;
const WINDOW_UTF16 = 1024;
const OVERLAP_UTF16 = 128;
const MAX_QUERY_UTF16 = 512;
const STOP_WORDS = new Set('a an and are as at be by did do does for from had has have how i in is it me my of on or that the their them there they this to was were what when where which who will with would you your'.split(' '));

const LATIN_TOKEN = '[\\p{Script=Latin}\\p{M}0-9_]';
const WORDS = new RegExp(`\\p{Script=Han}+|${LATIN_TOKEN}+`, 'gu');
const STARTS_LATIN = new RegExp(`^${LATIN_TOKEN}`, 'u');
const ENDS_LATIN = new RegExp(`${LATIN_TOKEN}$`, 'u');
const RAW_LATIN_TAIL = /[\p{Script=Latin}\p{M}\p{Nd}_]+$/u;
const SINGLE_HAN = /^\p{Script=Han}$/u;

function* terms(text: string, start = 0, end = text.length, singleHan?: ReadonlySet<string>): Generator<string> {
  const normalized = text.slice(start, end).normalize('NFKC').toLowerCase();
  const before = text.slice(Math.max(0, start - 2), start).normalize('NFKC');
  const after = text.slice(end, end + 2).normalize('NFKC');
  for (const match of normalized.matchAll(WORDS)) {
    const token = match[0];
    const atStart = match.index === 0;
    const atEnd = match.index + token.length === normalized.length;
    if (/^\p{Script=Han}/u.test(token)) {
      const characters = Array.from(token);
      if (characters.length === 1 && !(atStart && /\p{Script=Han}$/u.test(before)) && !(atEnd && /^\p{Script=Han}/u.test(after))) yield token;
      else for (const character of characters) {
        if (singleHan?.has(character)) yield character;
      }
      for (let index = 1; index < characters.length; index++) yield characters[index - 1] + characters[index];
    } else if (!STOP_WORDS.has(token) && !(atStart && ENDS_LATIN.test(before)) && !(atEnd && STARTS_LATIN.test(after))) {
      yield token;
    }
  }
}

export const SourceEvidenceSearchRequestSchema = z.strictObject({
  source: SourceRefSchema,
  query: z.string().trim().min(1).max(MAX_QUERY_UTF16)
    .refine(value => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value), 'Query contains control characters.')
    .refine(value => !terms(value).next().done, 'Query has no searchable literal fragments.'),
  maxBytes: z.number().int().min(1024).max(65536).default(16384),
});

type Resolution = ReturnType<KnowledgeApplication['source']>;
type Hit = { selection: EvidenceSelection; coordinate: SourceExcerpt['coordinate'] };
type Candidate = { excerpt: SourceExcerpt; start: number; end: number; length: number; frequencies: Map<string, number> };
interface SourceEvidenceSearchResult {
  projectionKind: 'source-evidence-search';
  schemaVersion: 1;
  rankingPolicyId: typeof RANKING_POLICY_ID;
  source: SourceRef & ({ status: 'available'; sourceKind: SourceSnapshot['sourceKind'] }
    | { status: 'unavailable'; reason: Extract<Resolution, { status: 'unavailable' }>['reason'] });
  hits: Hit[];
  omittedMatches: number;
}

function safeBoundary(text: string, offset: number): number {
  const next = text.charCodeAt(offset);
  return (next >= 0xdc00 && next <= 0xdfff) || (text[offset - 1] === '\r' && text[offset] === '\n') ? offset - 1 : offset;
}

function nextWindowStart(text: string, end: number): number {
  // Extend overlap only when a longer identifier would otherwise be split by both windows.
  const left = safeBoundary(text, end - MAX_QUERY_UTF16);
  const trailing = text.slice(left, end).match(RAW_LATIN_TAIL)?.[0];
  if (trailing && trailing.length > OVERLAP_UTF16 && trailing.length < MAX_QUERY_UTF16
    && STARTS_LATIN.test(text.slice(end, end + 2).normalize('NFKC'))) return end - trailing.length;
  return safeBoundary(text, end - OVERLAP_UTF16);
}

function rank(excerpts: readonly SourceExcerpt[], query: ReadonlySet<string>): Candidate[] {
  const matches: Candidate[] = [];
  const documentFrequencies = new Map<string, number>();
  const singleHan = new Set([...query].filter(term => SINGLE_HAN.test(term)));
  let windows = 0, totalLength = 0;
  for (const excerpt of excerpts) {
    const { text } = excerpt;
    for (let start = 0; start < text.length;) {
      const end = safeBoundary(text, Math.min(start + WINDOW_UTF16, text.length));
      const frequencies = new Map<string, number>();
      let length = 0;
      for (const term of terms(text, start, end, singleHan)) {
        length++;
        if (query.has(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
      }
      if (length > 0) { windows++; totalLength += length; }
      if (frequencies.size > 0) {
        matches.push({ excerpt, start, end, length, frequencies });
        for (const term of frequencies.keys()) documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
      }
      if (end === text.length) break;
      start = nextWindowStart(text, end);
    }
  }

  const inverseFrequencies = new Map([...documentFrequencies].map(([term, count]) =>
    [term, Math.log1p((windows - count + 0.5) / (count + 0.5))]));
  const averageLength = totalLength / windows;
  const k1 = 1.2, b = 0.75;
  return matches.map(match => {
    const lengthPenalty = k1 * (1 - b + b * match.length / averageLength);
    let score = 0;
    for (const [term, count] of match.frequencies) {
      score += inverseFrequencies.get(term)! * (count * (k1 + 1)) / (count + lengthPenalty);
    }
    return { match, score };
  }).sort((left, right) => right.score - left.score).map(({ match }) => match);
}

/** Search only a selected version's persisted, citable excerpts. */
export function searchSourceEvidence(app: Pick<KnowledgeApplication, 'source'>,
  input: z.input<typeof SourceEvidenceSearchRequestSchema>): SourceEvidenceSearchResult {
  const { source, query, maxBytes } = SourceEvidenceSearchRequestSchema.parse(input);
  const resolved = app.source(source);
  const result: SourceEvidenceSearchResult = { projectionKind: 'source-evidence-search', schemaVersion: 1, rankingPolicyId: RANKING_POLICY_ID,
    source: { ...source, status: 'unavailable', reason: 'version_mismatch' }, hits: [], omittedMatches: 0 };
  if (resolved.status === 'unavailable') {
    result.source = { ...source, status: 'unavailable', reason: resolved.reason };
    return result;
  }
  const { snapshot } = resolved;
  if (snapshot.snapshotId !== source.snapshotId || snapshot.sourceVersion !== source.sourceVersion) return result;
  result.source = { ...source, status: 'available', sourceKind: snapshot.sourceKind };
  const ranked = rank(snapshot.excerpts, new Set(terms(query)));
  result.omittedMatches = ranked.length;
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8') + 1;
  for (const { excerpt, start, end } of ranked) {
    const hit: Hit = { selection: { evidenceRef: excerpt.evidenceRef, start, end, quote: excerpt.text.slice(start, end) }, coordinate: excerpt.coordinate };
    const cost = Buffer.byteLength(JSON.stringify(hit), 'utf8') + (result.hits.length > 0 ? 1 : 0)
      + String(result.omittedMatches - 1).length - String(result.omittedMatches).length;
    if (bytes + cost > maxBytes) continue;
    result.hits.push(hit);
    bytes += cost;
    result.omittedMatches--;
  }
  return result;
}
