import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import { canonicalJson } from '../store.js';
import { EvidenceWindowSchema, type EvidenceWindow } from './evidence.js';
import { ExtractionAttemptSchema, ExtractionOutcomeRefSchema, ExtractionOutcomeSchema, type ExtractionOutcomeRef } from './runs.js';
import { EXTRACTION_OUTCOME_MAX_BYTES, type ExtractionModel } from './generation.js';
import { SOURCE_PLAN_INPUT_VERSION, SOURCE_PLAN_OUTPUT_NAME, SOURCE_PLAN_SYSTEM, SOURCE_PLAN_SYSTEM_VERSION,
  SOURCE_PLAN_WIRE_ID, SOURCE_PLAN_WIRE_SCHEMA_JSON, buildKnowledgeSourcePlanInput, checkKnowledgeSourcePlan } from './source-plan.js';

const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const SOURCE_PLAN_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
const requestSchema = z.strictObject({
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1).max(4096),
  systemVersion: z.literal(SOURCE_PLAN_SYSTEM_VERSION), inputVersion: z.literal(SOURCE_PLAN_INPUT_VERSION),
  system: z.string(), input: z.string(), outputMode: z.literal('json-schema'), wireId: z.literal(SOURCE_PLAN_WIRE_ID),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export const SourcePlanReceiptSchema = z.strictObject({
  receiptKind: z.literal('knowledge-source-plan-receipt'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(),
  snapshotId: EvidenceWindowSchema.shape.snapshotId, sourceVersion: EvidenceWindowSchema.shape.sourceVersion,
  request: requestSchema, producer: ExtractionAttemptSchema.shape.producer,
  requestDigest: ExtractionOutcomeRefSchema.shape.digest, nativeRef: ExtractionOutcomeRefSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.finishedAt) >= Date.parse(value.startedAt), 'Source plan receipt finishes before it starts.');
export type SourcePlanReceipt = z.infer<typeof SourcePlanReceiptSchema>;
export const SourcePlanNativeArchiveSchema = z.strictObject({
  archiveKind: z.literal('knowledge-source-plan-native'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), outcome: ExtractionOutcomeSchema,
});

/** A trusted research composition root reads fixed-ID files and supplies its frozen producer's local inspect. */
export interface SourcePlanArchivePort {
  read(receiptId: string, receiptRef: ExtractionOutcomeRef): { receiptBytes: Uint8Array; outcomeBytes: Uint8Array };
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
}
export interface SourcePlanReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
type SourcePlanSource = Pick<EvidenceWindow, 'snapshotId' | 'sourceVersion' | 'excerpts' | 'limitations'>;
type Selection = Pick<ExtractionModel, 'executor' | 'model' | 'timeoutMs' | 'maxOutputTokens'>;

/** The same exact stage-one request is used by the private driver and by the application when rereading evidence. */
export function sourcePlanExecution(window: SourcePlanSource, model: Selection) {
  const request = requestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: SOURCE_PLAN_SYSTEM_VERSION, inputVersion: SOURCE_PLAN_INPUT_VERSION,
    system: SOURCE_PLAN_SYSTEM, input: buildKnowledgeSourcePlanInput(window), outputMode: 'json-schema', wireId: SOURCE_PLAN_WIRE_ID,
    timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  const input: ExecutorInput = { model: request.model, system: request.system, prompt: request.input,
    outputFormat: { mode: 'json-schema', name: SOURCE_PLAN_OUTPUT_NAME, schema: SOURCE_PLAN_WIRE_SCHEMA_JSON },
    timeoutMs: request.timeoutMs, ...(request.maxOutputTokens === null ? {} : { maxOutputTokens: request.maxOutputTokens }) };
  return { request, input };
}

/** Dispatch identity excludes posterior facts; receiptRef separately binds the complete final receipt bytes. */
export function sourcePlanRequestDigest(receipt: Pick<SourcePlanReceipt,
  'receiptId' | 'attemptId' | 'snapshotId' | 'sourceVersion' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    snapshotId: receipt.snapshotId, sourceVersion: receipt.sourceVersion, request: receipt.request, producer: receipt.producer }));
}

function readJson(bytes: Uint8Array, ref: ExtractionOutcomeRef, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum || bytes.byteLength !== ref.bytes) {
    throw new Error('Source plan archive byte identity or capacity conflict.');
  }
  const owned = Buffer.from(bytes);
  if (digest(owned) !== ref.digest) throw new Error('Source plan archive byte identity or capacity conflict.');
  // Hash and parse one owned snapshot. Invalid UTF-8/BOM is never replacement-decoded or repaired.
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned)) as unknown;
}

/** Failures are quality failures with intact raw, rather than missing/corrupt-archive observations. */
export class SourcePlanValidationError extends Error {
  constructor(readonly assessment: Extract<ReturnType<typeof checkKnowledgeSourcePlan>, { status: 'rejected' }>) {
    super('Source semantic plan failed structure or source-anchor validation; no final invocation was reserved.');
    this.name = 'SourcePlanValidationError';
  }
}

/** No I/O or model generation here: the caller supplies a trusted readonly archive port. */
export function readSourcePlanEvidence(window: SourcePlanSource, model: Selection, reference: SourcePlanReference, archive: SourcePlanArchivePort) {
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read(receiptId, receiptRef);
  const receipt = SourcePlanReceiptSchema.parse(readJson(bytes.receiptBytes, receiptRef, SOURCE_PLAN_RECEIPT_MAX_BYTES));
  const expected = sourcePlanExecution(window, model);
  if (receipt.receiptId !== receiptId || receipt.snapshotId !== window.snapshotId || receipt.sourceVersion !== window.sourceVersion
    || canonicalJson(receipt.request) !== canonicalJson(expected.request) || sourcePlanRequestDigest(receipt) !== receipt.requestDigest) {
    throw new Error('Source plan receipt differs from the frozen source-only task or execution configuration.');
  }
  const inspected = ExtractionAttemptSchema.shape.producer.parse(archive.inspect(expected.request.executor, expected.input));
  if (canonicalJson(inspected) !== canonicalJson(receipt.producer) || receipt.producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) {
    throw new Error('Source plan producer differs from its current same-task archive witness.');
  }
  const native = SourcePlanNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)));
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Source plan native archive identity conflict.');
  const outcome = native.outcome;
  if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || !outcome.result.ok || typeof outcome.result.output !== 'string'
    || outcome.result.refusal !== undefined || Array.isArray(outcome.result.toolCalls) && outcome.result.toolCalls.length > 0
    || outcome.result.stopReason !== (model.executor === 'codex' ? 'end_turn' : 'stop')) {
    throw new Error('Source semantic plan requires a complete successful native assistant return.');
  }
  const assessment = checkKnowledgeSourcePlan(outcome.result.output, window);
  if (assessment.status !== 'validated') throw new SourcePlanValidationError(assessment);
  return { receipt, receiptRef, rawOutput: outcome.result.output, rawOutputDigest: digest(outcome.result.output),
    semanticStatus: assessment.semanticStatus };
}
