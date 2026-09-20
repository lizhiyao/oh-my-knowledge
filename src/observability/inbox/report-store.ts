/**
 * 观察收件箱报告的存取：落盘、读取、结构自校验、按条件查询与定位单条条目。
 */
import { buildOverallSessionTimeRange } from './session-time-range.js';
import { severityReasonCodeFor } from './severity-reason.js';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isReportFileName, randomRunToken, reportFilePath } from '../../evidence/storage/file-names.js';
import type { ObservationExperienceReport } from '../contracts/experience.js';
import type {
  ObservationInboxItem,
  ObservationInboxReport,
  ObservationSessionTimeRange,
  ObservationSignalSubtype,
  ObservationSignalType,
} from '../contracts/inbox.js';
import { normalizeTraceTimestamp } from '../trace/trace-ir.js';
import { isTraceSourceKind } from '../../executors/core/trace-source-kind.js';
import {
  sumRecordCounts,
} from '../../shared/record-count.js';
import { durationMsBetween } from '../../shared/time.js';
import {
  normalizeObservationExperienceReport,
} from '../experience.js';
import { parseDiagnosisBundle } from '../../diagnosis/contracts/parser.js';
import { parseTraceIngestionSummary } from '../trace/ingestion.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { writeObservationSourceRecordArchives } from './source-record-archive.js';
import { loadExplicitObservationCaptureItems } from './explicit-capture.js';
import { isObservationCaptureCoverage } from './capture-coverage.js';
import {
  DEFAULT_OBSERVATIONS_DIR,
  observationReportsDir,
  resolveObservationsDir,
} from './paths.js';

import {
  aggregateInboxItems,
  compactObservationInboxReport,
  inferObservationSourceKind,
} from './report-building.js';
import {
  OBSERVATION_INBOX_SCHEMA_VERSION,
  UNOBSERVED_TIMESTAMP,
  observationEvidenceIdentity,
  timestampedOccurrencesOf,
} from './report-primitives.js';

export function saveObservationInboxReport(report: ObservationInboxReport, outDir: string = DEFAULT_OBSERVATIONS_DIR): string {
  const compact = compactObservationInboxReport(report);
  if (!normalizeObservationInboxReport(compact)) {
    throw new Error('拒绝写入无法回读的 observe inbox 报告。');
  }
  const reportsDir = observationReportsDir(outDir);
  mkdirSync(reportsDir, { recursive: true });
  // 保留毫秒并追加随机段；即使同一毫秒生成两份 report，也不能静默互相覆盖。
  // 例: '2026-05-07T12:00:00.999Z' → '2026-05-07T12-00-00-999'
  const stamp = report.meta.generatedAt.replace(/[:.]/g, '-').replace(/Z$/, '');
  const path = reportFilePath(reportsDir, `${stamp}-${randomRunToken()}`);
  const sourceRecordArchives = writeObservationSourceRecordArchives(report, outDir, path);
  const persisted = sourceRecordArchives.length > 0
    ? { ...compact, meta: { ...compact.meta, sourceRecordArchives } }
    : compact;
  if (!normalizeObservationInboxReport(persisted)) {
    throw new Error('拒绝写入原始日志引用无效的 observe inbox 报告。');
  }
  writeJsonFileAtomic(path, persisted);
  return path;
}

