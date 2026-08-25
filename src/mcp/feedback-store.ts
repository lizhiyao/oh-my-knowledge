import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  explicitObservationCaptureResult,
  loadExplicitObservationCaptureRecords,
  type ExplicitObservationCaptureRecord,
} from '../observability/explicit-capture.js';
import {
  loadObservationReviewState,
  observationReviewStateKey,
  updateObservationReviewState,
} from '../observability/review-state.js';
import { writeJsonFileAtomic } from '../shared/atomic-json.js';
import { withFileLock } from '../shared/file-lock.js';
import type {
  ObservationCaptureCoverage,
  ObservationReviewStateEntry,
} from '../types/index.js';
import {
  FileObservationCaptureStore,
  type FileObservationCaptureStoreOptions,
  type ObservationCaptureStore,
} from './capture-store.js';
import {
  validateObservationPrincipal,
  type ObservationPrincipal,
} from './principal.js';

export type ObservationFeedbackReviewVerdict =
  | 'real_issue'
  | 'not_issue'
  | 'needs_more_context';

export interface ObservationCaptureEvidence {
  captureId: string;
  payloadHash: string;
  capturedAt: string;
  userFeedback: string;
  evidenceSnippet?: string;
}

export interface ObservationDetail {
  observationId: string;
  skillName: string;
  artifactVersion: string;
  artifactHash?: string;
  cwd?: string;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  captureCoverage: ObservationCaptureCoverage;
  evidence: ObservationCaptureEvidence[];
  review?: ObservationReviewStateEntry;
}

export interface ObservationReviewInput {
  observationId: string;
  verdict: ObservationFeedbackReviewVerdict;
  note?: string;
}

export interface ObservationReviewResult {
  observationId: string;
  review: ObservationReviewStateEntry;
}

export interface ObservationSampleDraftInput {
  observationId: string;
  prompt: string;
  rubric?: string;
  sampleId?: string;
  draftId?: string;
}

export interface ObservationSampleDraft {
  draftKind: 'observation_sample_draft';
  schemaVersion: 1;
  draftId: string;
  payloadHash: string;
  createdAt: string;
  status: 'draft';
  observationId: string;
  sourceEvidence: Array<Pick<ObservationCaptureEvidence, 'captureId' | 'payloadHash' | 'capturedAt'>>;
  sample: {
    sample_id: string;
    prompt: string;
    rubric?: string;
    provenance: 'production-trace';
  };
}

export interface ObservationSampleDraftResult {
  draft: ObservationSampleDraft;
  created: boolean;
}

export interface ObservationFeedbackStore extends ObservationCaptureStore {
  get(principal: ObservationPrincipal, observationId: string): Promise<ObservationDetail>;
  review(
    principal: ObservationPrincipal,
    input: ObservationReviewInput,
  ): Promise<ObservationReviewResult>;
  draftSample(
    principal: ObservationPrincipal,
    input: ObservationSampleDraftInput,
  ): Promise<ObservationSampleDraftResult>;
}

export type ObservationFeedbackStoreErrorCode =
  | 'observation_not_found'
  | 'observation_review_required'
  | 'draft_conflict'
  | 'feedback_store_failed';

export class ObservationFeedbackStoreError extends Error {
  constructor(
    readonly code: ObservationFeedbackStoreErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ObservationFeedbackStoreError';
  }
}

