import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutorArchiveEvidence } from '../../executors/contracts/archive.js';
import type { ExecutorInput } from '../../executors/contracts/ports.js';
import { canonicalJson } from '../store.js';
import { EXTRACTION_OUTCOME_MAX_BYTES } from './generation.js';
import { EvidenceWindowSchema } from './evidence.js';
import { ExtractionAttemptSchema, ExtractionOutcomeRefSchema, ExtractionOutcomeSchema,
  type ExtractionOutcome, type ExtractionOutcomeRef } from './runs.js';
import { readSourcePlanEvidence, type SourcePlanArchivePort, type SourcePlanReference } from './source-plan-evidence.js';
import { readEntityDiscoveryEvidence, readMentionBindingEvidence, type EntityDiscoveryArchivePort,
  type EntityDiscoveryModel, type EntityDiscoveryReference, type MentionBindingReference } from './discovered-entities-evidence.js';
import { ENTITY_REFINEMENT_SYSTEM_VERSION, ENTITY_REFINEMENT_INPUT_VERSION, ENTITY_REFINEMENT_WIRE_ID,
  ENTITY_REFINEMENT_OUTPUT_NAME, ENTITY_REFINEMENT_SYSTEM, ENTITY_REFINEMENT_WIRE_SCHEMA,
  buildEntityRefinementInput, checkEntityRefinementResponse, type EntityRefinementBase,
  type RefinementPredecessor } from './entity-refinement.js';
import { MENTION_REBINDING_SYSTEM_VERSION, MENTION_REBINDING_INPUT_VERSION, MENTION_REBINDING_WIRE_ID,
  MENTION_REBINDING_OUTPUT_NAME, MENTION_REBINDING_SYSTEM, MENTION_REBINDING_WIRE_SCHEMA,
  buildMentionRebindingInput, checkMentionRebindingResponse } from './mention-rebinding.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const ENTITY_REFINEMENT_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
export const MENTION_REBINDING_RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
const FRAME_OVERHEAD_BYTES = 512;
// Bounds every outer field except request and the actual inspected producer, including two 64-byte timestamps.
const RECEIPT_METADATA_MAX_BYTES = 2048;
const requestFields = {
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1).max(4096),
  system: z.string(), input: z.string(), outputMode: z.literal('json-schema'),
  timeoutMs: z.number().int().positive().max(2_147_483_647),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
};
const refinementRequestSchema = z.strictObject({ ...requestFields,
  systemVersion: z.literal(ENTITY_REFINEMENT_SYSTEM_VERSION), inputVersion: z.literal(ENTITY_REFINEMENT_INPUT_VERSION),
  wireId: z.literal(ENTITY_REFINEMENT_WIRE_ID) });
const rebindingRequestSchema = z.strictObject({ ...requestFields,
  systemVersion: z.literal(MENTION_REBINDING_SYSTEM_VERSION), inputVersion: z.literal(MENTION_REBINDING_INPUT_VERSION),
  wireId: z.literal(MENTION_REBINDING_WIRE_ID) });
const receiptFields = {
  schemaVersion: z.literal(1), receiptId: z.string().uuid(), attemptId: z.string().uuid(),
  snapshotId: EvidenceWindowSchema.shape.snapshotId, sourceVersion: EvidenceWindowSchema.shape.sourceVersion,
  producer: ExtractionAttemptSchema.shape.producer, requestDigest: ExtractionOutcomeRefSchema.shape.digest,
  nativeRef: ExtractionOutcomeRefSchema,
  startedAt: z.iso.datetime({ offset: true }).max(64), finishedAt: z.iso.datetime({ offset: true }).max(64),
};
const ordered = (value: { startedAt: string; finishedAt: string }) => Date.parse(value.finishedAt) >= Date.parse(value.startedAt);
export const EntityRefinementReceiptSchema = z.strictObject({ ...receiptFields,
  receiptKind: z.literal('knowledge-entity-refinement-receipt'), request: refinementRequestSchema,
}).refine(ordered, 'Entity refinement receipt finishes before it starts.');
export const MentionRebindingReceiptSchema = z.strictObject({ ...receiptFields,
  receiptKind: z.literal('knowledge-mention-rebinding-receipt'), request: rebindingRequestSchema,
}).refine(ordered, 'Mention rebinding receipt finishes before it starts.');
export type EntityRefinementReceipt = z.infer<typeof EntityRefinementReceiptSchema>;
export type MentionRebindingReceipt = z.infer<typeof MentionRebindingReceiptSchema>;
const nativeFields = { schemaVersion: z.literal(1), receiptId: z.string().uuid(), attemptId: z.string().uuid(), outcome: ExtractionOutcomeSchema };
export const EntityRefinementNativeArchiveSchema = z.strictObject({ ...nativeFields,
  archiveKind: z.literal('knowledge-entity-refinement-native') });