export function loadObservationInboxReports(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport[] {
  const resolvedDir = resolveObservationsDir(dir);
  const reportsDir = observationReportsDir(resolvedDir);
  if (!existsSync(reportsDir)) return [];
  return readdirSync(reportsDir)
    .filter(isReportFileName)
    .map((file) => {
      try {
        const report = normalizeObservationInboxReport(JSON.parse(readFileSync(join(reportsDir, file), 'utf-8')));
        if (!report) return null;
        report.items = report.items.map((item) => {
          return {
            ...item,
            sourceKind: item.sourceKind ?? inferObservationSourceKind(item.sourceTrace),
            severityReasonCode: item.severityReasonCode ?? severityReasonCodeFor(item),
            severityReason: undefined,
          };
        });
        // 不在 load 路径重建 diagnostics:`buildObserveDiagnosticsFromReport` 现在虽然会从
        // report.items[].cwd / experience 推断每个 skill 的 cwd(没把握就跳过该 skill 的
        // chain advisory,不再 fallback process.cwd()),但 load 时全跳过的话整个 trace
        // 都没有 Diagnosis。新版 build 路径由调用方(CLI observe ingest)在 build 之后
        // 显式驱动 diagnostics 装配后写入 JSON;老 inbox JSON 缺字段时让 Studio 显示
        // 「该 trace 暂无 Diagnosis,请重新 observe 一次」,比惰性重建安全。
        return report;
      } catch {
        return null;
      }
    })
    .filter((r): r is ObservationInboxReport => r?.kind === 'observe-inbox');
}

function normalizeObservationInboxReport(value: unknown): ObservationInboxReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  const kind = report.kind === 'observe-inbox' ? report.kind : null;
  if (!kind) return null;
  if (report.schemaVersion !== OBSERVATION_INBOX_SCHEMA_VERSION) return null;
  if (!isObservationInboxMeta(report.meta) || !Array.isArray(report.items)) return null;
  if (!report.items.every(isObservationInboxItem)) return null;
  if (report.meta.itemCount !== report.items.length) return null;
  const items = (report.items as ObservationInboxItem[]).map((item) => ({
    ...item,
    timestampedOccurrences: timestampedOccurrencesOf(item),
  }));
  const experience = report.experience === undefined
    ? undefined
    : normalizeObservationExperienceReport(report.experience);
  if (report.experience !== undefined && !experience) return null;
  const diagnostics = report.diagnostics === undefined
    ? undefined
    : parseDiagnosisBundle(report.diagnostics);
  if (report.diagnostics !== undefined && !diagnostics) return null;
  if (
    !observationInboxReferencesAreConsistent(
      report.meta as ObservationInboxReport['meta'],
      items,
      experience ?? undefined,
    )
  ) return null;
  return {
    kind: 'observe-inbox',
    schemaVersion: OBSERVATION_INBOX_SCHEMA_VERSION,
    meta: report.meta as ObservationInboxReport['meta'],
    items,
    ...(experience ? { experience } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
}

function observationInboxReferencesAreConsistent(
  meta: ObservationInboxReport['meta'],
  items: ObservationInboxItem[],
  experience?: ObservationExperienceReport,
): boolean {
  const archiveRefs = meta.sourceRecordArchives ?? [];
  const experienceSessionIds = new Set(experience?.sessions.map((session) => session.id) ?? []);
  if (
    new Set(archiveRefs.map((ref) => ref.experienceSessionId)).size !== archiveRefs.length
    || archiveRefs.some((ref) => !experienceSessionIds.has(ref.experienceSessionId))
  ) return false;
  const itemIds = new Set(items.map((item) => item.id));
  if (itemIds.size !== items.length) return false;
  if (
    items.some((item) =>
      new Set(item.recentSessionIds).size !== item.recentSessionIds.length
      || (
        item.recentTraceIds !== undefined
        && new Set(item.recentTraceIds).size !== item.recentTraceIds.length
      )
      || item.occurrences < item.recentSessionIds.length
      || item.occurrences < (item.recentTraceIds?.length ?? 0)
      || timestampedOccurrencesOf(item) > item.occurrences
      || (
        item.traceId !== undefined
        && (
          item.evidence.traceId !== item.traceId
          || !item.recentTraceIds?.includes(item.traceId)
        )
      )
      || (
        item.evidence.sourceTrace !== undefined
        && item.evidence.sourceTrace !== item.sourceTrace
      )
      || (
        item.evidence.sessionId !== undefined
        && item.evidence.sessionId !== item.sessionId
      )
      || (
        item.evidence.sourceKind !== undefined
        && item.evidence.sourceKind !== item.sourceKind
      )
      || item.representativeEvidence.length === 0
      || observationEvidenceIdentity(item.representativeEvidence[0])
        !== observationEvidenceIdentity(item.evidence)
      || new Set(item.representativeEvidence.map(observationEvidenceIdentity)).size
        !== item.representativeEvidence.length
    )
  ) return false;
  if (
    meta.sessionCount !== undefined
    && meta.sessionTimeRanges !== undefined
    && meta.sessionCount !== meta.sessionTimeRanges.length
  ) return false;
  if (
    meta.sessionTimeRanges !== undefined
    && (
      new Set(meta.sessionTimeRanges.map((range) =>
        range.traceId ?? `${range.sourceTrace}\u0000${range.sessionId}`
      )).size
        !== meta.sessionTimeRanges.length
      || !overallSessionTimeRangeMatches(meta.sessionTimeRange, meta.sessionTimeRanges)
    )
  ) return false;
  if (!experience) return true;
  if (
    meta.generatedAt !== experience.generatedAt
    || meta.segmentCount !== experience.invocations.length
    ||
    experience.invocations.some((invocation) =>
      invocation.relatedObservationIds.some((id) => !itemIds.has(id))
    )
  ) return false;

  const invocationCounts = Object.fromEntries(
    experience.skills.map((skill) => [skill.skillName, skill.invocationCount]),
  );
  const sessionCounts = Object.fromEntries(
    experience.skills.map((skill) => [skill.skillName, skill.sessionCount]),
  );
  const lastSeen = Object.fromEntries(
    experience.skills
      .filter((skill) => (
        skill.timestampedInvocationCount
        ?? (skill.firstSeen === UNOBSERVED_TIMESTAMP ? 0 : skill.invocationCount)
      ) > 0)
      .map((skill) => [skill.skillName, skill.lastSeen]),
  );
  const toolCounts = Object.fromEntries(
    experience.skills.map((skill) => [skill.skillName, skill.toolCounts]),
  );
  return (
    meta.skillInvocationCounts === undefined
    || inboxRecordsEqual(meta.skillInvocationCounts, invocationCounts)
  ) && (
    meta.skillSessionCounts === undefined
    || inboxRecordsEqual(meta.skillSessionCounts, sessionCounts)
  ) && (
    meta.skillInvocationLastSeen === undefined
    || inboxRecordsEqual(meta.skillInvocationLastSeen, lastSeen)
  ) && (
    meta.skillToolCallCounts === undefined
    || (
      inboxRecordKeysEqual(meta.skillToolCallCounts, toolCounts)
      && Object.keys(toolCounts).every((skillName) =>
        inboxRecordsEqual(
          meta.skillToolCallCounts?.[skillName] ?? {},
          toolCounts[skillName],
        )
      )
    )
  );
}

function overallSessionTimeRangeMatches(
  actual: ObservationInboxReport['meta']['sessionTimeRange'],
  ranges: ObservationSessionTimeRange[],
): boolean {
  if (!actual) return true;
  const expected = buildOverallSessionTimeRange(ranges);
  if (!expected) return false;
  return actual.from === expected.from
    && actual.to === expected.to
    && actual.durationMs === expected.durationMs;
}

function inboxRecordsEqual<T extends string | number>(
  left: Record<string, T>,
  right: Record<string, T>,
): boolean {
  return inboxRecordKeysEqual(left, right)
    && Object.keys(left).every((key) => left[key] === right[key]);
}

function inboxRecordKeysEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]);
}

