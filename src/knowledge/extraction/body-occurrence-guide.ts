import type { EvidenceExcerpt } from '../contracts.js';

/**
 * Type-only port of the frozen v2 pure function (SHA256
 * 8617726550fc012eb5832806888ed07049e869f6d05038123055dc48b3ac8ec7).
 * Algorithm, quotas and metering order are unchanged. The declared guideKind
 * changes to knowledge-body-occurrence-guide/v1; its bytes therefore change
 * serialization size and the associated logical work. No old result is relabelled.
 *
 * Logical work counts do not guarantee milliseconds, CPU instructions or heap.
 * Native fixed helper internals and caller parsing remain outside that guarantee.
 * Source text is read, never normalized; context panels are literal UTF-16 slices.
 */
export type BodyOccurrenceGuideSource = Pick<EvidenceExcerpt, 'evidenceRef' | 'text'> & { eventKind: string };
export type BodyOccurrenceGuidePosition = [ordinal: number, start: number, end: number];
export type BodyOccurrenceGuideTerm = [quote: string, positions: BodyOccurrenceGuidePosition[]];
export interface BodyOccurrenceGuidePanel {
  start: number;
  end: number;
  text: string;
  terms: BodyOccurrenceGuideTerm[];
}
export interface BodyOccurrenceGuideGroup {
  evidenceRef: string;
  eventKind: string;
  panels: BodyOccurrenceGuidePanel[];
}
export interface BodyOccurrenceGuide {
  guideKind: 'knowledge-body-occurrence-guide/v1';
  positionUnit: 'UTF-16-code-units';
  contextCodeUnits: 24;
  groups: BodyOccurrenceGuideGroup[];
}
export type BodyOccurrenceGuideRefusalReason =
  | 'work_budget' | 'invalid_source_unicode' | 'guide_utf8_bytes'
  | 'invalid_excerpts' | 'max_excerpts' | 'invalid_excerpt'
  | 'reference_too_large' | 'source_text_code_units' | 'duplicate_evidence_ref'
  | 'max_candidates' | 'max_rows' | 'max_positions';
export type BodyOccurrenceGuideWorkPhase =
  | 'input_fields' | 'reference_dedupe' | 'input_utf16' | 'excerpt_select'
  | 'token_scan' | 'token_dedupe' | 'token_copy' | 'token_sort'
  | 'sort_allocate' | 'sort_move' | 'match_attempt' | 'match_compare'
  | 'position_allocate' | 'panel_interval' | 'panel_sort' | 'panel_union'
  | 'panel_assign' | 'panel_copy' | 'output_traversal' | 'string_escape'
  | 'output_group' | 'output_panel' | 'bucket_allocate' | 'bucket_assign'
  | 'bucket_visit' | 'output_position' | 'output_join' | 'output_parse';
export interface BodyOccurrenceGuideWork {
  used: number;
  budget: number;
  byPhase: Partial<Record<BodyOccurrenceGuideWorkPhase, number>>;
}
export interface BodyOccurrenceGuideObserved {
  inputExcerptsAtLeast: number;
  sourceTextCodeUnitsAtLeast: number;
  candidatePairsObserved: number;
  candidatePairsAtLeast: number;
  rowsObserved: number;
  positionsObserved: number;
  longRunsSkipped: number;
  bodyExcerptsObserved: number;
  excludedExcerptsObserved: number;
}
export interface BodyOccurrenceGuideHighWater {
  acceptedSourceTextCodeUnits: number;
  candidates: number;
  rows: number;
  positions: number;
  pendingFirstMatchNumbers: number;
  intervals: number;
  panelRanges: number;
  panelAssignmentReferences: number;
  sortScratchReferenceSlots: number;
  currentBucketSlots: number;
  currentBucketReferences: number;
  panelLiteralTempCodeUnits: number;
  serializedStringTempCodeUnits: number;
  outputUtf8Bytes: number;
  outputChunks: number;
}
interface BodyOccurrenceGuideResultCommon {
  limits: typeof BODY_OCCURRENCE_GUIDE_LIMITS;
  workBudgetOverride: boolean;
  work: BodyOccurrenceGuideWork;
  observed: BodyOccurrenceGuideObserved;
  highWater: BodyOccurrenceGuideHighWater;
}
export type BodyOccurrenceGuideResult = BodyOccurrenceGuideResultCommon & (
  | { status: 'ready'; reason: null; phase: null; guide: BodyOccurrenceGuide;
      serializedGuide: string; countsAreComplete: true }
  | { status: 'refused'; reason: BodyOccurrenceGuideRefusalReason; phase: string;
      guide: null; serializedGuide: null; countsAreComplete: false }
);
export interface BodyOccurrenceGuideOptions {
  /** Explicit lower-only work budget for pure boundary tests; real tasks use defaults. */
  workBudget?: number;
}
interface InternalRow { quote: string; positions: BodyOccurrenceGuidePosition[] }
interface InternalInterval { start: number; end: number; rowIndex: number; position: BodyOccurrenceGuidePosition }
interface InternalPanel { start: number; end: number; assignments: InternalInterval[] }
interface InternalGroup {
  evidenceRef: string; eventKind: string; source: string;
  candidates: string[]; rows: InternalRow[]; panels: InternalPanel[];
}