export const MentionRebindingNativeArchiveSchema = z.strictObject({ ...nativeFields,
  archiveKind: z.literal('knowledge-mention-rebinding-native') });

/** Both new stages use the existing concrete producer, with no execution capability on the reader. */
export interface RefinedEntitiesArchivePort {
  read(stage: 'refinement' | 'rebinding', receiptId: string, receiptRef: ExtractionOutcomeRef): {
    receiptBytes: Uint8Array; outcomeBytes: Uint8Array;
  };
  inspect(executor: string, input: ExecutorInput): ExecutorArchiveEvidence;
}
export interface EntityRefinementReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
export interface MentionRebindingReference { receiptId: string; receiptRef: ExtractionOutcomeRef }
export interface RefinedEntitiesBaseReferences {
  sourcePlan: SourcePlanReference; discovery: EntityDiscoveryReference; binding: MentionBindingReference;
}
export interface RefinedEntitiesBaseArchives {
  sourcePlanArchive: SourcePlanArchivePort; discoveredEntitiesArchive: EntityDiscoveryArchivePort;
}
type Source = Parameters<typeof buildEntityRefinementInput>[0];
export type RefinedEntitiesModel = EntityDiscoveryModel;
type Identity = { receiptId: string; attemptId: string };

function independent(receipts: readonly Identity[]): void {
  const ids = receipts.flatMap(receipt => [receipt.receiptId, receipt.attemptId]);
  if (new Set(ids).size !== ids.length) throw new Error('All refinement workflow receipt and attempt identities must be independent.');
}

function sameSelection(request: { executor: string; model: string; timeoutMs: number; maxOutputTokens: number | null },
  model: RefinedEntitiesModel): void {
  if (request.executor !== model.executor || request.model !== model.model || request.timeoutMs !== (model.timeoutMs ?? 300_000)
    || request.maxOutputTokens !== (model.maxOutputTokens ?? null)) {
    throw new Error('Entity refinement requires the same model and execution configuration throughout the chain.');
  }
}

/** Only the current readers authenticate the three original tasks. No historical DTO or compatibility reader. */
export function readRefinedEntitiesBaseEvidence(source: Source, model: RefinedEntitiesModel,
  references: RefinedEntitiesBaseReferences, archives: RefinedEntitiesBaseArchives) {
  const sourcePlan = readSourcePlanEvidence(source, model, references.sourcePlan, archives.sourcePlanArchive);
  const discovery = readEntityDiscoveryEvidence(source, model, references.discovery, archives.discoveredEntitiesArchive, sourcePlan);
  if (discovery.checked.dispositionIssues.length) throw new RefinedEntitiesValidationError('base-discovery', discovery.checked);
  const binding = readMentionBindingEvidence(source, discovery, model, references.binding, archives.discoveredEntitiesArchive);
  if (binding.checked.status !== 'checked') throw new RefinedEntitiesValidationError('base-binding', binding.checked);
  independent([sourcePlan.receipt, discovery.receipt, binding.receipt]);
  const predecessor: EntityRefinementBase = {
    sourcePlan: { receiptId: sourcePlan.receipt.receiptId, receiptRef: sourcePlan.receiptRef,
      nativeRef: sourcePlan.receipt.nativeRef, requestDigest: sourcePlan.receipt.requestDigest,
      receiptRaw: sourcePlan.receiptRaw, rawOutput: sourcePlan.rawOutput },
    discovery: discovery.predecessor,
    binding: { receiptId: binding.receipt.receiptId, receiptRef: binding.receiptRef,
      nativeRef: binding.receipt.nativeRef, requestDigest: binding.receipt.requestDigest,
      receiptRaw: binding.receiptRaw, rawOutput: binding.rawOutput },
  };
  return { sourcePlan, discovery, binding: { ...binding, checked: binding.checked }, predecessor };
}
export type AuthenticatedRefinedEntitiesBase = ReturnType<typeof readRefinedEntitiesBaseEvidence>;

