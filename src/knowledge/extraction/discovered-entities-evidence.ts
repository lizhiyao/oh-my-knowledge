import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import { canonicalJson } from '../store.js';
import { EXTRACTION_OUTCOME_MAX_BYTES, type ExtractionModel } from './generation.js';
import { EvidenceWindowSchema } from './evidence.js';
import { ExtractionAttemptSchema, ExtractionOutcomeRefSchema, ExtractionOutcomeSchema,
  type ExtractionOutcome, type ExtractionOutcomeRef } from './runs.js';
import { ENTITY_DISCOVERY_SYSTEM_VERSION, ENTITY_DISCOVERY_INPUT_VERSION, ENTITY_DISCOVERY_WIRE_ID,
  ENTITY_DISCOVERY_OUTPUT_NAME, ENTITY_DISCOVERY_SYSTEM, ENTITY_DISCOVERY_WIRE_SCHEMA,
  buildEntityDiscoveryInput, checkEntityDiscoveryResponse } from './entity-discovery.js';
import { MENTION_BINDING_SYSTEM_VERSION, MENTION_BINDING_INPUT_VERSION, MENTION_BINDING_WIRE_ID,
  MENTION_BINDING_OUTPUT_NAME, MENTION_BINDING_SYSTEM, MENTION_BINDING_WIRE_SCHEMA,
  buildMentionBindingInput, checkMentionBindingResponse, type DiscoveryForBinding } from './mention-binding.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const ENTITY_DISCOVERY_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
export const MENTION_BINDING_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
const requestFields = {
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1).max(4096),
  system: z.string(), input: z.string(), outputMode: z.literal('json-schema'),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
};
const discoveryRequestSchema = z.strictObject({ ...requestFields,
  systemVersion: z.literal(ENTITY_DISCOVERY_SYSTEM_VERSION), inputVersion: z.literal(ENTITY_DISCOVERY_INPUT_VERSION),
  wireId: z.literal(ENTITY_DISCOVERY_WIRE_ID) });
const bindingRequestSchema = z.strictObject({ ...requestFields,
  systemVersion: z.literal(MENTION_BINDING_SYSTEM_VERSION), inputVersion: z.literal(MENTION_BINDING_INPUT_VERSION),
  wireId: z.literal(MENTION_BINDING_WIRE_ID) });
const receiptFields = {
  schemaVersion: z.literal(3), receiptId: z.string().uuid(), attemptId: z.string().uuid(),
  snapshotId: EvidenceWindowSchema.shape.snapshotId, sourceVersion: EvidenceWindowSchema.shape.sourceVersion,
  producer: ExtractionAttemptSchema.shape.producer, requestDigest: ExtractionOutcomeRefSchema.shape.digest,
  nativeRef: ExtractionOutcomeRefSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
};
const ordered = (value: { startedAt: string; finishedAt: string }) => Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
export const EntityDiscoveryReceiptSchema = z.strictObject({ ...receiptFields,
  receiptKind: z.literal('knowledge-entity-discovery-receipt'), request: discoveryRequestSchema,
}).refine(ordered, 'Entity discovery receipt finishes before it starts.');
export const MentionBindingReceiptSchema = z.strictObject({ ...receiptFields,
  receiptKind: z.literal('knowledge-mention-binding-receipt'), request: bindingRequestSchema,
}).refine(ordered, 'Mention binding receipt finishes before it starts.');
export type EntityDiscoveryReceipt = z.infer<typeof EntityDiscoveryReceiptSchema>;
export type MentionBindingReceipt = z.infer<typeof MentionBindingReceiptSchema>;
const nativeFields = { schemaVersion: z.literal(1), receiptId: z.string().uuid(), attemptId: z.string().uuid(), outcome: ExtractionOutcomeSchema };
export const EntityDiscoveryNativeArchiveSchema = z.strictObject({ ...nativeFields,
  archiveKind: z.literal('knowledge-entity-discovery-native') });
export const MentionBindingNativeArchiveSchema = z.strictObject({ ...nativeFields,
  archiveKind: z.literal('knowledge-mention-binding-native') });

/** Fixed-ID reads and the real producer's local inspect; neither stage is invoked here. */
export interface EntityDiscoveryArchivePort {
  read(stage: 'discovery' | 'binding', receiptId: string, receiptRef: ExtractionOutcomeRef): {
    receiptBytes: Uint8Array; outcomeBytes: Uint8Array;
  };
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
}
export interface EntityDiscoveryReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
export interface MentionBindingReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
export type EntityDiscoveryModel = Pick<ExtractionModel, 'executor' | 'model' | 'timeoutMs' | 'maxOutputTokens'>;
type Source = Parameters<typeof buildEntityDiscoveryInput>[0];
function executorInput(request: EntityDiscoveryReceipt['request'] | MentionBindingReceipt['request'],
  name: string, schema: Readonly<Record<string, unknown>>): ExecutorInput {
  return { model: request.model, system: request.system, prompt: request.input,
    outputFormat: { mode: 'json-schema', name, schema }, timeoutMs: request.timeoutMs,
    ...(request.maxOutputTokens === null ? {} : { maxOutputTokens: request.maxOutputTokens }) };
}