function isObservationInboxMeta(value: unknown): value is ObservationInboxReport['meta'] {
  if (
    !isInboxRecord(value)
    || typeof value.tracePath !== 'string'
    || !isInboxTimestamp(value.generatedAt)
    || (value.sessionCount !== undefined && !isInboxCount(value.sessionCount))
    || !isInboxCount(value.segmentCount)
    || !isInboxCount(value.itemCount)
    || (
      value.ingestion !== undefined
      && parseTraceIngestionSummary(value.ingestion) === null
    )
    || (value.skillInvocationCounts !== undefined && !isInboxCountRecord(value.skillInvocationCounts))
    || (value.skillSessionCounts !== undefined && !isInboxCountRecord(value.skillSessionCounts))
    || (
      value.timestampedSegmentCount !== undefined
      && (
        !isInboxCount(value.timestampedSegmentCount)
        || value.timestampedSegmentCount > value.segmentCount
      )
    )
    || (
      value.timestampCoverage !== undefined
      && (
        !isInboxRate(value.timestampCoverage)
        || value.timestampedSegmentCount === undefined
        || !inboxRatesEqual(value.timestampCoverage, (
          value.segmentCount > 0
            ? (value.timestampedSegmentCount as number) / value.segmentCount
            : 0
        ))
      )
    )
    || (
      value.skillInvocationLastSeen !== undefined
      && !isInboxTimestampRecord(value.skillInvocationLastSeen)
    )
    || (
      value.skillToolCallCounts !== undefined
      && (
        !isInboxRecord(value.skillToolCallCounts)
        || !Object.values(value.skillToolCallCounts).every(isInboxCountRecord)
      )
    )
    || (
      value.sourceRecordArchives !== undefined
      && (
        !Array.isArray(value.sourceRecordArchives)
        || !value.sourceRecordArchives.every(isObservationSourceRecordArchiveRef)
      )
    )
  ) return false;
  if (
    value.sessionTimeRange !== undefined
    && (
      !isInboxRecord(value.sessionTimeRange)
      || !isInboxTimestampRangeOrEmpty(
        value.sessionTimeRange.from,
        value.sessionTimeRange.to,
      )
      || !isInboxDurationConsistent(
        value.sessionTimeRange.from,
        value.sessionTimeRange.to,
        value.sessionTimeRange.durationMs,
      )
    )
  ) return false;
  if (value.skillInvocationCounts !== undefined) {
    const invocationCounts = value.skillInvocationCounts as Record<string, number>;
    const invocationTotal = safeInboxCountSum(Object.values(invocationCounts));
    if (invocationTotal !== value.segmentCount) return false;
    if (
      value.skillSessionCounts !== undefined
      && Object.entries(value.skillSessionCounts as Record<string, number>).some(([skillName, count]) =>
        count > (invocationCounts[skillName] ?? 0)
      )
    ) return false;
    if (
      value.skillInvocationLastSeen !== undefined
      && Object.keys(value.skillInvocationLastSeen as Record<string, string>).some((skillName) =>
        !Object.hasOwn(invocationCounts, skillName)
      )
    ) return false;
    if (
      value.skillToolCallCounts !== undefined
      && Object.keys(value.skillToolCallCounts as Record<string, Record<string, number>>).some((skillName) =>
        !Object.hasOwn(invocationCounts, skillName)
      )
    ) return false;
  }
  return value.sessionTimeRanges === undefined
    || (
      Array.isArray(value.sessionTimeRanges)
      && value.sessionTimeRanges.every(isObservationSessionTimeRange)
    );
}