export class FileObservationFeedbackStore
  extends FileObservationCaptureStore
  implements ObservationFeedbackStore {
  constructor(options: FileObservationCaptureStoreOptions = {}) {
    super(options);
  }

  async get(
    rawPrincipal: ObservationPrincipal,
    observationId: string,
  ): Promise<ObservationDetail> {
    const principal = validateObservationPrincipal(rawPrincipal);
    const observationsDir = this.resolveObservationsDir(principal);
    const records = findObservationRecords(observationsDir, observationId);
    if (records.length === 0) {
      throw new ObservationFeedbackStoreError('observation_not_found', 'Observation 不存在。');
    }
    return projectObservationDetail(observationsDir, observationId, records);
  }

  async review(
    rawPrincipal: ObservationPrincipal,
    rawInput: ObservationReviewInput,
  ): Promise<ObservationReviewResult> {
    const principal = validateObservationPrincipal(rawPrincipal);
    const input = normalizeReviewInput(rawInput);
    const observationsDir = this.resolveObservationsDir(principal);
    if (findObservationRecords(observationsDir, input.observationId).length === 0) {
      throw new ObservationFeedbackStoreError('observation_not_found', 'Observation 不存在。');
    }
    try {
      const state = updateObservationReviewState(observationsDir, {
        targetType: 'inbox_item',
        targetId: input.observationId,
        verdict: input.verdict,
        note: input.note,
      }, this.now?.().toISOString());
      const review = state.entries[observationReviewStateKey('inbox_item', input.observationId)];
      if (!review) throw new Error('复核状态未落盘。');
      return { observationId: input.observationId, review };
    } catch (error) {
      if (error instanceof ObservationFeedbackStoreError) throw error;
      throw new ObservationFeedbackStoreError(
        'feedback_store_failed',
        'Observation 复核写入失败。',
        { cause: error },
      );
    }
  }

  async draftSample(
    rawPrincipal: ObservationPrincipal,
    rawInput: ObservationSampleDraftInput,
  ): Promise<ObservationSampleDraftResult> {
    const principal = validateObservationPrincipal(rawPrincipal);
    const input = normalizeSampleDraftInput(rawInput);
    const observationsDir = this.resolveObservationsDir(principal);
    const records = findObservationRecords(observationsDir, input.observationId);
    if (records.length === 0) {
      throw new ObservationFeedbackStoreError('observation_not_found', 'Observation 不存在。');
    }
    const review = loadObservationReviewState(observationsDir).entries[
      observationReviewStateKey('inbox_item', input.observationId)
    ];
    if (review?.verdict !== 'real_issue') {
      throw new ObservationFeedbackStoreError(
        'observation_review_required',
        '只有人工确认为 real_issue 的 observation 才能生成 sample 草稿。',
      );
    }

    const draft = prepareSampleDraft(input, records, this.now?.() ?? new Date());
    const path = join(observationsDir, 'drafts', `${draft.draftId}.sample-draft.json`);
    try {
      return withFileLock(`${path}.lock`, () => {
        const existing = loadSampleDraft(path);
        if (existing) {
          if (existing.payloadHash !== draft.payloadHash) {
            throw new ObservationFeedbackStoreError(
              'draft_conflict',
              'draftId 已用于不同的 sample 草稿。',
            );
          }
          return { draft: existing, created: false };
        }
        if (existsSync(path)) {
          throw new ObservationFeedbackStoreError(
            'draft_conflict',
            '目标 sample 草稿已存在但无法解析，拒绝覆盖。',
          );
        }
        writeJsonFileAtomic(path, draft);
        return { draft, created: true };
      }, { label: 'observation sample draft' });
    } catch (error) {
      if (error instanceof ObservationFeedbackStoreError) throw error;
      throw new ObservationFeedbackStoreError(
        'feedback_store_failed',
        'Sample 草稿写入失败。',
        { cause: error },
      );
    }
  }
}

export function isObservationFeedbackStore(
  store: ObservationCaptureStore,
): store is ObservationFeedbackStore {
  const candidate = store as Partial<ObservationFeedbackStore>;
  return typeof candidate.get === 'function'
    && typeof candidate.review === 'function'
    && typeof candidate.draftSample === 'function';
}

