import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  ObservationMetricKey,
  ObservationMetricScope,
  ObservationReviewState,
  ObservationReviewStateEntry,
  ObservationReviewStateUpdate,
  ObservationReviewTargetType,
  ObservationReviewVerdict,
} from '../contracts/review.js';
import { writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { withFileLock } from '../../shared/file-lock.js';
import { normalizeRfc3339Timestamp } from '../../shared/timestamp.js';
import { ensureOwnedLayoutForPath } from '../../omk-layout/index.js';
import { resolveObservationsDir } from './paths.js';

export type {
  ObservationMetricKey,
  ObservationMetricScope,
  ObservationReviewState,
  ObservationReviewStateEntry,
  ObservationReviewStateUpdate,
  ObservationReviewTargetType,
  ObservationReviewVerdict,
};

export class ObservationReviewStateValidationError extends Error {
  override readonly name = 'ObservationReviewStateValidationError';
}

export function observationReviewStateKey(targetType: ObservationReviewTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}

export function observationMetricScopeFor(metricKey: ObservationMetricKey): ObservationMetricScope {
  return metricKey === 'user_correction'
    || metricKey === 'user_interruption'
    || metricKey === 'user_follow_up'
    || metricKey === 'hard_rule'
    || metricKey === 'user_goal_shift'
    ? 'skill_segment'
    : 'message';
}

export function observationMetricAnnotationTargetId(
  ref: {
    id?: string;
    traceId?: string;
    sourceTrace?: string;
    sessionId?: string;
    messageIndex?: number;
    messageUuid?: string;
    callInstanceId?: string;
    toolUseId?: string;
    metricScopeId?: string;
  },
  metricKey: ObservationMetricKey,
): string {
  const hasStableTraceRef = Boolean(
    ref.traceId
    || ref.sourceTrace
    || ref.sessionId
    || ref.messageIndex !== undefined
    || ref.messageUuid
    || ref.callInstanceId
    || ref.toolUseId,
  );
  const scope = observationMetricScopeFor(metricKey);
  const stable = [
    metricKey,
    ...(scope === 'skill_segment' ? [scope, ref.metricScopeId ?? ''] : []),
    ref.traceId ?? '',
    ref.sourceTrace ?? '',
    ref.sessionId ?? '',
    ref.messageIndex === undefined ? '' : String(ref.messageIndex),
    ref.messageUuid ?? '',
    ref.callInstanceId ?? '',
    ref.toolUseId ?? '',
    hasStableTraceRef ? '' : ref.id ?? '',
  ].join('\u0000');
  return `metric:${metricKey}:${createHash('sha256').update(stable).digest('hex').slice(0, 16)}`;
}

export function observationMetricAnnotationVerdict(
  state: ObservationReviewState | undefined,
  ref: Parameters<typeof observationMetricAnnotationTargetId>[0],
  metricKey: ObservationMetricKey,
): 'confirmed' | 'rejected' | undefined {
  const entry = observationMetricAnnotationEntry(state, ref, metricKey);
  return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected'
    ? entry.verdict
    : undefined;
}

export function observationMetricAnnotationEntry(
  state: ObservationReviewState | undefined,
  ref: Parameters<typeof observationMetricAnnotationTargetId>[0],
  metricKey: ObservationMetricKey,
): ObservationReviewStateEntry | undefined {
  if (!state) return undefined;
  const candidates = [
    ref,
    ...(ref.callInstanceId ? [{ ...ref, callInstanceId: undefined }] : []),
    ...(ref.traceId ? [{ ...ref, traceId: undefined }] : []),
    ...(ref.traceId && ref.callInstanceId
      ? [{ ...ref, traceId: undefined, callInstanceId: undefined }]
      : []),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const targetId = observationMetricAnnotationTargetId(candidate, metricKey);
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    const entry = state.entries[observationReviewStateKey('evidence_metric', targetId)];
    if (entry) return entry;
  }
  return undefined;
}

export function observationReviewStatePath(observationsDir: string): string {
  return join(observationsDir, 'review-state.json');
}

const OBSERVATION_REVIEW_STATE_SCHEMA_VERSION = 2;

export function emptyObservationReviewState(now = new Date().toISOString()): ObservationReviewState {
  const updatedAt = normalizedTimestamp(now);
  if (!updatedAt) throw new ObservationReviewStateValidationError('invalid updatedAt');
  return {
    kind: 'observe-review-state',
    schemaVersion: OBSERVATION_REVIEW_STATE_SCHEMA_VERSION,
    updatedAt,
    entries: {},
  };
}

export function loadObservationReviewState(observationsDir: string): ObservationReviewState {
  const path = observationReviewStatePath(resolveObservationsDir(observationsDir));
  if (!existsSync(path)) return emptyObservationReviewState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (cause) {
    throw new Error(`无法读取观测复核状态：${path}`, { cause });
  }
  const normalized = normalizeObservationReviewState(parsed);
  if (!normalized) throw new Error(`观测复核状态格式无效：${path}`);
  return normalized;
}

export function updateObservationReviewState(
  observationsDir: string,
  update: ObservationReviewStateUpdate,
  now?: string,
): ObservationReviewState {
  assertReviewStateUpdate(update);
  ensureOwnedLayoutForPath(observationsDir);
  const path = observationReviewStatePath(observationsDir);
  return withFileLock(`${path}.lock`, () => {
    const reviewedAt = normalizedTimestamp(now ?? new Date().toISOString());
    if (!reviewedAt) {
      throw new ObservationReviewStateValidationError('invalid reviewedAt');
    }
    const hadPersistedState = existsSync(path);
    const state = loadObservationReviewState(observationsDir);
    if (hadPersistedState && reviewedAt < state.updatedAt) {
      throw new ObservationReviewStateValidationError(
        'reviewedAt cannot precede state updatedAt',
      );
    }
    const key = observationReviewStateKey(update.targetType, update.targetId);
    state.entries[key] = {
      targetType: update.targetType,
      targetId: update.targetId,
      verdict: update.verdict,
      reviewedAt,
      ...(update.note ? { note: update.note.slice(0, 500) } : {}),
      ...(update.reason ? { reason: update.reason.slice(0, 500) } : {}),
      ...(update.metricKey ? { metricKey: update.metricKey } : {}),
      ...(update.metricKey ? {
        metricScope: update.metricScope ?? observationMetricScopeFor(update.metricKey),
      } : {}),
      ...(update.metricScopeId ? { metricScopeId: update.metricScopeId.slice(0, 200) } : {}),
      ...(update.traceId ? { traceId: update.traceId } : {}),
      ...(update.sourceTrace ? { sourceTrace: update.sourceTrace } : {}),
      ...(update.sessionId ? { sessionId: update.sessionId } : {}),
      ...(update.messageIndex !== undefined ? { messageIndex: update.messageIndex } : {}),
      ...(update.messageUuid ? { messageUuid: update.messageUuid } : {}),
      ...(update.callInstanceId ? { callInstanceId: update.callInstanceId } : {}),
      ...(update.toolUseId ? { toolUseId: update.toolUseId } : {}),
      ...(update.snippet ? { snippet: update.snippet.slice(0, 500) } : {}),
    };
    state.updatedAt = reviewedAt;
    writeObservationReviewState(observationsDir, state);
    return state;
  }, { label: 'observation review state' });
}

function normalizeObservationReviewState(value: unknown): ObservationReviewState | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Record<string, unknown>;
  const kind = parsed.kind === 'observe-review-state' ? parsed.kind : null;
  if (!kind) return null;
  if (parsed.schemaVersion !== OBSERVATION_REVIEW_STATE_SCHEMA_VERSION) return null;
  if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return null;
  const updatedAt = normalizedTimestamp(parsed.updatedAt);
  if (!updatedAt) return null;
  const entries: Record<string, ObservationReviewStateEntry> = {};
  for (const [key, rawEntry] of Object.entries(parsed.entries)) {
    const entry = normalizeReviewStateEntry(rawEntry);
    if (!entry || key !== observationReviewStateKey(entry.targetType, entry.targetId)) return null;
    entries[key] = entry;
  }
  if (Object.values(entries).some((entry) => entry.reviewedAt > updatedAt)) return null;
  return {
    kind: 'observe-review-state',
    schemaVersion: OBSERVATION_REVIEW_STATE_SCHEMA_VERSION,
    updatedAt,
    entries,
  };
}