export function entityDiscoveryExecution(source: Source, model: EntityDiscoveryModel) {
  const request = discoveryRequestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: ENTITY_DISCOVERY_SYSTEM_VERSION, inputVersion: ENTITY_DISCOVERY_INPUT_VERSION,
    system: ENTITY_DISCOVERY_SYSTEM, input: buildEntityDiscoveryInput(source), outputMode: 'json-schema', wireId: ENTITY_DISCOVERY_WIRE_ID,
    timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  return { request, input: executorInput(request, ENTITY_DISCOVERY_OUTPUT_NAME, ENTITY_DISCOVERY_WIRE_SCHEMA) };
}

export interface AuthenticatedEntityDiscovery {
  receipt: EntityDiscoveryReceipt; receiptRef: ExtractionOutcomeRef; receiptRaw: string; rawOutput: string;
  checked: Extract<ReturnType<typeof checkEntityDiscoveryResponse>, { status: 'checked' }>; predecessor: DiscoveryForBinding;
}

function assertSameSelection(discovery: AuthenticatedEntityDiscovery, model: EntityDiscoveryModel): void {
  const request = discovery.receipt.request;
  if (request.executor !== model.executor || request.model !== model.model || request.timeoutMs !== (model.timeoutMs ?? 300_000)
    || request.maxOutputTokens !== (model.maxOutputTokens ?? null)) {
    throw new Error('Mention binding v3 requires the same discovery model and execution configuration.');
  }
}

export function mentionBindingExecution(source: Source, discovery: AuthenticatedEntityDiscovery, model: EntityDiscoveryModel) {
  assertSameSelection(discovery, model);
  const request = bindingRequestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: MENTION_BINDING_SYSTEM_VERSION, inputVersion: MENTION_BINDING_INPUT_VERSION,
    system: MENTION_BINDING_SYSTEM, input: buildMentionBindingInput(source, discovery.predecessor),
    outputMode: 'json-schema', wireId: MENTION_BINDING_WIRE_ID,
    timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  return { request, input: executorInput(request, MENTION_BINDING_OUTPUT_NAME, MENTION_BINDING_WIRE_SCHEMA) };
}

/** Posterior timestamps/native refs are committed by receiptRef, separately from dispatch identity. */
export function entityDiscoveryRequestDigest(receipt: Pick<EntityDiscoveryReceipt,
  'receiptId' | 'attemptId' | 'snapshotId' | 'sourceVersion' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    snapshotId: receipt.snapshotId, sourceVersion: receipt.sourceVersion, request: receipt.request, producer: receipt.producer }));
}
export function mentionBindingRequestDigest(receipt: Pick<MentionBindingReceipt,
  'receiptId' | 'attemptId' | 'snapshotId' | 'sourceVersion' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    snapshotId: receipt.snapshotId, sourceVersion: receipt.sourceVersion, request: receipt.request, producer: receipt.producer }));
}

function readJson(bytes: Uint8Array, reference: ExtractionOutcomeRef, maximum: number) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum) throw new Error('Discovery/binding archive byte identity or capacity conflict.');
  const owned = Buffer.from(bytes);
  if (owned.byteLength !== reference.bytes || digest(owned) !== reference.digest) throw new Error('Discovery/binding archive byte identity or capacity conflict.');
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned);
  return { value: JSON.parse(raw) as unknown, raw };
}

/** The complete failed native original remains in the caller's archive and on this error. */
export class DiscoveredEntitiesNativeError extends Error {
  readonly assessment = { status: 'rejected' as const, issues: ['incomplete_native_return'] };
  constructor(readonly stage: 'discovery' | 'binding', readonly outcome: ExtractionOutcome) {
    super(`${stage} requires a complete successful native assistant return without tools, retries or extra turns.`);
    this.name = 'DiscoveredEntitiesNativeError';
  }
}
function nativeOutput(stage: 'discovery' | 'binding', outcome: ExtractionOutcome, executor: string): string {
  if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || outcome.result.ok !== true || typeof outcome.result.output !== 'string'
    || outcome.result.refusal !== undefined
    || outcome.result.toolCalls !== undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length > 0)
    || outcome.result.numSubAgents !== undefined && outcome.result.numSubAgents !== 0
    || outcome.result.attemptCount !== undefined && outcome.result.attemptCount !== 1
    || outcome.result.numTurns !== 1 || outcome.result.fullNumTurns !== undefined && outcome.result.fullNumTurns !== 1
    || outcome.result.stopReason !== (executor === 'codex' ? 'end_turn' : 'stop')
    || Buffer.from(outcome.result.output, 'utf8').toString('utf8') !== outcome.result.output) {
    throw new DiscoveredEntitiesNativeError(stage, outcome);
  }
  return outcome.result.output;
}

