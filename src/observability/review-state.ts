import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ObservationMetricKey,
  ObservationMetricScope,
  ObservationReviewState,
  ObservationReviewStateEntry,
  ObservationReviewStateUpdate,
  ObservationReviewTargetType,
  ObservationReviewVerdict,
} from '../types/index.js';

export type {
  ObservationMetricKey,
  ObservationMetricScope,
  ObservationReviewState,
  ObservationReviewStateEntry,
  ObservationReviewStateUpdate,
  ObservationReviewTargetType,
  ObservationReviewVerdict,
};

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
    sourceTrace?: string;
    sessionId?: string;
    messageIndex?: number;
    messageUuid?: string;
    toolUseId?: string;
    metricScopeId?: string;
  },
  metricKey: ObservationMetricKey,
): string {
  const hasStableTraceRef = Boolean(ref.sourceTrace || ref.sessionId || ref.messageIndex !== undefined || ref.messageUuid || ref.toolUseId);
  const scope = observationMetricScopeFor(metricKey);
  const stable = [
    metricKey,
    ...(scope === 'skill_segment' ? [scope, ref.metricScopeId ?? ''] : []),
    ref.sourceTrace ?? '',
    ref.sessionId ?? '',
    ref.messageIndex === undefined ? '' : String(ref.messageIndex),
    ref.messageUuid ?? '',
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
  if (!state) return undefined;
  const targetId = observationMetricAnnotationTargetId(ref, metricKey);
  const entry = state.entries[observationReviewStateKey('evidence_metric', targetId)];
  return entry?.verdict === 'confirmed' || entry?.verdict === 'rejected' ? entry.verdict : undefined;
}

export function observationReviewStatePath(observationsDir: string): string {
  return join(observationsDir, 'review-state.json');
}

const OBSERVATION_REVIEW_STATE_SCHEMA_VERSION = 2;

export function emptyObservationReviewState(now = new Date().toISOString()): ObservationReviewState {
  return {
    kind: 'observe-review-state',
    schemaVersion: OBSERVATION_REVIEW_STATE_SCHEMA_VERSION,
    updatedAt: now,
    entries: {},
  };
}

export function loadObservationReviewState(observationsDir: string): ObservationReviewState {
  const path = observationReviewStatePath(observationsDir);
  if (!existsSync(path)) return emptyObservationReviewState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return normalizeObservationReviewState(parsed) ?? emptyObservationReviewState();
  } catch {
    return emptyObservationReviewState();
  }
}

export function updateObservationReviewState(
  observationsDir: string,
  update: ObservationReviewStateUpdate,
  now = new Date().toISOString(),
): ObservationReviewState {
  assertReviewStateUpdate(update);
  const state = loadObservationReviewState(observationsDir);
  const key = observationReviewStateKey(update.targetType, update.targetId);
  state.entries[key] = {
    targetType: update.targetType,
    targetId: update.targetId,
    verdict: update.verdict,
    reviewedAt: now,
    ...(update.note ? { note: update.note.slice(0, 500) } : {}),
    ...(update.reason ? { reason: update.reason.slice(0, 500) } : {}),
    ...(update.metricKey ? { metricKey: update.metricKey } : {}),
    ...(update.metricKey ? { metricScope: update.metricScope ?? observationMetricScopeFor(update.metricKey) } : {}),
    ...(update.metricScopeId ? { metricScopeId: update.metricScopeId.slice(0, 200) } : {}),
    ...(update.sourceTrace ? { sourceTrace: update.sourceTrace } : {}),
    ...(update.sessionId ? { sessionId: update.sessionId } : {}),
    ...(update.messageIndex !== undefined ? { messageIndex: update.messageIndex } : {}),
    ...(update.messageUuid ? { messageUuid: update.messageUuid } : {}),
    ...(update.toolUseId ? { toolUseId: update.toolUseId } : {}),
    ...(update.snippet ? { snippet: update.snippet.slice(0, 500) } : {}),
  };
  state.updatedAt = now;
  mkdirSync(observationsDir, { recursive: true });
  writeFileSync(observationReviewStatePath(observationsDir), JSON.stringify(state, null, 2));
  return state;
}

function normalizeObservationReviewState(value: unknown): ObservationReviewState | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Record<string, unknown>;
  const kind = parsed.kind === 'observe-review-state'
    ? parsed.kind
    : parsed.reportKind === 'observe-review-state'
      ? parsed.reportKind
      : null;
  if (!kind) return null;
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) return null;
  if (!parsed.entries || typeof parsed.entries !== 'object') return null;
  return {
    kind: 'observe-review-state',
    schemaVersion: OBSERVATION_REVIEW_STATE_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    entries: Object.fromEntries(
      Object.entries(parsed.entries).filter(([, entry]) => isReviewStateEntry(entry)),
    ),
  };
}

export function deleteObservationReviewState(
  observationsDir: string,
  targetType: ObservationReviewTargetType,
  targetId: string,
  now = new Date().toISOString(),
): ObservationReviewState {
  if (!isReviewTargetType(targetType)) throw new Error('invalid review targetType');
  if (typeof targetId !== 'string' || targetId.trim() === '') throw new Error('invalid review targetId');
  const state = loadObservationReviewState(observationsDir);
  const key = observationReviewStateKey(targetType, targetId);
  delete state.entries[key];
  state.updatedAt = now;
  mkdirSync(observationsDir, { recursive: true });
  writeFileSync(observationReviewStatePath(observationsDir), JSON.stringify(state, null, 2));
  return state;
}

function assertReviewStateUpdate(value: ObservationReviewStateUpdate): void {
  if (!isReviewTargetType(value.targetType)) throw new Error('invalid review targetType');
  if (typeof value.targetId !== 'string' || value.targetId.trim() === '') throw new Error('invalid review targetId');
  if (!isReviewVerdict(value.verdict)) throw new Error('invalid review verdict');
  if (value.targetType === 'evidence_metric' && !isObservationMetricKey(value.metricKey)) throw new Error('invalid metricKey');
  if (value.metricScope !== undefined && !isObservationMetricScope(value.metricScope)) throw new Error('invalid metricScope');
  if ((value.verdict === 'confirmed' || value.verdict === 'rejected') && value.targetType !== 'evidence_metric') throw new Error('metric verdict requires evidence_metric targetType');
}

function isReviewStateEntry(value: unknown): value is ObservationReviewStateEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<ObservationReviewStateEntry>;
  return isReviewTargetType(entry.targetType)
    && typeof entry.targetId === 'string'
    && isReviewVerdict(entry.verdict)
    && typeof entry.reviewedAt === 'string';
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