export function deleteObservationReviewState(
  observationsDir: string,
  targetType: ObservationReviewTargetType,
  targetId: string,
  now?: string,
): ObservationReviewState {
  if (!isReviewTargetType(targetType)) throw new ObservationReviewStateValidationError('invalid review targetType');
  if (typeof targetId !== 'string' || targetId.trim() === '') throw new ObservationReviewStateValidationError('invalid review targetId');
  ensureOwnedLayoutForPath(observationsDir);
  const path = observationReviewStatePath(observationsDir);
  return withFileLock(`${path}.lock`, () => {
    const updatedAt = normalizedTimestamp(now ?? new Date().toISOString());
    if (!updatedAt) {
      throw new ObservationReviewStateValidationError('invalid updatedAt');
    }
    const hadPersistedState = existsSync(path);
    const state = loadObservationReviewState(observationsDir);
    if (hadPersistedState && updatedAt < state.updatedAt) {
      throw new ObservationReviewStateValidationError(
        'updatedAt cannot precede state updatedAt',
      );
    }
    const key = observationReviewStateKey(targetType, targetId);
    delete state.entries[key];
    state.updatedAt = updatedAt;
    writeObservationReviewState(observationsDir, state);
    return state;
  }, { label: 'observation review state' });
}

function assertReviewStateUpdate(value: ObservationReviewStateUpdate): void {
  if (!isReviewTargetType(value.targetType)) throw new ObservationReviewStateValidationError('invalid review targetType');
  if (typeof value.targetId !== 'string' || value.targetId.trim() === '') throw new ObservationReviewStateValidationError('invalid review targetId');
  if (!isReviewVerdict(value.verdict)) throw new ObservationReviewStateValidationError('invalid review verdict');
  const optionalStrings = [
    value.note,
    value.reason,
    value.metricScopeId,
    value.traceId,
    value.sourceTrace,
    value.sessionId,
    value.messageUuid,
    value.callInstanceId,
    value.toolUseId,
    value.snippet,
  ];
  if (!optionalStrings.every(optionalString)) throw new ObservationReviewStateValidationError('invalid review metadata');
  if (
    value.messageIndex !== undefined
    && (!Number.isSafeInteger(value.messageIndex) || value.messageIndex < 0)
  ) throw new ObservationReviewStateValidationError('invalid messageIndex');
  if (value.targetType === 'evidence_metric') {
    if (!isObservationMetricKey(value.metricKey)) throw new ObservationReviewStateValidationError('invalid metricKey');
    if (value.verdict !== 'confirmed' && value.verdict !== 'rejected') {
      throw new ObservationReviewStateValidationError('evidence_metric requires confirmed or rejected verdict');
    }
    const expectedScope = observationMetricScopeFor(value.metricKey);
    if (value.metricScope !== undefined && value.metricScope !== expectedScope) {
      throw new ObservationReviewStateValidationError('metricScope does not match metricKey');
    }
  } else {
    if (value.verdict === 'confirmed' || value.verdict === 'rejected') {
      throw new ObservationReviewStateValidationError('metric verdict requires evidence_metric targetType');
    }
    if (value.metricKey !== undefined || value.metricScope !== undefined || value.metricScopeId !== undefined) {
      throw new ObservationReviewStateValidationError('metric metadata requires evidence_metric targetType');
    }
  }
}