export class EntityDiscoveryValidationError extends Error {
  constructor(readonly checked: ReturnType<typeof checkEntityDiscoveryResponse>) {
    super('Entity discovery failed structure or source checks; no mention binding context is available.');
    this.name = 'EntityDiscoveryValidationError';
  }
}

/** Authenticate A before any B context exists. There is no model, I/O or entity write here. */
export function readEntityDiscoveryEvidence(source: Source, model: EntityDiscoveryModel,
  reference: EntityDiscoveryReference, archive: EntityDiscoveryArchivePort): AuthenticatedEntityDiscovery {
  const expected = entityDiscoveryExecution(source, model);
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read('discovery', receiptId, receiptRef);
  const receiptJson = readJson(bytes.receiptBytes, receiptRef, ENTITY_DISCOVERY_RECEIPT_MAX_BYTES);
  const receipt = EntityDiscoveryReceiptSchema.parse(receiptJson.value);
  if (receipt.receiptId !== receiptId || receipt.snapshotId !== source.snapshotId || receipt.sourceVersion !== source.sourceVersion
    || canonicalJson(receipt.request) !== canonicalJson(expected.request) || entityDiscoveryRequestDigest(receipt) !== receipt.requestDigest) {
    throw new Error('Entity discovery receipt differs from its frozen source or execution configuration.');
  }
  const inspected = ExtractionAttemptSchema.shape.producer.parse(archive.inspect(expected.request.executor, expected.input));
  if (canonicalJson(inspected) !== canonicalJson(receipt.producer) || receipt.producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) {
    throw new Error('Entity discovery producer differs from its same-task archive witness.');
  }
  const native = EntityDiscoveryNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)).value);
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Entity discovery native archive identity conflict.');
  const rawOutput = nativeOutput('discovery', native.outcome, expected.request.executor);
  const checked = checkEntityDiscoveryResponse(rawOutput, source);
  if (checked.status !== 'checked') throw new EntityDiscoveryValidationError(checked);
  const predecessor: DiscoveryForBinding = { receiptId, receiptRef, nativeRef: receipt.nativeRef, requestDigest: receipt.requestDigest,
    receiptRaw: receiptJson.raw, rawOutput };
  return { receipt, receiptRef, receiptRaw: receiptJson.raw, rawOutput, checked, predecessor };
}

/** Authenticate B independently and retain its quality/admission rejection without publishing an analysis. */
export function readMentionBindingEvidence(source: Source, discovery: AuthenticatedEntityDiscovery, model: EntityDiscoveryModel,
  reference: MentionBindingReference, archive: EntityDiscoveryArchivePort) {
  const expected = mentionBindingExecution(source, discovery, model);
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  if (receiptId === discovery.receipt.receiptId) {
    throw new Error('Discovery and binding require independent receipt identities.');
  }
  const bytes = archive.read('binding', receiptId, receiptRef);
  const receiptJson = readJson(bytes.receiptBytes, receiptRef, MENTION_BINDING_RECEIPT_MAX_BYTES);
  const receipt = MentionBindingReceiptSchema.parse(receiptJson.value);
  if (receipt.receiptId !== receiptId || receipt.attemptId === discovery.receipt.attemptId
    || receipt.snapshotId !== source.snapshotId || receipt.sourceVersion !== source.sourceVersion
    || canonicalJson(receipt.request) !== canonicalJson(expected.request) || mentionBindingRequestDigest(receipt) !== receipt.requestDigest
    || Date.parse(receipt.startedAt) < Date.parse(discovery.receipt.finishedAt)) {
    throw new Error('Mention binding receipt differs from its frozen predecessor, source, chronology or execution configuration.');
  }
  const inspected = ExtractionAttemptSchema.shape.producer.parse(archive.inspect(expected.request.executor, expected.input));
  if (canonicalJson(inspected) !== canonicalJson(receipt.producer) || receipt.producer.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) {
    throw new Error('Mention binding producer differs from its same-task archive witness.');
  }
  const native = MentionBindingNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)).value);
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Mention binding native archive identity conflict.');
  const rawOutput = nativeOutput('binding', native.outcome, expected.request.executor);
  const checked = checkMentionBindingResponse(rawOutput, source, discovery.predecessor);
  return { receipt, receiptRef, receiptRaw: receiptJson.raw, rawOutput, checked, predecessor: discovery.predecessor };
}
