import type { DiagnosisBundle } from '../../diagnosis/contracts.js';
import type { ObservationExperienceReport } from './experience.js';
import type { ObservationReviewState } from './review.js';
import type { ObservationSourceKind, TraceIngestionSummary } from './trace.js';

export type ObservationSignalType = 'failed_search' | 'repeated_failure' | 'hedging' | 'explicit_marker' | 'user_feedback';
export type ObservationSeverityReasonCode =
  | 'knowledge_gap_suspected'
  | 'repeated_failure_suspected'
  | 'explicit_gap_marker'
  | 'exploratory_probe'
  | 'skill_asset_unavailable'
  | 'soft_hedging_signal'
  | 'user_reported_knowledge_issue'
  | 'tool_or_runtime_noise';
export type ObservationSignalSubtype =
  | 'hard_miss'
  | 'repeated_failure'
  | 'exploratory_miss'
  | 'tool_error'
  | 'permission_error'
  | 'bash_probe'
  | 'not_found'
  | 'transient_file_missing'
  | 'skill_asset_read_failed'
  | 'permission_denied'
  | 'tool_limit'
  | 'tool_failure'
  | 'regex_only'
  | 'llm_classified'
  | 'marker'
  | 'explicit_user_feedback';

export type ObservationCaptureObservedEventKind =
  | 'tool_boundary'
  | 'user_feedback'
  | 'submitted_evidence';

export type ObservationCaptureUnavailableEventKind =
  | 'full_conversation'
  | 'external_tool_calls'
  | 'hidden_reasoning';

export interface ObservationCaptureCoverage {
  coverageStatus: 'partial';
  capturePath: 'explicit_tool_call';
  observedEventKinds: ObservationCaptureObservedEventKind[];
  unavailableEventKinds: ObservationCaptureUnavailableEventKind[];
}

export interface ObservationEvidence {
  traceId?: string;
  sessionId?: string;
  sourceTrace?: string;
  sourceKind?: ObservationSourceKind;
  tool?: string;
  query?: string;
  path?: string;
  outputSnippet?: string;
  assistantSnippet?: string;
  userFeedbackSnippet?: string;
  submittedEvidenceSnippet?: string;
  markerToken?: string;
  messageIndex?: number;
  messageUuid?: string;
  callInstanceId?: string;
  toolUseId?: string;
  segmentTimestamp?: string;
}

export interface ObservationMessageRef {
  role: 'user' | 'assistant' | 'other';
  snippet: string;
  messageIndex: number;
  uuid?: string;
  timestamp?: string;
}

export interface ObservationMessageWindow {
  before: ObservationMessageRef[];
  event: ObservationMessageRef[];
  after: ObservationMessageRef[];
  resolutionAfter: 'resolved' | 'unresolved' | 'unknown';
}

export interface ObservationInboxItem {
  id: string;
  skillName: string;
  artifactVersion: string | 'unknown';
  artifactHash?: string;
  cwd?: string;
  sessionId: string;
  /** Physical evidence stream identity; unlike sessionId, unique across reused run ids. */
  traceId?: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  signalType: ObservationSignalType;
  signalSubtype: ObservationSignalSubtype;
  confidence: number;
  attributionConfidence: number;
  severity: 'high' | 'medium' | 'low' | 'noise';
  severityReasonCode?: ObservationSeverityReasonCode;
  severityReason?: string;
  captureCoverage?: ObservationCaptureCoverage;
  evidence: ObservationEvidence;
  messageWindow?: ObservationMessageWindow;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  /** Occurrences backed by an observed source timestamp. */
  timestampedOccurrences?: number;
  recentSessionIds: string[];
  recentTraceIds?: string[];
  representativeEvidence: ObservationEvidence[];
}

export interface ObservationSessionTimeRange {
  sessionId: string;
  traceId?: string;
  sessionGroupId?: string;
  sourceTrace: string;
  sourceKind: ObservationSourceKind;
  traceRole?: 'standalone' | 'main' | 'subagent';
  traceLabel?: string;
  cwd?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  durationMs?: number;
}

export type ObservationSourceRecordArchiveStatus = 'available' | 'partial' | 'unavailable';
export type ObservationSourceRecordArchiveReason =
  | 'no_record_ranges'
  | 'source_missing'
  | 'unsupported_source'
  | 'read_failed'
  | 'archive_limit';

/**
 * A report only retains a relative pointer to its bounded source-record archive.
 * The archive itself stays beside the report so Studio never follows an
 * arbitrary absolute path supplied by report JSON.
 */
export interface ObservationSourceRecordArchiveRef {
  experienceSessionId: string;
  status: ObservationSourceRecordArchiveStatus;
  relativePath?: string;
  recordCount: number;
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
  reason?: ObservationSourceRecordArchiveReason;
}

export interface ObservationSourceRecord {
  sourceIndex: number;
  traceId: string;
  sourceTrace: string;
  sourceType: string;
  sourceEventId?: string;
  timestamp?: string;
  raw: string;
  byteCount: number;
  truncated: boolean;
  redacted: boolean;
}

export interface ObservationSourceRecordArchive {
  archiveKind: 'observe-source-records';
  schemaVersion: 1;
  experienceSessionId: string;
  generatedAt: string;
  records: ObservationSourceRecord[];
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
}

export interface ObservationSourceRecordArchiveView {
  status: ObservationSourceRecordArchiveStatus;
  /** Total retained records, even when `records` is intentionally lazy. */
  recordCount: number;
  records: ObservationSourceRecord[];
  omittedRecordCount: number;
  byteCount: number;
  truncated: boolean;
  reason?: ObservationSourceRecordArchiveReason | 'archive_invalid';
}

export interface ObservationInboxReport {
  kind: 'observe-inbox';
  schemaVersion: 2;
  meta: {
    tracePath: string;
    generatedAt: string;
    sessionCount?: number;
    sessionTimeRange?: {
      from: string;
      to: string;
      durationMs?: number;
    };
    sessionTimeRanges?: ObservationSessionTimeRange[];
    ingestion?: TraceIngestionSummary;
    segmentCount: number;
    itemCount: number;
    skillInvocationCounts?: Record<string, number>;
    skillSessionCounts?: Record<string, number>;
    skillInvocationLastSeen?: Record<string, string>;
    skillToolCallCounts?: Record<string, Record<string, number>>;
    timestampedSegmentCount?: number;
    timestampCoverage?: number;
    sourceRecordArchives?: ObservationSourceRecordArchiveRef[];
  };
  items: ObservationInboxItem[];
  experience?: ObservationExperienceReport;
  diagnostics?: DiagnosisBundle;
}

export interface ObservationSkillRollup {
  skillName: string;
  invocationCount: number;
  sessionCount: number;
  observationCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  noiseCount: number;
  latestSeen: string;
}

export interface BuildObservationInboxReportOptions {
  reviewState?: ObservationReviewState;
}