function isObservationSourceRecordArchiveRef(value: unknown): boolean {
  if (!isInboxRecord(value)
    || typeof value.experienceSessionId !== 'string'
    || !['available', 'partial', 'unavailable'].includes(String(value.status))
    || (value.relativePath !== undefined && typeof value.relativePath !== 'string')
    || !isInboxCount(value.recordCount)
    || !isInboxCount(value.omittedRecordCount)
    || !isInboxCount(value.byteCount)
    || typeof value.truncated !== 'boolean') return false;
  if (value.status === 'unavailable' && value.relativePath !== undefined) return false;
  if (value.status !== 'unavailable' && typeof value.relativePath !== 'string') return false;
  return value.reason === undefined || [
    'no_record_ranges',
    'source_missing',
    'unsupported_source',
    'read_failed',
    'archive_limit',
  ].includes(String(value.reason));
}

function isObservationSessionTimeRange(value: unknown): boolean {
  return isInboxRecord(value)
    && typeof value.sessionId === 'string'
    && (value.traceId === undefined || typeof value.traceId === 'string')
    && (value.sessionGroupId === undefined || typeof value.sessionGroupId === 'string')
    && typeof value.sourceTrace === 'string'
    && isTraceSourceKind(value.sourceKind)
    && (
      value.traceRole === undefined
      || value.traceRole === 'standalone'
      || value.traceRole === 'main'
      || value.traceRole === 'subagent'
    )
    && (value.traceLabel === undefined || typeof value.traceLabel === 'string')
    && (value.cwd === undefined || typeof value.cwd === 'string')
    && isInboxOptionalTimestamp(value.startTimestamp)
    && isInboxOptionalTimestamp(value.endTimestamp)
    && isInboxDurationConsistent(
      value.startTimestamp,
      value.endTimestamp,
      value.durationMs,
    );
}

