import type { TraceIngestionSummary } from '../contracts/trace.js';
import { sumRecordCounts } from '../../shared/record-count.js';

export interface TraceIngestionNotice {
  level: 'warning' | 'info';
  text: string;
}

export function emptyTraceIngestionSummary(fileCount = 0): TraceIngestionSummary {
  return {
    fileCount,
    sourceRecordCount: 0,
    parsedRecordCount: 0,
    malformedRecordCount: 0,
    ignoredValueCount: 0,
    unknownEventCount: 0,
    filteredSessionCount: 0,
  };
}

export function mergeTraceIngestionSummaries(
  summaries: TraceIngestionSummary[],
): TraceIngestionSummary {
  return summaries.reduce((total, summary) => ({
    fileCount: sumRecordCounts(total.fileCount, summary.fileCount),
    sourceRecordCount: sumRecordCounts(total.sourceRecordCount, summary.sourceRecordCount),
    parsedRecordCount: sumRecordCounts(total.parsedRecordCount, summary.parsedRecordCount),
    malformedRecordCount: sumRecordCounts(total.malformedRecordCount, summary.malformedRecordCount),
    ignoredValueCount: sumRecordCounts(total.ignoredValueCount, summary.ignoredValueCount),
    unknownEventCount: sumRecordCounts(total.unknownEventCount, summary.unknownEventCount),
    filteredSessionCount: sumRecordCounts(total.filteredSessionCount, summary.filteredSessionCount),
  }), emptyTraceIngestionSummary());
}

export function parseTraceIngestionSummary(value: unknown): TraceIngestionSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = [
    'fileCount',
    'sourceRecordCount',
    'parsedRecordCount',
    'malformedRecordCount',
    'ignoredValueCount',
    'unknownEventCount',
    'filteredSessionCount',
  ] as const;
  if (!keys.every((key) => isCount(record[key]))) return null;
  const summary = record as unknown as TraceIngestionSummary;
  let classifiedRecordCount: number;
  try {
    classifiedRecordCount = sumRecordCounts(
      summary.parsedRecordCount,
      summary.malformedRecordCount,
      summary.ignoredValueCount,
    );
  } catch {
    return null;
  }
  if (
    classifiedRecordCount !== summary.sourceRecordCount
    || (summary.fileCount === 0 && (
      summary.sourceRecordCount > 0
      || summary.unknownEventCount > 0
      || summary.filteredSessionCount > 0
    ))
  ) return null;
  return summary;
}

export function traceIngestionNotices(
  summary: TraceIngestionSummary | undefined,
  lang: 'zh' | 'en',
): TraceIngestionNotice[] {
  if (!summary) return [];
  const notices: TraceIngestionNotice[] = [];
  if (
    summary.malformedRecordCount > 0
    || summary.ignoredValueCount > 0
    || summary.unknownEventCount > 0
  ) {
    notices.push({
      level: 'warning',
      text: lang === 'zh'
        ? `注意：摄取时发现 ${summary.malformedRecordCount} 条格式损坏记录、${summary.ignoredValueCount} 个非对象值、${summary.unknownEventCount} 个未识别事件；请确认本次观测覆盖是否完整。`
        : `Note: ingestion found ${summary.malformedRecordCount} malformed records, ${summary.ignoredValueCount} non-object values, and ${summary.unknownEventCount} unrecognized events; review whether this observation is complete.`,
    });
  }
  if (summary.filteredSessionCount > 0) {
    notices.push({
      level: 'info',
      text: lang === 'zh'
        ? `已过滤 ${summary.filteredSessionCount} 个运行时守护会话，不计入知识载体观测。`
        : `Filtered ${summary.filteredSessionCount} runtime guardian session(s) from knowledge-artifact observation.`,
    });
  }
  return notices;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