export const BODY_OCCURRENCE_GUIDE_LIMITS = Object.freeze({ candidates: 512, work: 4194304, excerpts: 1024, sourceTextCodeUnits: 1048576, rows: 256, positions: 4096, guideUtf8Bytes: 65536 });
const BODY = new Set<string>(['github_issue_body', 'github_issue_comment_body']);
class Refused extends Error {
  readonly reason: BodyOccurrenceGuideRefusalReason;
  readonly phase: string;
  constructor(reason: BodyOccurrenceGuideRefusalReason, phase: string) { super(reason); this.reason = reason; this.phase = phase; }
}
const isRun = (c: number): boolean => c >= 65 && c <= 90 || c >= 97 && c <= 122 || c >= 48 && c <= 57 || c === 95 || c === 36 || c === 45;
const isFirst = (c: number): boolean => c >= 65 && c <= 90 || c >= 97 && c <= 122 || c === 95 || c === 36;

/** Pure source-only guide construction. No files, time, model, storage or network is accessed here. */
export function buildBodyOccurrenceGuide(excerpts: readonly BodyOccurrenceGuideSource[], { workBudget }: BodyOccurrenceGuideOptions = {}): BodyOccurrenceGuideResult {
  const budget = workBudget ?? BODY_OCCURRENCE_GUIDE_LIMITS.work;
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > BODY_OCCURRENCE_GUIDE_LIMITS.work) throw new Error('Invalid lower-only work budget.');
  const work: BodyOccurrenceGuideWork = { used: 0, budget, byPhase: {} }, observed: BodyOccurrenceGuideObserved = { inputExcerptsAtLeast: 0, sourceTextCodeUnitsAtLeast: 0, candidatePairsObserved: 0, candidatePairsAtLeast: 0, rowsObserved: 0, positionsObserved: 0, longRunsSkipped: 0, bodyExcerptsObserved: 0, excludedExcerptsObserved: 0 };
  const highWater: BodyOccurrenceGuideHighWater = { acceptedSourceTextCodeUnits: 0, candidates: 0, rows: 0, positions: 0, pendingFirstMatchNumbers: 0, intervals: 0, panelRanges: 0, panelAssignmentReferences: 0, sortScratchReferenceSlots: 0, currentBucketSlots: 0, currentBucketReferences: 0, panelLiteralTempCodeUnits: 0, serializedStringTempCodeUnits: 0, outputUtf8Bytes: 0, outputChunks: 0 };
  let candidateCount = 0, rowCount = 0, positionCount = 0, intervalCount = 0, panelCount = 0, assignmentCount = 0, outputBytes = 0, outputUnits = 0;
  const groups: InternalGroup[] = [], chunks: string[] = [];
  const tick = (phase: BodyOccurrenceGuideWorkPhase, count = 1): void => { if (count > budget - work.used) throw new Refused('work_budget', phase); work.used += count; work.byPhase[phase] = (work.byPhase[phase] ?? 0) + count; };
  const refuse = (reason: BodyOccurrenceGuideRefusalReason, phase: string): never => { throw new Refused(reason, phase); };
  function compare(a: string, b: string, phase: BodyOccurrenceGuideWorkPhase): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) { tick(phase); const x = a.charCodeAt(i), y = b.charCodeAt(i); if (x !== y) return x - y; }
    tick(phase); return a.length - b.length;
  }
  function validUtf16(text: string): void {
    for (let i = 0; i < text.length; i++) {
      tick('input_utf16'); const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { if (i + 1 >= text.length) refuse('invalid_source_unicode', 'input'); tick('input_utf16'); const d = text.charCodeAt(++i); if (d < 0xdc00 || d > 0xdfff) refuse('invalid_source_unicode', 'input'); }
      else if (c >= 0xdc00 && c <= 0xdfff) refuse('invalid_source_unicode', 'input');
    }
  }
  function stableSort<T>(values: T[], comparator: (a: T, b: T) => number): T[] {
    const n = values.length; if (n < 2) return values;
    tick('sort_allocate', n); let from = values, into = new Array<T>(n);
    highWater.sortScratchReferenceSlots = Math.max(highWater.sortScratchReferenceSlots, n);
    for (let width = 1; width < n; width *= 2) {
      for (let base = 0; base < n; base += 2 * width) {
        let left = base, right = Math.min(base + width, n), out = base;
        const leftEnd = right, rightEnd = Math.min(base + 2 * width, n);
        while (left < leftEnd && right < rightEnd) { tick('sort_move'); into[out++] = comparator(from[left], from[right]) <= 0 ? from[left++] : from[right++]; }
        while (left < leftEnd) { tick('sort_move'); into[out++] = from[left++]; }
        while (right < rightEnd) { tick('sort_move'); into[out++] = from[right++]; }
      }
      const swap = from; from = into; into = swap;
    }
    return from;
  }
  function emit(fragment: string): void {
    tick('output_traversal', fragment.length);
    const size = Buffer.byteLength(fragment, 'utf8');
    if (size > BODY_OCCURRENCE_GUIDE_LIMITS.guideUtf8Bytes - outputBytes) refuse('guide_utf8_bytes', 'serialization');
    chunks.push(fragment); outputBytes += size; outputUnits += fragment.length;
    highWater.outputUtf8Bytes = outputBytes; highWater.outputChunks = chunks.length;
  }
  function emitString(text: string, start = 0, end = text.length, panel = false): void {
    const length = end - start;
    if (length + 2 > BODY_OCCURRENCE_GUIDE_LIMITS.guideUtf8Bytes - outputBytes) refuse('guide_utf8_bytes', 'string_preflight');
    if (panel) { tick('panel_copy', length); highWater.panelLiteralTempCodeUnits = Math.max(highWater.panelLiteralTempCodeUnits, length); }
    tick('string_escape', length);
    const literal = panel ? text.slice(start, end) : text, encoded = JSON.stringify(literal);
    highWater.serializedStringTempCodeUnits = Math.max(highWater.serializedStringTempCodeUnits, encoded.length);
    emit(encoded);
  }
  const finish = (status: BodyOccurrenceGuideResult['status'], reason: BodyOccurrenceGuideRefusalReason | null = null, phase: string | null = null, guide: BodyOccurrenceGuide | null = null, serializedGuide: string | null = null): BodyOccurrenceGuideResult => ({ status, reason, phase, guide, serializedGuide,
    limits: BODY_OCCURRENCE_GUIDE_LIMITS, workBudgetOverride: workBudget !== undefined, work, observed, highWater, countsAreComplete: status === 'ready' } as BodyOccurrenceGuideResult);
  try {
    if (!Array.isArray(excerpts)) refuse('invalid_excerpts', 'preflight');
    observed.inputExcerptsAtLeast = excerpts.length;
    if (excerpts.length > BODY_OCCURRENCE_GUIDE_LIMITS.excerpts) refuse('max_excerpts', 'preflight');
    let acceptedSource = 0;
    for (let i = 0; i < excerpts.length; i++) {
      tick('input_fields'); const e = excerpts[i];
      if (!e || typeof e.evidenceRef !== 'string' || !e.evidenceRef.length || typeof e.eventKind !== 'string' || typeof e.text !== 'string') refuse('invalid_excerpt', 'preflight');
      if (e.evidenceRef.length + 2 > BODY_OCCURRENCE_GUIDE_LIMITS.guideUtf8Bytes || e.eventKind.length + 2 > BODY_OCCURRENCE_GUIDE_LIMITS.guideUtf8Bytes) refuse('reference_too_large', 'preflight');
      observed.sourceTextCodeUnitsAtLeast += e.text.length;
      if (e.text.length > BODY_OCCURRENCE_GUIDE_LIMITS.sourceTextCodeUnits - acceptedSource) refuse('source_text_code_units', 'preflight');
      acceptedSource += e.text.length; highWater.acceptedSourceTextCodeUnits = acceptedSource;
      for (let j = 0; j < i; j++) if (compare(e.evidenceRef, excerpts[j].evidenceRef, 'reference_dedupe') === 0) refuse('duplicate_evidence_ref', 'preflight');
      validUtf16(e.evidenceRef); validUtf16(e.eventKind); validUtf16(e.text);
    }
    for (const e of excerpts) {
      tick('excerpt_select'); if (!BODY.has(e.eventKind)) { observed.excludedExcerptsObserved++; continue; }
      observed.bodyExcerptsObserved++;
      const group: InternalGroup = { evidenceRef: e.evidenceRef, eventKind: e.eventKind, source: e.text, candidates: [], rows: [], panels: [] };
      groups.push(group); let runStart = -1, runFirst = 0;
      function nominate(end: number): void {
        const length = end - runStart;
        if (length > 64) observed.longRunsSkipped++;
        if (length < 2 || length > 64 || !isFirst(runFirst)) return;
        for (const prior of group.candidates) {
          tick('token_dedupe'); if (prior.length !== length) continue;
          let equal = true;
          for (let j = 0; j < length; j++) { tick('token_dedupe'); if (e.text.charCodeAt(runStart + j) !== prior.charCodeAt(j)) { equal = false; break; } }
          if (equal) return;
        }
        observed.candidatePairsAtLeast = candidateCount + 1;
        if (candidateCount >= BODY_OCCURRENCE_GUIDE_LIMITS.candidates) refuse('max_candidates', 'nomination');
        tick('token_copy', length); const quote = e.text.slice(runStart, end);
        group.candidates.push(quote); candidateCount++; observed.candidatePairsObserved = candidateCount; highWater.candidates = candidateCount;
      }
      for (let i = 0; i < e.text.length; i++) {
        tick('token_scan'); const c = e.text.charCodeAt(i);
        if (isRun(c)) { if (runStart < 0) { runStart = i; runFirst = c; } }
        else if (runStart >= 0) { nominate(i); runStart = -1; }
      }
      if (runStart >= 0) nominate(e.text.length);
      group.candidates = stableSort(group.candidates, (a, b) => compare(a, b, 'token_sort'));
      for (const quote of group.candidates) {
        let firstStart = -1, row: InternalRow | null = null;
        for (let start = 0; start <= e.text.length - quote.length; start++) {
          tick('match_attempt'); let match = true;
          for (let j = 0; j < quote.length; j++) { tick('match_compare'); if (e.text.charCodeAt(start + j) !== quote.charCodeAt(j)) { match = false; break; } }
          if (!match) continue;
          if (firstStart < 0) { firstStart = start; highWater.pendingFirstMatchNumbers = 1; continue; }
          if (row === null) {
            if (rowCount >= BODY_OCCURRENCE_GUIDE_LIMITS.rows) refuse('max_rows', 'second_match');
            if (positionCount + 2 > BODY_OCCURRENCE_GUIDE_LIMITS.positions) refuse('max_positions', 'second_match');
            tick('position_allocate', 2); row = { quote, positions: [[0, firstStart, firstStart + quote.length], [1, start, start + quote.length]] };
            group.rows.push(row); rowCount++; positionCount += 2;
          } else {
            if (positionCount >= BODY_OCCURRENCE_GUIDE_LIMITS.positions) refuse('max_positions', 'next_match');
            tick('position_allocate'); row.positions.push([row.positions.length, start, start + quote.length]); positionCount++;
          }
          observed.rowsObserved = rowCount; observed.positionsObserved = positionCount; highWater.rows = rowCount; highWater.positions = positionCount;
        }
      }
      let intervals: InternalInterval[] = [];
      for (let rowIndex = 0; rowIndex < group.rows.length; rowIndex++) for (const position of group.rows[rowIndex].positions) {
        tick('panel_interval'); intervals.push({ start: Math.max(0, position[1] - 24), end: Math.min(e.text.length, position[2] + 24), rowIndex, position });
        intervalCount++; highWater.intervals = intervalCount;
      }
      intervals = stableSort(intervals, (a, b) => { tick('panel_sort'); return a.start - b.start || a.end - b.end || a.rowIndex - b.rowIndex || a.position[0] - b.position[0]; });
      for (const interval of intervals) {
        tick('panel_union'); let panel = group.panels[group.panels.length - 1];
        if (!panel || interval.start > panel.end) { panel = { start: interval.start, end: interval.end, assignments: [] }; group.panels.push(panel); panelCount++; highWater.panelRanges = panelCount; }
        else panel.end = Math.max(panel.end, interval.end);
        tick('panel_assign'); panel.assignments.push(interval); assignmentCount++; highWater.panelAssignmentReferences = assignmentCount;
      }
    }
    emit('{"guideKind":"knowledge-body-occurrence-guide/v1","positionUnit":"UTF-16-code-units","contextCodeUnits":24,"groups":[');
    for (let gi = 0; gi < groups.length; gi++) {
      tick('output_group'); const group = groups[gi]; if (gi) emit(','); emit('{"evidenceRef":'); emitString(group.evidenceRef); emit(',"eventKind":'); emitString(group.eventKind); emit(',"panels":[');
      for (let pi = 0; pi < group.panels.length; pi++) {
        tick('output_panel'); const panel = group.panels[pi]; if (pi) emit(','); emit('{"start":'); emit(String(panel.start)); emit(',"end":'); emit(String(panel.end)); emit(',"text":'); emitString(group.source, panel.start, panel.end, true); emit(',"terms":[');
        tick('bucket_allocate', group.rows.length); const buckets: Array<BodyOccurrenceGuidePosition[] | undefined> = new Array(group.rows.length); highWater.currentBucketSlots = Math.max(highWater.currentBucketSlots, buckets.length);
        let bucketRefs = 0;
        for (const a of panel.assignments) { tick('bucket_assign'); if (!buckets[a.rowIndex]) buckets[a.rowIndex] = []; buckets[a.rowIndex]!.push(a.position); bucketRefs++; highWater.currentBucketReferences = Math.max(highWater.currentBucketReferences, bucketRefs); }
        let emittedTerms = 0;
        for (let ri = 0; ri < buckets.length; ri++) {
          tick('bucket_visit'); if (!buckets[ri]) continue;
          if (emittedTerms++) emit(','); emit('['); emitString(group.rows[ri].quote); emit(',[');
          for (let oi = 0; oi < buckets[ri]!.length; oi++) {
            tick('output_position'); if (oi) emit(','); const position = buckets[ri]![oi]; emit('['); emit(String(position[0])); emit(','); emit(String(position[1])); emit(','); emit(String(position[2])); emit(']');
          }
          emit(']]');
        }
        emit(']}');
      }
      emit(']}');
    }
    emit(']}'); tick('output_join', outputUnits); const serializedGuide = chunks.join(''); tick('output_parse', serializedGuide.length); const guide = JSON.parse(serializedGuide) as BodyOccurrenceGuide;
    return finish('ready', null, null, guide, serializedGuide);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    return finish('refused', error.reason, error.phase);
  }
}
