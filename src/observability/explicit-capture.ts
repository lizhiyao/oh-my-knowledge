import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ObservationCaptureCoverage,
  ObservationEvidence,
  ObservationInboxItem,
} from '../types/index.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { withFileLock } from '../shared/file-lock.js';
import {
  buildExplicitObservationCaptureCoverage,
  isObservationCaptureCoverage,
} from './capture-coverage.js';
import { aggregateObservationInboxItemId } from './inbox-identity.js';
import {
  DEFAULT_GLOBAL_OBSERVATIONS_DIR,
  DEFAULT_OBSERVATIONS_DIR,
  DEFAULT_PROJECT_OBSERVATIONS_DIR,
} from './observation-paths.js';

const CAPTURE_SCHEMA_VERSION = 1;
const CAPTURES_DIR_NAME = 'captures';
const CAPTURE_FILE_SUFFIX = '.capture.json';

export type ObservationCaptureSourceKind = 'mcp';

export interface ExplicitObservationCaptureInput {
  captureSourceKind: ObservationCaptureSourceKind;
  skillName: string;
  userFeedback: string;
  evidenceSnippet?: string;
  artifactVersion?: string;
  artifactHash?: string;
  cwd?: string;
  sourceConversationId?: string;
  sourceTurnId?: string;
  captureId?: string;
  confirmedByUser: boolean;
}

export interface ExplicitObservationCaptureOptions {
  observationsDir?: string;
  now?: () => Date;
}

export interface ExplicitObservationCaptureResult {
  observationId: string;
  capturedAt: string;
  captureCoverage: ObservationCaptureCoverage;
  reviewPath: string;
  created: boolean;
}

export interface ExplicitObservationCaptureRecord {
  captureKind: 'explicit_observation';
  schemaVersion: 1;
  captureId: string;
  payloadHash: string;
  capturedAt: string;
  captureSourceKind: 'mcp';
  skillName: string;
  userFeedback: string;
  evidenceSnippet?: string;
  artifactVersion: string;
  artifactHash?: string;
  cwd?: string;
  captureCoverage: ObservationCaptureCoverage;
}

export class ExplicitObservationCaptureConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExplicitObservationCaptureConflictError';
  }
}

export function captureExplicitObservation(
  rawInput: ExplicitObservationCaptureInput,
  options: ExplicitObservationCaptureOptions = {},
): ExplicitObservationCaptureResult {
  const record = prepareExplicitObservationCaptureRecord(rawInput, options);
  const observationsDir = options.observationsDir ?? DEFAULT_OBSERVATIONS_DIR;
  const recordPath = explicitCaptureRecordPath(observationsDir, record.captureId);

  return withFileLock(`${recordPath}.lock`, () => {
    const existing = loadExplicitObservationCaptureRecord(recordPath);
    if (existing) {
      assertCompatibleExplicitObservationCapture(existing, record);
      return explicitObservationCaptureResult(existing, false);
    }
    if (existsSync(recordPath)) {
      throw new Error('目标 capture record 已存在但无法解析，拒绝覆盖。');
    }
    writeJsonFileAtomic(recordPath, record);
    return explicitObservationCaptureResult(record, true);
  }, { label: 'explicit observation capture' });
}

export function prepareExplicitObservationCaptureRecord(
  rawInput: ExplicitObservationCaptureInput,
  options: Pick<ExplicitObservationCaptureOptions, 'now'> = {},
): ExplicitObservationCaptureRecord {
  const input = normalizeCaptureInput(rawInput);
  const capturedAt = (options.now ?? (() => new Date()))().toISOString();
  const payloadHash = hashJson({
    skillName: input.skillName,
    userFeedback: input.userFeedback,
    evidenceSnippet: input.evidenceSnippet,
    artifactVersion: input.artifactVersion,
    artifactHash: input.artifactHash,
    cwd: input.cwd,
  });
  const turnIdentity = [input.sourceConversationId, input.sourceTurnId]
    .filter(Boolean)
    .join('\u0000');
  const sourceIdentity = `${input.captureSourceKind}\u0000${input.captureId ?? (turnIdentity || payloadHash)}`;
  const captureId = hashText(`explicit-observation\u0000${sourceIdentity}`);
  const captureCoverage = buildExplicitObservationCaptureCoverage(Boolean(input.evidenceSnippet));
  return {
    captureKind: 'explicit_observation',
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId,
    payloadHash,
    capturedAt,
    captureSourceKind: input.captureSourceKind,
    skillName: input.skillName,
    userFeedback: input.userFeedback,
    evidenceSnippet: input.evidenceSnippet,
    artifactVersion: input.artifactVersion,
    artifactHash: input.artifactHash,
    cwd: input.cwd,
    captureCoverage,
  };
}

export function assertCompatibleExplicitObservationCapture(
  existing: ExplicitObservationCaptureRecord,
  candidate: ExplicitObservationCaptureRecord,
): void {
  if (existing.captureId !== candidate.captureId || existing.payloadHash !== candidate.payloadHash) {
    throw new ExplicitObservationCaptureConflictError(
      'captureId 或对话 turn identity 已用于不同的 observation payload。',
    );
  }
}

export function loadExplicitObservationCaptureRecords(
  observationsDir: string = DEFAULT_OBSERVATIONS_DIR,
): ExplicitObservationCaptureRecord[] {
  const capturesDir = join(observationsDir, CAPTURES_DIR_NAME);
  if (!existsSync(capturesDir)) {
    if (
      observationsDir === DEFAULT_PROJECT_OBSERVATIONS_DIR
      && !existsSync(observationsDir)
    ) return loadExplicitObservationCaptureRecords(DEFAULT_GLOBAL_OBSERVATIONS_DIR);
    return [];
  }
  return readdirSync(capturesDir)
    .filter((file) => file.endsWith(CAPTURE_FILE_SUFFIX))
    .sort()
    .flatMap((file) => {
      const record = loadExplicitObservationCaptureRecord(join(capturesDir, file));
      return record ? [record] : [];
    });
}