function executorInput(request: EntityRefinementReceipt['request'] | MentionRebindingReceipt['request'],
  name: string, schema: Readonly<Record<string, unknown>>): ExecutorInput {
  return { model: request.model, system: request.system, prompt: request.input,
    outputFormat: { mode: 'json-schema', name, schema }, timeoutMs: request.timeoutMs,
    ...(request.maxOutputTokens === null ? {} : { maxOutputTokens: request.maxOutputTokens }) };
}

/** The private dispatcher calls this with the actual inspect proof before reserving either new opportunity. */
export function assertRefinedEntitiesReceiptCapacity(request: EntityRefinementReceipt['request'] | MentionRebindingReceipt['request'],
  producer: ExecutorArchiveEvidence): void {
  const inspected = ExtractionAttemptSchema.shape.producer.parse(producer);
  if (inspected.maxOutcomeJsonBytes > EXTRACTION_OUTCOME_MAX_BYTES) throw new Error('Refinement producer exceeds the outcome capacity.');
  if (Buffer.byteLength(JSON.stringify({ request, producer: inspected }), 'utf8') + RECEIPT_METADATA_MAX_BYTES
    > Math.min(ENTITY_REFINEMENT_RECEIPT_MAX_BYTES, MENTION_REBINDING_RECEIPT_MAX_BYTES)) {
    throw new Error('Refinement receipt exceeds its archive capacity before invocation.');
  }
}

function inspectExecution(request: EntityRefinementReceipt['request'] | MentionRebindingReceipt['request'], input: ExecutorInput,
  archive: Pick<RefinedEntitiesArchivePort, 'inspect'>) {
  const evidence = archive.inspect(request.executor, input), producer = ExtractionAttemptSchema.shape.producer.parse(evidence);
  if (canonicalJson(evidence) !== canonicalJson(producer)) throw new Error('Refinement producer proof must not be normalized.');
  assertRefinedEntitiesReceiptCapacity(request, producer);
  return producer;
}

export function entityRefinementExecution(source: Source, model: RefinedEntitiesModel, base: AuthenticatedRefinedEntitiesBase,
  archive: Pick<RefinedEntitiesArchivePort, 'inspect'>) {
  for (const original of [base.sourcePlan, base.discovery, base.binding]) sameSelection(original.receipt.request, model);
  const request = refinementRequestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: ENTITY_REFINEMENT_SYSTEM_VERSION, inputVersion: ENTITY_REFINEMENT_INPUT_VERSION,
    system: ENTITY_REFINEMENT_SYSTEM, input: buildEntityRefinementInput(source, base.predecessor),
    outputMode: 'json-schema', wireId: ENTITY_REFINEMENT_WIRE_ID,
    timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  const input = executorInput(request, ENTITY_REFINEMENT_OUTPUT_NAME, ENTITY_REFINEMENT_WIRE_SCHEMA);
  return { request, input, producer: inspectExecution(request, input, archive) };
}

export interface AuthenticatedEntityRefinement {
  receipt: EntityRefinementReceipt; receiptRef: ExtractionOutcomeRef; receiptRaw: string; rawOutput: string;
  checked: Extract<ReturnType<typeof checkEntityRefinementResponse>, { status: 'checked' }>;
  predecessor: RefinementPredecessor; base: AuthenticatedRefinedEntitiesBase;
}