function findObservationRecords(
  observationsDir: string,
  observationId: string,
): ExplicitObservationCaptureRecord[] {
  const normalizedId = requiredText(observationId, 'observationId', 128);
  return loadExplicitObservationCaptureRecords(observationsDir)
    .filter((record) => explicitObservationCaptureResult(record, false).observationId === normalizedId)
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

function projectObservationDetail(
  observationsDir: string,
  observationId: string,
  records: ExplicitObservationCaptureRecord[],
): ObservationDetail {
  const first = records[0];
  const last = records.at(-1);
  if (!first || !last) throw new Error('Observation records 不能为空。');
  const review = loadObservationReviewState(observationsDir).entries[
    observationReviewStateKey('inbox_item', observationId)
  ];
  return {
    observationId,
    skillName: last.skillName,
    artifactVersion: last.artifactVersion,
    artifactHash: last.artifactHash,
    cwd: last.cwd,
    firstSeen: first.capturedAt,
    lastSeen: last.capturedAt,
    occurrences: records.length,
    captureCoverage: last.captureCoverage,
    evidence: records.map((record) => ({
      captureId: record.captureId,
      payloadHash: record.payloadHash,
      capturedAt: record.capturedAt,
      userFeedback: record.userFeedback,
      evidenceSnippet: record.evidenceSnippet,
    })),
    review,
  };
}

function normalizeReviewInput(input: ObservationReviewInput): ObservationReviewInput {
  if (!['real_issue', 'not_issue', 'needs_more_context'].includes(input.verdict)) {
    throw new ObservationFeedbackStoreError('feedback_store_failed', '不支持的 observation review verdict。');
  }
  return {
    observationId: requiredText(input.observationId, 'observationId', 128),
    verdict: input.verdict,
    note: optionalText(input.note, 'note', 500),
  };
}

function normalizeSampleDraftInput(input: ObservationSampleDraftInput): ObservationSampleDraftInput {
  return {
    observationId: requiredText(input.observationId, 'observationId', 128),
    prompt: requiredText(input.prompt, 'prompt', 16_000),
    rubric: optionalText(input.rubric, 'rubric', 8_000),
    sampleId: optionalText(input.sampleId, 'sampleId', 200),
    draftId: optionalText(input.draftId, 'draftId', 512),
  };
}

function prepareSampleDraft(
  input: ObservationSampleDraftInput,
  records: ExplicitObservationCaptureRecord[],
  now: Date,
): ObservationSampleDraft {
  const sourceEvidence = records.map((record) => ({
    captureId: record.captureId,
    payloadHash: record.payloadHash,
    capturedAt: record.capturedAt,
  }));
  const sample = {
    sample_id: input.sampleId ?? `observation-${input.observationId.slice(0, 16)}`,
    prompt: input.prompt,
    ...(input.rubric ? { rubric: input.rubric } : {}),
    provenance: 'production-trace' as const,
  };
  const payloadHash = hashJson({ observationId: input.observationId, sourceEvidence, sample });
  return {
    draftKind: 'observation_sample_draft',
    schemaVersion: 1,
    draftId: hashText(`observation-sample-draft\u0000${input.draftId ?? payloadHash}`),
    payloadHash,
    createdAt: now.toISOString(),
    status: 'draft',
    observationId: input.observationId,
    sourceEvidence,
    sample,
  };
}

function loadSampleDraft(path: string): ObservationSampleDraft | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<ObservationSampleDraft>;
    if (
      value.draftKind !== 'observation_sample_draft'
      || value.schemaVersion !== 1
      || !isBoundedText(value.draftId, 64)
      || !isBoundedText(value.payloadHash, 64)
      || !isIsoTimestamp(value.createdAt)
      || value.status !== 'draft'
      || !isBoundedText(value.observationId, 128)
      || !Array.isArray(value.sourceEvidence)
      || !value.sourceEvidence.every(isSourceEvidenceRef)
      || !isSampleDraftValue(value.sample)
    ) return null;
    return value as ObservationSampleDraft;
  } catch {
    return null;
  }
}

function isSourceEvidenceRef(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return isBoundedText(ref.captureId, 64)
    && isBoundedText(ref.payloadHash, 64)
    && isIsoTimestamp(ref.capturedAt);
}

function isSampleDraftValue(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const sample = value as Record<string, unknown>;
  return isBoundedText(sample.sample_id, 200)
    && isBoundedText(sample.prompt, 16_000)
    && (sample.rubric === undefined || isBoundedText(sample.rubric, 8_000))
    && sample.provenance === 'production-trace';
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ObservationFeedbackStoreError('feedback_store_failed', `${field} 不能为空。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ObservationFeedbackStoreError(
      'feedback_store_failed',
      `${field} 不能超过 ${maxLength} 个字符。`,
    );
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, field, maxLength);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= maxLength;
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
