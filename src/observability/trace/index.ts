/**
 * Source traces / agent markdown logs → source-neutral analysis adapter.
 *
 * This file is intentionally thin: source parsing, attribution, and segmentation
 * live in sibling modules so studio/report code does not inherit one large adapter.
 */

import type { TraceIngestionSummary } from '../contracts/trace.js';
import type { AnalysisEntry } from '../analysis/contracts.js';
import { loadTraceCorpus } from './source.js';
import type { TraceSession } from './trace-ir.js';
import { segmentTraceBySkill, segmentsToAnalysisEntries, type SkillSegment } from './segmentation.js';

export type {
  CcAssistantContent,
  CcAssistantRecord,
  CcRecord,
  CcUserRecord,
  CcUserTextContent,
  CcUserToolResultContent,
} from './source.js';
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
export type { TraceIngestionSummary } from '../contracts/trace.js';
export { loadTraceCorpus, loadTraceSessions } from './source.js';
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
} from './attribution.js';
export type { SkillSegment } from './segmentation.js';
export {
  segmentTraceBySkill,
  segmentsToAnalysisEntries,
  skillSegmentTimestampObserved,
  UNOBSERVED_TRACE_TIMESTAMP,
} from './segmentation.js';

/**
 * One-stop conversion: trace path → AnalysisEntry[].
 */
export function tracesToAnalysisEntries(path: string): {
  entries: AnalysisEntry[];
  sessions: TraceSession[];
  segments: SkillSegment[];
  ingestion: TraceIngestionSummary;
} {
  const { sessions, ingestion } = loadTraceCorpus(path);
  const segments = sessions.flatMap(segmentTraceBySkill);
  const entries = segmentsToAnalysisEntries(segments);
  return { entries, sessions, segments, ingestion };
}