export function loadExplicitObservationCaptureItems(
  observationsDir: string = DEFAULT_OBSERVATIONS_DIR,
): ObservationInboxItem[] {
  return loadExplicitObservationCaptureRecords(observationsDir).map(projectCaptureRecord);
}

function explicitCaptureRecordPath(observationsDir: string, captureId: string): string {
  return join(observationsDir, CAPTURES_DIR_NAME, `${captureId}${CAPTURE_FILE_SUFFIX}`);
}

function loadExplicitObservationCaptureRecord(path: string): ExplicitObservationCaptureRecord | null {
  try {
    return normalizeExplicitObservationCaptureRecord(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

function normalizeExplicitObservationCaptureRecord(value: unknown): ExplicitObservationCaptureRecord | null {
  if (!isRecord(value)) return null;
  if (
    value.captureKind !== 'explicit_observation'
    || value.schemaVersion !== CAPTURE_SCHEMA_VERSION
    || value.captureSourceKind !== 'mcp'
    || !isBoundedText(value.captureId, 64)
    || !isBoundedText(value.payloadHash, 64)
    || !isIsoTimestamp(value.capturedAt)
    || !isBoundedText(value.skillName, 120)
    || !isBoundedText(value.userFeedback, 4_000)
    || !isOptionalBoundedText(value.evidenceSnippet, 8_000)
    || !isBoundedText(value.artifactVersion, 256)
    || !isOptionalBoundedText(value.artifactHash, 256)
    || !isOptionalBoundedText(value.cwd, 2_048)
    || !isObservationCaptureCoverage(value.captureCoverage)
  ) return null;
  return value as unknown as ExplicitObservationCaptureRecord;
}

interface NormalizedCaptureInput {
  captureSourceKind: ObservationCaptureSourceKind;
  skillName: string;
  userFeedback: string;
  evidenceSnippet?: string;
  artifactVersion: string;
  artifactHash?: string;
  cwd?: string;
  sourceConversationId?: string;
  sourceTurnId?: string;
  captureId?: string;
}

function normalizeCaptureInput(input: ExplicitObservationCaptureInput): NormalizedCaptureInput {
  if (input.confirmedByUser !== true) {
    throw new Error('只有用户明确要求记录时，才能 capture observation。');
  }
  return {
    captureSourceKind: normalizeCaptureSourceKind(input.captureSourceKind),
    skillName: requiredText(input.skillName, 'skillName', 120),
    userFeedback: requiredText(input.userFeedback, 'userFeedback', 4_000),
    evidenceSnippet: optionalText(input.evidenceSnippet, 'evidenceSnippet', 8_000),
    artifactVersion: optionalText(input.artifactVersion, 'artifactVersion', 256) ?? 'unknown',
    artifactHash: optionalText(input.artifactHash, 'artifactHash', 256),
    cwd: optionalText(input.cwd, 'cwd', 2_048),
    sourceConversationId: optionalText(input.sourceConversationId, 'sourceConversationId', 512),
    sourceTurnId: optionalText(input.sourceTurnId, 'sourceTurnId', 512),
    captureId: optionalText(input.captureId, 'captureId', 512),
  };
}

function normalizeCaptureSourceKind(value: unknown): ObservationCaptureSourceKind {
  if (value !== 'mcp') throw new Error('不支持的 captureSourceKind。');
  return value;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空。`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${field} 不能超过 ${maxLength} 个字符。`);
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, field, maxLength);
}

function projectCaptureRecord(record: ExplicitObservationCaptureRecord): ObservationInboxItem {
  const sessionId = `explicit-capture:${record.captureId}`;
  const sourceTrace = `mcp:${record.captureId}`;
  const evidence: ObservationEvidence = {
    traceId: record.captureId,
    sessionId,
    sourceTrace,
    sourceKind: 'unknown',
    markerToken: `user-feedback:${hashText(record.userFeedback)}`,
    userFeedbackSnippet: record.userFeedback,
    submittedEvidenceSnippet: record.evidenceSnippet,
    callInstanceId: record.captureId,
    segmentTimestamp: record.capturedAt,
  };
  return {
    id: hashText(`capture-occurrence\u0000${record.captureId}`),
    skillName: record.skillName,
    artifactVersion: record.artifactVersion,
    artifactHash: record.artifactHash,
    cwd: record.cwd,
    sessionId,
    traceId: record.captureId,
    sourceTrace,
    sourceKind: 'unknown',
    signalType: 'user_feedback',
    signalSubtype: 'explicit_user_feedback',
    confidence: 0.9,
    attributionConfidence: 0.8,
    severity: 'high',
    severityReasonCode: 'user_reported_knowledge_issue',
    captureCoverage: record.captureCoverage,
    evidence,
    firstSeen: record.capturedAt,
    lastSeen: record.capturedAt,
    occurrences: 1,
    timestampedOccurrences: 1,
    recentSessionIds: [sessionId],
    recentTraceIds: [record.captureId],
    representativeEvidence: [evidence],
  };
}

export function explicitObservationCaptureResult(
  record: ExplicitObservationCaptureRecord,
  created: boolean,
): ExplicitObservationCaptureResult {
  const item = projectCaptureRecord(record);
  return {
    observationId: aggregateObservationInboxItemId(item),
    capturedAt: record.capturedAt,
    captureCoverage: record.captureCoverage,
    reviewPath: `/observe-inbox?skill=${encodeURIComponent(record.skillName)}`,
    created,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maxLength;
}

function isOptionalBoundedText(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedText(value, maxLength);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value));
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}
