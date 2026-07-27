/**
 * Source traces / agent markdown logs → omk ResultEntry adapter.
 *
 * This file is intentionally thin: source parsing, attribution, and segmentation
 * live in sibling modules so studio/report code does not inherit one large adapter.
 */

import type { ResultEntry, TraceIngestionSummary } from '../types/index.js';
import { loadTraceCorpus } from './trace-source.js';
import type { TraceSession } from './trace-ir.js';
import { segmentTraceBySkill, segmentsToResultEntries, type SkillSegment } from './trace-segmenter.js';

export type {
  CcAssistantContent,
  CcAssistantRecord,
  CcRecord,
  CcSession,
  CcUserRecord,
  CcUserTextContent,
  CcUserToolResultContent,
} from './trace-source.js';
export type {
  TraceEvent,
  TraceLifecycleEvent,
  TraceMessageEvent,
  TraceMessageOrigin,
  TraceSession,
  TraceToolCallEvent,
  TraceToolRef,
  TraceToolResultEvent,
  TraceToolStatus,
  TraceUsageEvent,
} from './trace-ir.js';
export type { TraceIngestionSummary } from '../types/index.js';
export { loadCcSessions, loadTraceCorpus, loadTraceSessions } from './trace-source.js';
export {
  extractAttributionSkill,
  extractAttributionSkillRef,
  extractCommandSkill,
  extractCommandSkillRef,
  extractCommandEnvelopeText,
  extractMarkdownLogSkill,
  extractSkillReadFileRef,
  extractSkillReadFile,
  extractSkillToolUse,
  extractSkillToolUseRef,
  normalizeSkillName,
  parseSkillRef,
  stripCommandEnvelopeText,
} from './trace-attribution.js';
export type { SkillSegment } from './trace-segmenter.js';
export {
  segmentBySkill,
  segmentTraceBySkill,
  segmentsToResultEntries,
  skillSegmentTimestampObserved,
  UNOBSERVED_TRACE_TIMESTAMP,
} from './trace-segmenter.js';

/**
 * One-stop conversion: trace path → ResultEntry[].
 */
export function tracesToResultEntries(path: string): {
  entries: ResultEntry[];
  sessions: TraceSession[];
  segments: SkillSegment[];
  ingestion: TraceIngestionSummary;
} {
  const { sessions, ingestion } = loadTraceCorpus(path);
  const segments = sessions.flatMap(segmentTraceBySkill);
  const entries = segmentsToResultEntries(segments);
  return { entries, sessions, segments, ingestion };
}

/** @deprecated Use `tracesToResultEntries`. */
export const ccTracesToResultEntries = tracesToResultEntries;