export function mentionRebindingExecution(source: Source, model: RefinedEntitiesModel, refinement: AuthenticatedEntityRefinement,
  archive: Pick<RefinedEntitiesArchivePort, 'inspect'>) {
  for (const original of [refinement.base.sourcePlan, refinement.base.discovery, refinement.base.binding, refinement]) {
    sameSelection(original.receipt.request, model);
  }
  if (refinement.checked.dispositionIssues.length) throw new RefinedEntitiesValidationError('refinement', refinement.checked);
  const request = rebindingRequestSchema.parse({ executor: model.executor, model: model.model,
    systemVersion: MENTION_REBINDING_SYSTEM_VERSION, inputVersion: MENTION_REBINDING_INPUT_VERSION,
    system: MENTION_REBINDING_SYSTEM,
    input: buildMentionRebindingInput(source, refinement.base.predecessor, refinement.predecessor),
    outputMode: 'json-schema', wireId: MENTION_REBINDING_WIRE_ID,
    timeoutMs: model.timeoutMs ?? 300_000, maxOutputTokens: model.maxOutputTokens ?? null });
  const input = executorInput(request, MENTION_REBINDING_OUTPUT_NAME, MENTION_REBINDING_WIRE_SCHEMA);
  return { request, input, producer: inspectExecution(request, input, archive) };
}

type DispatchReceipt = Pick<EntityRefinementReceipt, 'receiptId' | 'attemptId' | 'snapshotId' | 'sourceVersion' | 'request' | 'producer'>;
/** The full final receipt reference separately commits timestamps and native bytes. */
export function entityRefinementRequestDigest(receipt: DispatchReceipt): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    snapshotId: receipt.snapshotId, sourceVersion: receipt.sourceVersion, request: receipt.request, producer: receipt.producer }));
}
export function mentionRebindingRequestDigest(receipt: Pick<MentionRebindingReceipt,
  'receiptId' | 'attemptId' | 'snapshotId' | 'sourceVersion' | 'request' | 'producer'>): string {
  return digest(canonicalJson({ receiptId: receipt.receiptId, attemptId: receipt.attemptId,
    snapshotId: receipt.snapshotId, sourceVersion: receipt.sourceVersion, request: receipt.request, producer: receipt.producer }));
}

function readJson(bytes: Uint8Array, reference: ExtractionOutcomeRef, maximum: number) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximum) throw new Error('Refinement archive byte identity or capacity conflict.');
  const owned = Buffer.from(bytes);
  if (owned.byteLength !== reference.bytes || digest(owned) !== reference.digest) throw new Error('Refinement archive byte identity or capacity conflict.');
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned);
  return { value: JSON.parse(raw) as unknown, raw };
}

/** The archived native failure remains available to the caller; there is no repair or retry here. */
export class RefinedEntitiesNativeError extends Error {
  readonly assessment = { status: 'rejected' as const, issues: ['incomplete_native_return'] };
  constructor(readonly stage: 'refinement' | 'rebinding', readonly outcome: ExtractionOutcome) {
    super(`${stage} requires a complete successful native assistant return without tools, retries or extra turns.`);
    this.name = 'RefinedEntitiesNativeError';
  }
}
function nativeOutput(stage: 'refinement' | 'rebinding', outcome: ExtractionOutcome, executor: string): string {
  if (outcome.outcomeKind !== 'result' || outcome.cleanupFailure || outcome.result.ok !== true || typeof outcome.result.output !== 'string'
    || outcome.result.refusal !== undefined
    || outcome.result.toolCalls !== undefined && (!Array.isArray(outcome.result.toolCalls) || outcome.result.toolCalls.length > 0)
    || outcome.result.numSubAgents !== undefined && outcome.result.numSubAgents !== 0
    || outcome.result.attemptCount !== undefined && outcome.result.attemptCount !== 1
    || outcome.result.numTurns !== 1 || outcome.result.fullNumTurns !== undefined && outcome.result.fullNumTurns !== 1
    || outcome.result.stopReason !== (executor === 'codex' ? 'end_turn' : 'stop')
    || Buffer.from(outcome.result.output, 'utf8').toString('utf8') !== outcome.result.output) {
    throw new RefinedEntitiesNativeError(stage, outcome);
  }
  return outcome.result.output;
}

export class RefinedEntitiesValidationError extends Error {
  constructor(readonly stage: 'base-discovery' | 'base-binding' | 'refinement', readonly checked: unknown) {
    super(`${stage} failed structure, source or disposition checks; no successor context is available.`);
    this.name = 'RefinedEntitiesValidationError';
  }
}

