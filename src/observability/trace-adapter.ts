/**
 * cc session JSONL / agent markdown log → omk ResultEntry adapter.
 *
 * This file is intentionally thin: source parsing, attribution, and segmentation
 * live in sibling modules so studio/report code does not inherit one large adapter.
 */

import type { ResultEntry } from '../types/index.js';
import { loadCcSessions, type CcSession } from './trace-source.js';
import { segmentBySkill, segmentsToResultEntries, type SkillSegment } from './trace-segmenter.js';

export type {
  CcAssistantContent,
  CcAssistantRecord,
  CcRecord,
  CcSession,
  CcUserRecord,
  CcUserTextContent,
  CcUserToolResultContent,
} from './trace-source.js';
export { loadCcSessions } from './trace-source.js';
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
export { segmentBySkill, segmentsToResultEntries } from './trace-segmenter.js';

/**
 * One-stop conversion: trace path → ResultEntry[].
 */
export function ccTracesToResultEntries(path: string): { entries: ResultEntry[]; sessions: CcSession[]; segments: SkillSegment[] } {
  const sessions = loadCcSessions(path);
  const segments = sessions.flatMap(segmentBySkill);
  const entries = segmentsToResultEntries(segments);
  return { entries, sessions, segments };
}
