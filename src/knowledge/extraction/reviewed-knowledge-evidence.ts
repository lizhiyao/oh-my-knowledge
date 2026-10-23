import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import { canonicalJson } from '../store.js';
import type { BoundKnowledgeCatalog, BoundKnowledgeSource } from './bound-catalog.js';
import { EXTRACTION_OUTCOME_MAX_BYTES, type ExtractionModel } from './generation.js';
import { ExtractionAttemptSchema, ExtractionOutcomeRefSchema, ExtractionOutcomeSchema,
  type ExtractionOutcomeRef } from './runs.js';
import { REVIEWED_KNOWLEDGE_INPUT_VERSION, REVIEWED_KNOWLEDGE_OUTPUT_NAME, REVIEWED_KNOWLEDGE_SYSTEM,
  REVIEWED_KNOWLEDGE_SYSTEM_VERSION, REVIEWED_KNOWLEDGE_WIRE_ID, REVIEWED_KNOWLEDGE_WIRE_SCHEMA,
  ReviewedKnowledgeResponseSchema, buildReviewedKnowledgeInput, checkReviewedKnowledgeResponse,
  type EntityReviewProjection } from './reviewed-knowledge.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const REVIEWED_KNOWLEDGE_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
const requestSchema = z.strictObject({
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1).max(4096),
  systemVersion: z.literal(REVIEWED_KNOWLEDGE_SYSTEM_VERSION), inputVersion: z.literal(REVIEWED_KNOWLEDGE_INPUT_VERSION),
  system: z.string(), input: z.string(), outputMode: z.literal('json-schema'), wireId: z.literal(REVIEWED_KNOWLEDGE_WIRE_ID),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export const ReviewedKnowledgeReceiptSchema = z.strictObject({
  receiptKind: z.literal('knowledge-reviewed-knowledge-receipt'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), binding: ReviewedKnowledgeResponseSchema.shape.binding,
  request: requestSchema, producer: ExtractionAttemptSchema.shape.producer,
  requestDigest: ExtractionOutcomeRefSchema.shape.digest, nativeRef: ExtractionOutcomeRefSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.finishedAt) >= Date.parse(value.startedAt), 'Reviewed knowledge receipt finishes before it starts.');
export type ReviewedKnowledgeReceipt = z.infer<typeof ReviewedKnowledgeReceiptSchema>;
export const ReviewedKnowledgeNativeArchiveSchema = z.strictObject({
  archiveKind: z.literal('knowledge-reviewed-knowledge-native'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), outcome: ExtractionOutcomeSchema,
});

/** Fixed-ID reads and the current same-task producer are private composition-root capabilities. */
export interface ReviewedKnowledgeArchivePort {
  read(receiptId: string, receiptRef: ExtractionOutcomeRef): { receiptBytes: Uint8Array; outcomeBytes: Uint8Array };
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
}
export interface ReviewedKnowledgeReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
type Selection = Pick<ExtractionModel, 'executor' | 'model' | 'timeoutMs' | 'maxOutputTokens'>;

/** Reconstruct the exact reviewed-K request, preserving the original wire schema property's order. */
export function reviewedKnowledgeExecution(source: BoundKnowledgeSource, catalog: BoundKnowledgeCatalog,
  review: EntityReviewProjection, model: Selection) {
  const request = requestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: REVIEWED_KNOWLEDGE_SYSTEM_VERSION, inputVersion: REVIEWED_KNOWLEDGE_INPUT_VERSION,
    system: REVIEWED_KNOWLEDGE_SYSTEM, input: buildReviewedKnowledgeInput(source, catalog, review), outputMode: 'json-schema',
    wireId: REVIEWED_KNOWLEDGE_WIRE_ID, timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  const input: ExecutorInput = { model: request.model, system: request.system, prompt: request.input,
    outputFormat: { mode: 'json-schema', name: REVIEWED_KNOWLEDGE_OUTPUT_NAME, schema: REVIEWED_KNOWLEDGE_WIRE_SCHEMA },
    timeoutMs: request.timeoutMs, ...(request.maxOutputTokens === null ? {} : { maxOutputTokens: request.maxOutputTokens }) };
  return { request, input };
}

/** Dispatch facts only; receiptRef separately binds posterior native bytes and timestamps. */
export function reviewedKnowledgeRequestDigest(receipt: Pick<ReviewedKnowledgeReceipt,
  'receiptId' | 'attemptId' | 'binding' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    binding: receipt.binding, request: receipt.request, producer: receipt.producer }));
}