function normalizeReviewStateEntry(value: unknown): ObservationReviewStateEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<ObservationReviewStateEntry>;
  const reviewedAt = normalizedTimestamp(entry.reviewedAt);
  if (
    !isReviewTargetType(entry.targetType)
    || typeof entry.targetId !== 'string'
    || entry.targetId.trim() === ''
    || !isReviewVerdict(entry.verdict)
    || !reviewedAt
    || !optionalString(entry.note)
    || !optionalString(entry.reason)
    || !optionalString(entry.metricScopeId)
    || !optionalString(entry.traceId)
    || !optionalString(entry.sourceTrace)
    || !optionalString(entry.sessionId)
    || !optionalString(entry.messageUuid)
    || !optionalString(entry.callInstanceId)
    || !optionalString(entry.toolUseId)
    || !optionalString(entry.snippet)
    || (
      entry.messageIndex !== undefined
      && (!Number.isSafeInteger(entry.messageIndex) || entry.messageIndex < 0)
    )
    || (entry.metricKey !== undefined && !isObservationMetricKey(entry.metricKey))
    || (entry.metricScope !== undefined && !isObservationMetricScope(entry.metricScope))
  ) return null;
  if (entry.targetType === 'evidence_metric') {
    if (
      !isObservationMetricKey(entry.metricKey)
      || (entry.verdict !== 'confirmed' && entry.verdict !== 'rejected')
    ) return null;
  } else if (
    entry.verdict === 'confirmed'
    || entry.verdict === 'rejected'
    || entry.metricKey !== undefined
    || entry.metricScope !== undefined
    || entry.metricScopeId !== undefined
  ) {
    return null;
  }
  const metricScope = entry.metricKey
    ? entry.metricScope ?? observationMetricScopeFor(entry.metricKey)
    : undefined;
  if (
    entry.metricKey
    && metricScope !== observationMetricScopeFor(entry.metricKey)
  ) return null;
  return {
    targetType: entry.targetType,
    targetId: entry.targetId,
    verdict: entry.verdict,
    reviewedAt,
    ...(entry.note !== undefined ? { note: entry.note } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    ...(entry.metricKey !== undefined ? { metricKey: entry.metricKey, metricScope } : {}),
    ...(entry.metricScopeId !== undefined ? { metricScopeId: entry.metricScopeId } : {}),
    ...(entry.traceId !== undefined ? { traceId: entry.traceId } : {}),
    ...(entry.sourceTrace !== undefined ? { sourceTrace: entry.sourceTrace } : {}),
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    ...(entry.messageIndex !== undefined ? { messageIndex: entry.messageIndex } : {}),
    ...(entry.messageUuid !== undefined ? { messageUuid: entry.messageUuid } : {}),
    ...(entry.callInstanceId !== undefined ? { callInstanceId: entry.callInstanceId } : {}),
    ...(entry.toolUseId !== undefined ? { toolUseId: entry.toolUseId } : {}),
    ...(entry.snippet !== undefined ? { snippet: entry.snippet } : {}),
  };
}