/** The caller has just authenticated the base through readRefinedEntitiesBaseEvidence. */
export function readEntityRefinementEvidence(source: Source, model: RefinedEntitiesModel,
  reference: EntityRefinementReference, archive: RefinedEntitiesArchivePort, base: AuthenticatedRefinedEntitiesBase): AuthenticatedEntityRefinement {
  const expected = entityRefinementExecution(source, model, base, archive);
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read('refinement', receiptId, receiptRef);
  const receiptJson = readJson(bytes.receiptBytes, receiptRef, ENTITY_REFINEMENT_RECEIPT_MAX_BYTES);
  const receipt = EntityRefinementReceiptSchema.parse(receiptJson.value);
  independent([base.sourcePlan.receipt, base.discovery.receipt, base.binding.receipt, receipt]);
  if (receipt.receiptId !== receiptId || receipt.snapshotId !== source.snapshotId || receipt.sourceVersion !== source.sourceVersion
    || canonicalJson(receipt.request) !== canonicalJson(expected.request) || entityRefinementRequestDigest(receipt) !== receipt.requestDigest
    || Date.parse(receipt.startedAt) < Date.parse(base.binding.receipt.finishedAt)) {
    throw new Error('Entity refinement receipt differs from its frozen source, predecessors, chronology or execution configuration.');
  }
  if (canonicalJson(expected.producer) !== canonicalJson(receipt.producer)) throw new Error('Entity refinement producer differs from its same-task archive witness.');
  const native = EntityRefinementNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)).value);
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Entity refinement native archive identity conflict.');
  const rawOutput = nativeOutput('refinement', native.outcome, expected.request.executor);
  const checked = checkEntityRefinementResponse(rawOutput, source, base.predecessor);
  if (checked.status !== 'checked') throw new RefinedEntitiesValidationError('refinement', checked);
  return { receipt, receiptRef, receiptRaw: receiptJson.raw, rawOutput, checked, base,
    predecessor: { receiptId, receiptRef, nativeRef: receipt.nativeRef, requestDigest: receipt.requestDigest,
      receiptRaw: receiptJson.raw, rawOutput } };
}

/** Re-authentication of the base and A′ is owned by the application composition before this final reader. */
export function readMentionRebindingEvidence(source: Source, model: RefinedEntitiesModel,
  reference: MentionRebindingReference, archive: RefinedEntitiesArchivePort, refinement: AuthenticatedEntityRefinement) {
  const expected = mentionRebindingExecution(source, model, refinement, archive), base = refinement.base;
  const receiptId = z.string().uuid().parse(reference.receiptId), receiptRef = ExtractionOutcomeRefSchema.parse(reference.receiptRef);
  const bytes = archive.read('rebinding', receiptId, receiptRef);
  const receiptJson = readJson(bytes.receiptBytes, receiptRef, MENTION_REBINDING_RECEIPT_MAX_BYTES);
  const receipt = MentionRebindingReceiptSchema.parse(receiptJson.value);
  independent([base.sourcePlan.receipt, base.discovery.receipt, base.binding.receipt, refinement.receipt, receipt]);
  if (receipt.receiptId !== receiptId || receipt.snapshotId !== source.snapshotId || receipt.sourceVersion !== source.sourceVersion
    || canonicalJson(receipt.request) !== canonicalJson(expected.request) || mentionRebindingRequestDigest(receipt) !== receipt.requestDigest
    || Date.parse(receipt.startedAt) < Date.parse(refinement.receipt.finishedAt)) {
    throw new Error('Mention rebinding receipt differs from its frozen source, predecessors, chronology or execution configuration.');
  }
  if (canonicalJson(expected.producer) !== canonicalJson(receipt.producer)) throw new Error('Mention rebinding producer differs from its same-task archive witness.');
  const native = MentionRebindingNativeArchiveSchema.parse(readJson(bytes.outcomeBytes, receipt.nativeRef,
    Math.min(receipt.producer.maxOutcomeJsonBytes + FRAME_OVERHEAD_BYTES, EXTRACTION_OUTCOME_MAX_BYTES)).value);
  if (native.receiptId !== receiptId || native.attemptId !== receipt.attemptId) throw new Error('Mention rebinding native archive identity conflict.');
  const rawOutput = nativeOutput('rebinding', native.outcome, expected.request.executor);
  const checked = checkMentionRebindingResponse(rawOutput, source, base.predecessor, refinement.predecessor);
  return { receipt, receiptRef, receiptRaw: receiptJson.raw, rawOutput, checked, refinement };
}
