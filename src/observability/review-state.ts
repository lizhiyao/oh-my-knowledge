import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ObservationReviewTargetType = 'experience_session' | 'inbox_item' | 'skill' | 'goal_slice_correction' | 'evidence_metric' | 'reviewer_judgment' | 'soft_standard';
export type ObservationReviewVerdict = 'reviewed' | 'real_issue' | 'not_issue' | 'needs_more_context' | 'confirmed' | 'rejected';
export type ObservationMetricKey =
  | 'user_correction'
  | 'user_interruption'
  | 'user_follow_up'
  | 'negative_feedback'
  | 'positive_feedback'
  | 'hard_rule'
  | 'user_goal_shift';

export interface ObservationReviewStateEntry {
  targetType: ObservationReviewTargetType;
  targetId: string;
  verdict: ObservationReviewVerdict;
  reviewedAt: string;
  note?: string;
  reason?: string;
  metricKey?: ObservationMetricKey;
  sourceTrace?: string;
  sessionId?: string;
  messageIndex?: number;
  messageUuid?: string;
  toolUseId?: string;
  snippet?: string;
}

export interface ObservationReviewState {
  kind: 'observe-review-state';
  schemaVersion: 1;
  updatedAt: string;
  entries: Record<string, ObservationReviewStateEntry>;
}

export interface ObservationReviewStateUpdate {
  targetType: ObservationReviewTargetType;
  targetId: string;
  verdict: ObservationReviewVerdict;
  note?: string;
  reason?: string;
  metricKey?: ObservationMetricKey;
  sourceTrace?: string;
  sessionId?: string;
  messageIndex?: number;
  messageUuid?: string;
  toolUseId?: string;
  snippet?: string;
}

export function observationReviewStateKey(targetType: ObservationReviewTargetType, targetId: string): string {
  return `${targetType}:${targetId}`;
}

export function observationMetricAnnotationTargetId(
  ref: {
    id?: string;
    sourceTrace?: string;
    sessionId?: string;
    messageIndex?: number;
    messageUuid?: string;
    toolUseId?: string;
  },
  metricKey: ObservationMetricKey,
): string {
  const hasStableTraceRef = Boolean(ref.sourceTrace || ref.sessionId || ref.messageIndex !== undefined || ref.messageUuid || ref.toolUseId);
  const stable = [
    metricKey,
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

export function emptyObservationReviewState(now = new Date().toISOString()): ObservationReviewState {
  return {
    kind: 'observe-review-state',
    schemaVersion: 1,
    updatedAt: now,
    entries: {},
  };
}

export function loadObservationReviewState(observationsDir: string): ObservationReviewState {
  const path = observationReviewStatePath(observationsDir);
  if (!existsSync(path)) return emptyObservationReviewState();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ObservationReviewState>;
    if (parsed.kind !== 'observe-review-state' || parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
      return emptyObservationReviewState();
    }
    return {
      kind: 'observe-review-state',
      schemaVersion: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      entries: Object.fromEntries(
        Object.entries(parsed.entries).filter(([, entry]) => isReviewStateEntry(entry)),
      ),
    };
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
    || value === 'soft_standard';
}

function isReviewVerdict(value: unknown): value is ObservationReviewVerdict {
  return value === 'reviewed' || value === 'real_issue' || value === 'not_issue' || value === 'needs_more_context' || value === 'confirmed' || value === 'rejected';
}

function isObservationMetricKey(value: unknown): value is ObservationMetricKey {
  return value === 'user_correction'
    || value === 'user_interruption'
    || value === 'user_follow_up'
    || value === 'negative_feedback'
    || value === 'positive_feedback'
    || value === 'hard_rule'
    || value === 'user_goal_shift';
}