function readJson(bytes: Uint8Array, reference: ExtractionOutcomeRef, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum || bytes.byteLength !== reference.bytes) {
    throw new Error('Reviewed knowledge archive byte identity or capacity conflict.');
  }
  const owned = Buffer.from(bytes);
  if (digest(owned) !== reference.digest) throw new Error('Reviewed knowledge archive byte identity or capacity conflict.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned)) as unknown;
}

/** Authenticate the private task archive; the caller separately authenticates the supplied E/R evidence. */
export function readReviewedKnowledgeEvidence(source: BoundKnowledgeSource, catalog: BoundKnowledgeCatalog,
  review: EntityReviewProjection, model: Selection, reference: ReviewedKnowledgeReference, archive: ReviewedKnowledgeArchivePort) {
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read(receiptId, receiptRef);
  const receipt = ReviewedKnowledgeReceiptSchema.parse(readJson(bytes.receiptBytes, receiptRef, REVIEWED_KNOWLEDGE_RECEIPT_MAX_BYTES));
  const expected = reviewedKnowledgeExecution(source, catalog, review, model);
  const binding = ReviewedKnowledgeResponseSchema.shape.binding.parse(JSON.parse(expected.request.input).binding);
  if (receipt.receiptId !== receiptId || canonicalJson(receipt.binding) !== canonicalJson(binding)
    || canonicalJson(receipt.request) !== canonicalJson(expected.request)
    || reviewedKnowledgeRequestDigest(receipt) !== receipt.requestDigest) {
    throw new Error('Reviewed knowledge receipt differs from its frozen source, analysis revision, review or execution configuration.');
  }
  const inspected = ExtractionAttemptSchema.shape.producer.parse(archive.inspect(expected.request.executor, expected.input));
  if (canonicalJson(inspected) !== canonicalJson(receipt.producer) || receipt.producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) {
    throw new Error('Reviewed knowledge producer differs from its current same-task archive witness.');
  }
  const native = ReviewedKnowledgeNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)));
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Reviewed knowledge native archive identity conflict.');
  const outcome = native.outcome;
  if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || !outcome.result.ok || typeof outcome.result.output !== 'string'
    || outcome.result.refusal !== undefined
    || outcome.result.toolCalls !== undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length > 0)
    || outcome.result.numSubAgents !== undefined && outcome.result.numSubAgents !== 0
    || outcome.result.attemptCount !== undefined && outcome.result.attemptCount !== 1
    || outcome.result.numTurns !== 1
    || outcome.result.fullNumTurns !== undefined && outcome.result.fullNumTurns !== 1
    || outcome.result.stopReason !== (expected.request.executor === 'codex' ? 'end_turn' : 'stop')) {
    throw new Error('Reviewed knowledge requires a complete successful native assistant return without tools, retries or extra turns.');
  }
  if (Buffer.from(outcome.result.output, 'utf8').toString('utf8') !== outcome.result.output) {
    throw new Error('Reviewed knowledge native output is not valid UTF-8.');
  }
  const checked = checkReviewedKnowledgeResponse(outcome.result.output, source, catalog, review);
  return { receipt, receiptRef, rawOutput: outcome.result.output, rawOutputDigest: digest(outcome.result.output),
    checked, semanticStatus: checked.semanticStatus };
}