function normalizedTimestamp(value: unknown): string | null {
  return normalizeRfc3339Timestamp(value) ?? null;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function writeObservationReviewState(
  observationsDir: string,
  state: ObservationReviewState,
): void {
  const path = observationReviewStatePath(observationsDir);
  writeJsonFileAtomic(path, state);
}

function isReviewTargetType(value: unknown): value is ObservationReviewTargetType {
  return value === 'experience_session'
    || value === 'inbox_item'
    || value === 'skill'
    || value === 'goal_slice_correction'
    || value === 'evidence_metric'
    || value === 'reviewer_judgment'
    || value === 'soft_standard'
    || value === 'goal_keyword_correction'
    || value === 'result_artifact_correction'
    || value === 'completion_result_correction'
    || value === 'deliverable_artifact_correction'
    || value === 'skill_relevance_correction'
    || value === 'workflow_completion_correction'
    || value === 'hardrule_execution_correction'
    || value === 'main_tool_execution_correction';
}

function isReviewVerdict(value: unknown): value is ObservationReviewVerdict {
  return value === 'reviewed' || value === 'real_issue' || value === 'not_issue' || value === 'needs_more_context' || value === 'confirmed' || value === 'rejected';
}

function isObservationMetricScope(value: unknown): value is ObservationMetricScope {
  return value === 'message' || value === 'skill_segment';
}

function isObservationMetricKey(value: unknown): value is ObservationMetricKey {
  return value === 'user_correction'
    || value === 'user_interruption'
    || value === 'user_follow_up'
    || value === 'negative_feedback'
    || value === 'positive_feedback'
    || value === 'hard_rule'
    || value === 'user_goal_shift'
    || value === 'result_artifact'
    || value === 'completion_result'
    || value === 'deliverable_artifact'
    || value === 'progress_update'
    || value === 'self_correction'
    || value === 'repeated_execution';
}
