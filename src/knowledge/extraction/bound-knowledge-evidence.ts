import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import { canonicalJson } from '../store.js';
import { EXTRACTION_OUTCOME_MAX_BYTES, type ExtractionModel } from './generation.js';
import { ExtractionAttemptSchema, ExtractionOutcomeRefSchema, ExtractionOutcomeSchema,
  type ExtractionOutcomeRef } from './runs.js';
import { BOUND_KNOWLEDGE_INPUT_VERSION, BOUND_KNOWLEDGE_EXECUTION_OUTPUT_NAME, BOUND_KNOWLEDGE_SYSTEM,
  BOUND_KNOWLEDGE_SYSTEM_VERSION, buildBoundKnowledgeExecutionWire,
  BoundKnowledgeResponseSchema, buildBoundKnowledgeInput, checkBoundKnowledgeResponse,
  type BoundKnowledgeCatalog, type BoundKnowledgeSource } from './bound-knowledge.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const BOUND_KNOWLEDGE_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
const requestSchema = z.strictObject({
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1).max(4096),
  systemVersion: z.literal(BOUND_KNOWLEDGE_SYSTEM_VERSION), inputVersion: z.literal(BOUND_KNOWLEDGE_INPUT_VERSION),
  system: z.string(), input: z.string(), outputMode: z.literal('json-schema'), wireId: ExtractionOutcomeRefSchema.shape.digest,
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export const BoundKnowledgeReceiptSchema = z.strictObject({
  receiptKind: z.literal('knowledge-bound-knowledge-receipt'), schemaVersion: z.literal(3),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), binding: BoundKnowledgeResponseSchema.shape.binding,
  request: requestSchema, producer: ExtractionAttemptSchema.shape.producer,
  requestDigest: ExtractionOutcomeRefSchema.shape.digest, nativeRef: ExtractionOutcomeRefSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.finishedAt) >= Date.parse(value.startedAt), 'Bound knowledge receipt finishes before it starts.');
export type BoundKnowledgeReceipt = z.infer<typeof BoundKnowledgeReceiptSchema>;
export const BoundKnowledgeNativeArchiveSchema = z.strictObject({
  archiveKind: z.literal('knowledge-bound-knowledge-native'), schemaVersion: z.literal(1),
  receiptId: z.string().uuid(), attemptId: z.string().uuid(), outcome: ExtractionOutcomeSchema,
});

/** Fixed-ID archive reads and the current same-task producer are trusted composition-root capabilities. */
export interface BoundKnowledgeArchivePort {
  read(receiptId: string, receiptRef: ExtractionOutcomeRef): { receiptBytes: Uint8Array; outcomeBytes: Uint8Array };
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
}
export interface BoundKnowledgeReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
type Selection = Pick<ExtractionModel, 'executor' | 'model' | 'timeoutMs' | 'maxOutputTokens'>;

/** Reconstruct from the current pure builder, including the original schema property's order. */
export function boundKnowledgeExecution(source: BoundKnowledgeSource, catalog: BoundKnowledgeCatalog, model: Selection) {
  const prompt = buildBoundKnowledgeInput(source, catalog);
  const wire = buildBoundKnowledgeExecutionWire(JSON.parse(prompt).binding);
  const request = requestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: BOUND_KNOWLEDGE_SYSTEM_VERSION, inputVersion: BOUND_KNOWLEDGE_INPUT_VERSION,
    system: BOUND_KNOWLEDGE_SYSTEM, input: prompt, outputMode: 'json-schema',
    wireId: wire.wireId, timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  const input: ExecutorInput = { model: request.model, system: request.system, prompt: request.input,
    outputFormat: { mode: 'json-schema', name: BOUND_KNOWLEDGE_EXECUTION_OUTPUT_NAME, schema: wire.schema },
    timeoutMs: request.timeoutMs, ...(request.maxOutputTokens === null ? {} : { maxOutputTokens: request.maxOutputTokens }) };
  return { request, input };
}

/** Dispatch fields only. The receipt reference separately binds posterior native bytes and times. */
export function boundKnowledgeRequestDigest(receipt: Pick<BoundKnowledgeReceipt,
  'receiptId' | 'attemptId' | 'binding' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    binding: receipt.binding, request: receipt.request, producer: receipt.producer }));
}

function readJson(bytes: Uint8Array, reference: ExtractionOutcomeRef, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum || bytes.byteLength !== reference.bytes) {
    throw new Error('Bound knowledge archive byte identity or capacity conflict.');
  }
  const owned = Buffer.from(bytes);
  if (digest(owned) !== reference.digest) throw new Error('Bound knowledge archive byte identity or capacity conflict.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned)) as unknown;
}

/** Authenticate this task's returned archive, not the supplied catalog's persistence or semantic truth. */
export function readBoundKnowledgeEvidence(source: BoundKnowledgeSource, catalog: BoundKnowledgeCatalog, model: Selection,
  reference: BoundKnowledgeReference, archive: BoundKnowledgeArchivePort) {
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read(receiptId, receiptRef);
  const receipt = BoundKnowledgeReceiptSchema.parse(readJson(bytes.receiptBytes, receiptRef, BOUND_KNOWLEDGE_RECEIPT_MAX_BYTES));
  const expected = boundKnowledgeExecution(source, catalog, model);
  const binding = BoundKnowledgeResponseSchema.shape.binding.parse(JSON.parse(expected.request.input).binding);
  if (receipt.receiptId !== receiptId || canonicalJson(receipt.binding) !== canonicalJson(binding)
    || canonicalJson(receipt.request) !== canonicalJson(expected.request)
    || boundKnowledgeRequestDigest(receipt) !== receipt.requestDigest) {
    throw new Error('Bound knowledge receipt differs from its frozen source, analysis revision or execution configuration.');
  }
  const inspected = ExtractionAttemptSchema.shape.producer.parse(archive.inspect(expected.request.executor, expected.input));
  if (canonicalJson(inspected) !== canonicalJson(receipt.producer) || receipt.producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) {
    throw new Error('Bound knowledge producer differs from its current same-task archive witness.');
  }
  const native = BoundKnowledgeNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)));
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Bound knowledge native archive identity conflict.');
  const outcome = native.outcome;
  if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || !outcome.result.ok || typeof outcome.result.output !== 'string'
    || outcome.result.refusal !== undefined
    || outcome.result.toolCalls !== undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length > 0)
    || outcome.result.numSubAgents !== undefined && outcome.result.numSubAgents !== 0
    || outcome.result.attemptCount !== undefined && outcome.result.attemptCount !== 1
    || outcome.result.stopReason !== (expected.request.executor === 'codex' ? 'end_turn' : 'stop')) {
    throw new Error('Bound knowledge requires a complete successful native assistant return without tools or retries.');
  }
  // An unencodable native string has no lossless UTF-8 digest. Keep its archive intact and fail the channel.
  if (Buffer.from(outcome.result.output, 'utf8').toString('utf8') !== outcome.result.output) {
    throw new Error('Bound knowledge native output is not valid UTF-8.');
  }
  const checked = checkBoundKnowledgeResponse(outcome.result.output, source, catalog);
  return { receipt, receiptRef, rawOutput: outcome.result.output, rawOutputDigest: digest(outcome.result.output),
    checked, semanticStatus: checked.semanticStatus };
}
