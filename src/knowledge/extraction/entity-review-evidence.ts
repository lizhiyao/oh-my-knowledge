import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import { canonicalJson } from '../store.js';
import type { BoundKnowledgeCatalog, BoundKnowledgeSource } from './bound-catalog.js';
import { EXTRACTION_OUTCOME_MAX_BYTES, type ExtractionModel } from './generation.js';
import { ExtractionAttemptSchema, ExtractionOutcomeRefSchema, ExtractionOutcomeSchema,
  type ExtractionOutcomeRef } from './runs.js';
import { ENTITY_REVIEW_INPUT_VERSION, ENTITY_REVIEW_OUTPUT_NAME, ENTITY_REVIEW_SYSTEM,
  ENTITY_REVIEW_SYSTEM_VERSION, ENTITY_REVIEW_WIRE_ID, ENTITY_REVIEW_WIRE_SCHEMA,
  EntityReviewResponseSchema, buildEntityReviewInput, checkEntityReviewResponse } from './entity-review.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const ENTITY_REVIEW_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
const requestSchema = z.strictObject({
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1).max(4096),
  systemVersion: z.literal(ENTITY_REVIEW_SYSTEM_VERSION), inputVersion: z.literal(ENTITY_REVIEW_INPUT_VERSION),
  system: z.string(), input: z.string(), outputMode: z.literal('json-schema'), wireId: z.literal(ENTITY_REVIEW_WIRE_ID),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export const EntityReviewReceiptSchema = z.strictObject({
  receiptKind: z.literal('knowledge-entity-review-receipt'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), binding: EntityReviewResponseSchema.shape.binding,
  request: requestSchema, producer: ExtractionAttemptSchema.shape.producer,
  requestDigest: ExtractionOutcomeRefSchema.shape.digest, nativeRef: ExtractionOutcomeRefSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.finishedAt) >= Date.parse(value.startedAt), 'Entity review receipt finishes before it starts.');
export type EntityReviewReceipt = z.infer<typeof EntityReviewReceiptSchema>;
export const EntityReviewNativeArchiveSchema = z.strictObject({
  archiveKind: z.literal('knowledge-entity-review-native'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), outcome: ExtractionOutcomeSchema,
});

/** The private composition root supplies fixed-ID reads and its frozen same-task producer's inspect. */
export interface EntityReviewArchivePort {
  read(receiptId: string, receiptRef: ExtractionOutcomeRef): { receiptBytes: Uint8Array; outcomeBytes: Uint8Array };
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
}
export interface EntityReviewReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
type Selection = Pick<ExtractionModel, 'executor' | 'model' | 'timeoutMs' | 'maxOutputTokens'>;

/** Reconstruct the exact review request, retaining the original strict wire schema's property order. */
export function entityReviewExecution(source: BoundKnowledgeSource, catalog: BoundKnowledgeCatalog, model: Selection) {
  const request = requestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: ENTITY_REVIEW_SYSTEM_VERSION, inputVersion: ENTITY_REVIEW_INPUT_VERSION,
    system: ENTITY_REVIEW_SYSTEM, input: buildEntityReviewInput(source, catalog), outputMode: 'json-schema',
    wireId: ENTITY_REVIEW_WIRE_ID, timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  const input: ExecutorInput = { model: request.model, system: request.system, prompt: request.input,
    outputFormat: { mode: 'json-schema', name: ENTITY_REVIEW_OUTPUT_NAME, schema: ENTITY_REVIEW_WIRE_SCHEMA },
    timeoutMs: request.timeoutMs, ...(request.maxOutputTokens === null ? {} : { maxOutputTokens: request.maxOutputTokens }) };
  return { request, input };
}

/** Bind dispatch facts only; receiptRef separately binds the returned bytes and posterior timestamps. */
export function entityReviewRequestDigest(receipt: Pick<EntityReviewReceipt,
  'receiptId' | 'attemptId' | 'binding' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    binding: receipt.binding, request: receipt.request, producer: receipt.producer }));
}

function readJson(bytes: Uint8Array, reference: ExtractionOutcomeRef, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum || bytes.byteLength !== reference.bytes) {
    throw new Error('Entity review archive byte identity or capacity conflict.');
  }
  const owned = Buffer.from(bytes);
  if (digest(owned) !== reference.digest) throw new Error('Entity review archive byte identity or capacity conflict.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned)) as unknown;
}

/** Authenticate archived review evidence; catalog persistence and semantic truth require separate checks. */
export function readEntityReviewEvidence(source: BoundKnowledgeSource, catalog: BoundKnowledgeCatalog, model: Selection,
  reference: EntityReviewReference, archive: EntityReviewArchivePort) {
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read(receiptId, receiptRef);
  const receipt = EntityReviewReceiptSchema.parse(readJson(bytes.receiptBytes, receiptRef, ENTITY_REVIEW_RECEIPT_MAX_BYTES));
  const expected = entityReviewExecution(source, catalog, model);
  const binding = EntityReviewResponseSchema.shape.binding.parse(JSON.parse(expected.request.input).binding);
  if (receipt.receiptId !== receiptId || canonicalJson(receipt.binding) !== canonicalJson(binding)
    || canonicalJson(receipt.request) !== canonicalJson(expected.request)
    || entityReviewRequestDigest(receipt) !== receipt.requestDigest) {
    throw new Error('Entity review receipt differs from its frozen source, analysis revision or execution configuration.');
  }
  const inspected = ExtractionAttemptSchema.shape.producer.parse(archive.inspect(expected.request.executor, expected.input));
  if (canonicalJson(inspected) !== canonicalJson(receipt.producer) || receipt.producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) {
    throw new Error('Entity review producer differs from its current same-task archive witness.');
  }
  const native = EntityReviewNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)));
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Entity review native archive identity conflict.');
  const outcome = native.outcome;
  if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || !outcome.result.ok || typeof outcome.result.output !== 'string'
    || outcome.result.refusal !== undefined
    || outcome.result.toolCalls !== undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length > 0)
    || outcome.result.numSubAgents !== undefined && outcome.result.numSubAgents !== 0
    || outcome.result.attemptCount !== undefined && outcome.result.attemptCount !== 1
    || outcome.result.numTurns !== 1
    || outcome.result.fullNumTurns !== undefined && outcome.result.fullNumTurns !== 1
    || outcome.result.stopReason !== (expected.request.executor === 'codex' ? 'end_turn' : 'stop')) {
    throw new Error('Entity review requires a complete successful native assistant return without tools, retries or extra turns.');
  }
  if (Buffer.from(outcome.result.output, 'utf8').toString('utf8') !== outcome.result.output) {
    throw new Error('Entity review native output is not valid UTF-8.');
  }
  const checked = checkEntityReviewResponse(outcome.result.output, source, catalog);
  return { receipt, receiptRef, rawOutput: outcome.result.output, rawOutputDigest: digest(outcome.result.output),
    checked, semanticStatus: checked.semanticStatus };
}