function isObservationInboxItem(value: unknown): value is ObservationInboxItem {
  if (
    !isInboxRecord(value)
    || typeof value.id !== 'string'
    || typeof value.skillName !== 'string'
    || typeof value.artifactVersion !== 'string'
    || (value.artifactHash !== undefined && typeof value.artifactHash !== 'string')
    || (value.cwd !== undefined && typeof value.cwd !== 'string')
    || typeof value.sessionId !== 'string'
    || (value.traceId !== undefined && typeof value.traceId !== 'string')
    || typeof value.sourceTrace !== 'string'
    || (
      value.sourceKind !== undefined
      && !isTraceSourceKind(value.sourceKind)
    )
    || !isObservationSignalType(value.signalType)
    || !isObservationSignalSubtype(value.signalSubtype)
    || !isInboxRate(value.confidence)
    || !isInboxRate(value.attributionConfidence)
    || !isObservationSeverity(value.severity)
    || (
      value.severityReasonCode !== undefined
      && !isObservationSeverityReasonCode(value.severityReasonCode)
    )
    || (value.severityReason !== undefined && typeof value.severityReason !== 'string')
    || (
      value.captureCoverage !== undefined
      && !isObservationCaptureCoverage(value.captureCoverage)
    )
    || !isObservationEvidence(value.evidence)
    || !isInboxTimestampRange(value.firstSeen, value.lastSeen)
    || !isInboxCount(value.occurrences)
    || value.occurrences === 0
    || (
      value.timestampedOccurrences !== undefined
      && (
        !isInboxCount(value.timestampedOccurrences)
        || value.timestampedOccurrences > value.occurrences
      )
    )
    || !isInboxStringArray(value.recentSessionIds)
    || (
      value.recentTraceIds !== undefined
      && !isInboxStringArray(value.recentTraceIds)
    )
    || !Array.isArray(value.representativeEvidence)
    || !value.representativeEvidence.every(isObservationEvidence)
  ) return false;
  const timestampedOccurrences = value.timestampedOccurrences === undefined
    ? (
        value.firstSeen === UNOBSERVED_TIMESTAMP && value.lastSeen === UNOBSERVED_TIMESTAMP
          ? 0
          : value.occurrences
      )
    : value.timestampedOccurrences;
  if (
    timestampedOccurrences === 0
      ? value.firstSeen !== UNOBSERVED_TIMESTAMP || value.lastSeen !== UNOBSERVED_TIMESTAMP
      : value.firstSeen === UNOBSERVED_TIMESTAMP || value.lastSeen === UNOBSERVED_TIMESTAMP
  ) return false;
  return value.messageWindow === undefined || isObservationMessageWindow(value.messageWindow);
}

function isObservationEvidence(value: unknown): boolean {
  if (!isInboxRecord(value)) return false;
  const strings = [
    value.traceId,
    value.sessionId,
    value.sourceTrace,
    value.tool,
    value.query,
    value.path,
    value.outputSnippet,
    value.assistantSnippet,
    value.userFeedbackSnippet,
    value.submittedEvidenceSnippet,
    value.markerToken,
    value.messageUuid,
    value.callInstanceId,
    value.toolUseId,
    value.segmentTimestamp,
  ];
  return strings.slice(0, -1).every((field) => field === undefined || typeof field === 'string')
    && (value.sourceKind === undefined || isTraceSourceKind(value.sourceKind))
    && isInboxOptionalTimestamp(value.segmentTimestamp)
    && (
      value.messageIndex === undefined
      || isInboxCount(value.messageIndex)
    );
}

function isObservationMessageWindow(value: unknown): boolean {
  return isInboxRecord(value)
    && Array.isArray(value.before)
    && value.before.every(isObservationMessageRef)
    && Array.isArray(value.event)
    && value.event.every(isObservationMessageRef)
    && Array.isArray(value.after)
    && value.after.every(isObservationMessageRef)
    && (
      value.resolutionAfter === 'resolved'
      || value.resolutionAfter === 'unresolved'
      || value.resolutionAfter === 'unknown'
    );
}

function isObservationMessageRef(value: unknown): boolean {
  return isInboxRecord(value)
    && (
      value.role === 'user'
      || value.role === 'assistant'
      || value.role === 'other'
    )
    && typeof value.snippet === 'string'
    && isInboxCount(value.messageIndex)
    && (value.uuid === undefined || typeof value.uuid === 'string')
    && isInboxOptionalTimestamp(value.timestamp);
}

function isObservationSignalType(value: unknown): value is ObservationSignalType {
  return value === 'failed_search'
    || value === 'repeated_failure'
    || value === 'hedging'
    || value === 'explicit_marker'
    || value === 'user_feedback';
}

