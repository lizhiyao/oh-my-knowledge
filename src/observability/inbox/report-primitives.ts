/**
 * 观察收件箱报告的共享原语：落盘 schema 版本、未观测时间戳、片段截取、时间戳出现次数、证据同一性与消息引用推导。
 */
import type {
  ObservationEvidence,
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationMessageRef,
  ObservationMessageWindow,
  ObservationSignalType,
} from '../contracts/inbox.js';
import {
  loadTraceSessions,
} from '../trace/index.js';
import { type TraceEvent } from '../trace/trace-ir.js';
import {
  type PersistedObservationExperienceReport,
} from '../experience.js';

export type PersistedObservationInboxReport = Omit<ObservationInboxReport, 'experience'> & {
  experience?: PersistedObservationExperienceReport;
};

export // observe inbox（观测收件箱）产物根目录。导出名沿用 *_OBSERVATIONS_DIR 以少动 importer,
// 但落盘目录已统一到 observe-inbox 词根(命令 omk observe inbox / kind observe-inbox)。
// 项目级 .omk/observe/inbox 优先、全局兜底 —— 这套 project/global 归属是既有正常行为,本次只改名不改归属。
const OBSERVATION_INBOX_SCHEMA_VERSION = 2;

export const UNOBSERVED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export function snippet(value: unknown, max = 240): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

export function timestampedOccurrencesOf(item: ObservationInboxItem): number {
  return item.timestampedOccurrences
    ?? (item.firstSeen === UNOBSERVED_TIMESTAMP && item.lastSeen === UNOBSERVED_TIMESTAMP
      ? 0
      : item.occurrences);
}

export function observationEvidenceIdentity(value: ObservationEvidence): string {
  return JSON.stringify([
    value.traceId ?? '',
    value.sessionId ?? '',
    value.sourceTrace ?? '',
    value.sourceKind ?? '',
    value.tool ?? '',
    value.query ?? '',
    value.path ?? '',
    value.outputSnippet ?? '',
    value.assistantSnippet ?? '',
    value.userFeedbackSnippet ?? '',
    value.submittedEvidenceSnippet ?? '',
    value.markerToken ?? '',
    value.messageIndex ?? null,
    value.messageUuid ?? '',
    value.callInstanceId ?? '',
    value.toolUseId ?? '',
    value.segmentTimestamp ?? '',
  ]);
}

export function readJsonlMessageRefs(path: string): ObservationMessageRef[] {
  let events: TraceEvent[];
  try {
    events = loadTraceSessions(path)[0]?.events ?? [];
  } catch {
    return [];
  }
  return messageRefsFromEvents(events);
}

export function messageRefsFromEvents(events: TraceEvent[]): ObservationMessageRef[] {
  return events.flatMap((event): ObservationMessageRef[] => {
    const common = {
      messageIndex: event.sourceIndex,
      uuid: event.sourceEventId ?? event.eventId,
      timestamp: event.timestamp,
    };
    if (event.eventKind === 'message') {
      const text = snippet(event.text, 500);
      const role = event.role === 'assistant'
        ? 'assistant'
        : event.role === 'user' ? 'user' : 'other';
      return text ? [{ ...common, role, snippet: text }] : [];
    }
    if (event.eventKind === 'tool_call') {
      const text = snippet(`tool_use ${event.tool.displayName ?? event.tool.name} ${event.callId} ${JSON.stringify(event.input)}`, 500);
      return text ? [{ ...common, role: 'assistant', snippet: text }] : [];
    }
    if (event.eventKind === 'tool_result') {
      const text = snippet(`tool_result ${event.callId} ${event.output}`, 500);
      return text ? [{ ...common, role: 'other', snippet: text }] : [];
    }
    return [];
  });
}

export function inferResolutionAfter(messages: ObservationMessageRef[], signalType: ObservationSignalType): ObservationMessageWindow['resolutionAfter'] {
  if (signalType !== 'failed_search' && signalType !== 'repeated_failure') return 'unknown';
  const later = messages.map((message) => message.snippet).join('\n');
  if (/No matches found|does not exist|not found|permission denied|exceeds maximum allowed tokens/i.test(later) && !/tool_result [^\s]+ (?!No matches found)/i.test(later)) {
    return 'unresolved';
  }
  if (/tool_result [^\s]+ (?!No matches found).{10,}/i.test(later)) return 'resolved';
  return 'unknown';
}