function isObservationSignalSubtype(value: unknown): value is ObservationSignalSubtype {
  return value === 'hard_miss'
    || value === 'repeated_failure'
    || value === 'exploratory_miss'
    || value === 'tool_error'
    || value === 'permission_error'
    || value === 'bash_probe'
    || value === 'not_found'
    || value === 'transient_file_missing'
    || value === 'skill_asset_read_failed'
    || value === 'permission_denied'
    || value === 'tool_limit'
    || value === 'tool_failure'
    || value === 'regex_only'
    || value === 'llm_classified'
    || value === 'marker'
    || value === 'explicit_user_feedback';
}

function isObservationSeverity(value: unknown): boolean {
  return value === 'high' || value === 'medium' || value === 'low' || value === 'noise';
}

function isObservationSeverityReasonCode(value: unknown): boolean {
  return value === 'knowledge_gap_suspected'
    || value === 'repeated_failure_suspected'
    || value === 'explicit_gap_marker'
    || value === 'exploratory_probe'
    || value === 'skill_asset_unavailable'
    || value === 'soft_hedging_signal'
    || value === 'user_reported_knowledge_issue'
    || value === 'tool_or_runtime_noise';
}

function isInboxRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInboxCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isInboxRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function inboxRatesEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6;
}

function safeInboxCountSum(values: number[]): number | undefined {
  try {
    return sumRecordCounts(...values);
  } catch {
    return undefined;
  }
}

function isInboxTimestamp(value: unknown): value is string {
  return typeof value === 'string' && normalizeTraceTimestamp(value) !== undefined;
}

function isInboxOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isInboxTimestamp(value);
}

function isInboxTimestampRange(start: unknown, end: unknown): boolean {
  return isInboxTimestamp(start)
    && isInboxTimestamp(end)
    && Date.parse(start) <= Date.parse(end);
}

function isInboxTimestampRangeOrEmpty(start: unknown, end: unknown): boolean {
  return start === '' && end === '' || isInboxTimestampRange(start, end);
}

function isInboxDurationConsistent(start: unknown, end: unknown, duration: unknown): boolean {
  if (duration !== undefined && !isInboxCount(duration)) return false;
  if (start === undefined || end === undefined || start === '' || end === '') {
    return duration === undefined;
  }
  return typeof start === 'string'
    && typeof end === 'string'
    && isInboxTimestampRange(start, end)
    && duration === durationMsBetween(start, end);
}

function isInboxStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isInboxCountRecord(value: unknown): boolean {
  return isInboxRecord(value) && Object.values(value).every(isInboxCount);
}

function isInboxTimestampRecord(value: unknown): boolean {
  return isInboxRecord(value) && Object.values(value).every(isInboxTimestamp);
}

function loadLatestObservationInboxReport(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport | null {
  const reports = loadObservationInboxReports(dir);
  if (reports.length === 0) return null;
  return reports.sort((a, b) => b.meta.generatedAt.localeCompare(a.meta.generatedAt))[0] ?? null;
}

export function loadLatestObservationInboxReports(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxReport[] {
  const latest = loadLatestObservationInboxReport(dir);
  return latest ? [latest] : [];
}

export function queryObservationInbox(dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxItem[] {
  const reports = loadLatestObservationInboxReports(dir);
  return aggregateInboxItems([
    ...reports.flatMap((report) => report.items),
    ...loadExplicitObservationCaptureItems(dir),
  ]);
}

export function findObservationInboxItem(id: string, dir: string = DEFAULT_OBSERVATIONS_DIR): ObservationInboxItem | null {
  const reports = loadObservationInboxReports(dir);
  for (const item of [...reports].reverse().flatMap((report) => report.items)) {
    if (item.id === id) return item;
  }
  return aggregateInboxItems([
    ...reports.flatMap((report) => report.items),
    ...loadExplicitObservationCaptureItems(dir),
  ]).find((item) => item.id === id) ?? null;
}

export function selectExploreInboxItems(
  items: ObservationInboxItem[],
  limit: number,
  includeNoise = false,
  random: () => number = Math.random,
): ObservationInboxItem[] {
  const candidates = items
    .filter((item) => item.severity === 'medium' || item.severity === 'low' || (includeNoise && item.severity === 'noise'))
    .sort((a, b) =>
      Number(timestampedOccurrencesOf(b) > 0) - Number(timestampedOccurrencesOf(a) > 0)
      || b.lastSeen.localeCompare(a.lastSeen)
    )
    .slice(0, 50);
  const shuffled = [...candidates];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, limit);
}
