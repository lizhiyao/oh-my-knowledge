import { z } from 'zod';
import { EntityMentionSchema, KnowledgeActorSchema } from '../contracts.js';
import { canonicalJson } from '../store.js';
import { AnalyzedEntitySchema } from './contracts.js';
import { EntityLinkEndpointSchema, EntityLinkConflictCodeSchema, EntityLinkSuggestionSchema } from './links.js';
import { LibraryEnvelopeSchema, LibraryWriteSchema, type LibraryStore } from '../library/contracts.js';

const id = z.string().uuid();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metric = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason = z.string().trim().min(1).max(4096);
const human = KnowledgeActorSchema.refine(actor => actor.actorKind === 'human', 'Explicit human authorization required.');
const mention = EntityMentionSchema.extend({ mentionId: id, entityId: id });
const side = z.strictObject({ binding: EntityLinkEndpointSchema, entity: AnalyzedEntitySchema,
  mentions: z.array(mention).min(1).max(64), limitations: z.array(reason).max(64) });
export const EntityLinkModelInputSchema = z.strictObject({ protocolId: z.literal('entity-link-model-input/v1'), left: side, right: side });

/** A frozen send request, not an assertion about endpoint, credentials or runtime identity. */
export const EntityLinkExecutionRequestSchema = z.strictObject({
  requestKind: z.literal('entity-link-execution-request'), protocolId: z.literal('entity-link-executor/v1'),
  executor: z.enum(['codex', 'openai-api']), model: z.string().min(1), system: z.string(), prompt: z.string(),
  promptVersion: z.literal('entity-link-proposal-v1'), promptHash: digest,
  responseSchemaId: z.literal('entity-link-suggestion/v1'), responseSchemaHash: digest,
  outputFormat: z.strictObject({ mode: z.literal('json-schema'), name: z.literal('entity_link_suggestion_v1'), schema: z.record(z.string(), z.json()) }),
  timeoutMs: z.literal(300_000), maxOutputTokens: z.literal(4096).optional(), requestDigest: digest,
});
export type EntityLinkExecutionRequest = z.infer<typeof EntityLinkExecutionRequestSchema>;

/** Preserve every JSON field returned by the producer; this module does not import executor contracts. */
export const EntityLinkExecutionResultSchema = z.object({
  // The production adapter observes wall-clock elapsed time. A clock rollback is
  // anomalous evidence to retain, rather than a reason to lose the raw result.
  ok: z.boolean(), output: z.string().nullable(), durationMs: z.number().finite(), durationApiMs: metric,
  inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheCreationTokens: count,
  tokenUsageReportedByExecutor: z.boolean().optional(), costUSD: metric, costReportedByExecutor: z.boolean().optional(),
  stopReason: z.string(), numTurns: count, attemptCount: count.min(1).optional(), fullNumTurns: count.optional(), numSubAgents: count.optional(),
  error: z.string().optional(), refusal: z.string().optional(), cached: z.boolean().optional(),
  failure: z.strictObject({ failureKind: z.enum(['rate_limit', 'server_error', 'network_error', 'timeout', 'cancelled', 'authentication', 'permission',
    'invalid_request', 'unsupported_output', 'refusal', 'content_filter', 'truncation', 'invalid_response', 'capacity', 'unknown']),
  httpStatus: z.number().int().min(100).max(599).optional(), retryAfterMs: count.max(2_147_483_647).optional() }).optional(),
  turns: z.array(z.json()).optional(), toolCalls: z.array(z.json()).optional(),
}).catchall(z.json()).superRefine((value, context) => {
  if (value.ok && (value.failure || value.refusal !== undefined || !value.output?.trim())) context.addIssue({ code: 'custom', message: 'Successful result has failed evidence.' });
});
export type EntityLinkExecutionResult = z.infer<typeof EntityLinkExecutionResultSchema>;
const utf8Text = (maxBytes: number) => z.string().refine(value => new TextEncoder().encode(value).byteLength <= maxBytes, 'Diagnostic UTF-8 capacity exceeded.');
const cleanup = z.strictObject({ diagnostic: utf8Text(4096) });
export const EntityLinkExceptionObservationSchema = z.strictObject({
  representationKind: z.literal('exception-diagnostic/v1'), sourceType: z.enum(['undefined', 'boolean', 'number', 'bigint', 'string', 'symbol', 'function', 'object']),
  name: utf8Text(256).nullable(), message: utf8Text(4096), truncated: z.boolean(), accessorsSkipped: z.boolean(),
});
export const EntityLinkExecutionOutcomeSchema = z.discriminatedUnion('outcomeKind', [
  z.strictObject({ outcomeKind: z.literal('result'), result: EntityLinkExecutionResultSchema, cleanupFailure: cleanup.optional() }),
  z.strictObject({ outcomeKind: z.literal('exception'), error: EntityLinkExceptionObservationSchema, cleanupFailure: cleanup.optional() }),
]);
export type EntityLinkExecutionOutcome = z.infer<typeof EntityLinkExecutionOutcomeSchema>;

/** Issued and checked by a trusted producer port, never supplied by an HTTP/CLI caller. */
export const EntityLinkReservationSchema = z.strictObject({
  producerId: reason, producerRevision: digest, requestDigest: digest,
  sourceChannels: z.array(z.strictObject({ channel: reason, maxBytes: count.min(1) })).min(1),
  maxOutcomeJsonBytes: count.min(1), proof: z.json(), reservationDigest: digest,
});
export type EntityLinkReservation = z.infer<typeof EntityLinkReservationSchema>;
export const EntityLinkExecutionOwnerSchema = z.strictObject({ ownerId: id, hostname: z.string().min(1).max(256), pid: count.min(1) });
export type EntityLinkExecutionOwner = z.infer<typeof EntityLinkExecutionOwnerSchema>;
export const EntityLinkOwnerExitSchema = z.strictObject({ proofKind: z.literal('local-process-exited'), owner: EntityLinkExecutionOwnerSchema, observedAt: z.iso.datetime({ offset: true }).max(64) });
export type EntityLinkOwnerExit = z.infer<typeof EntityLinkOwnerExitSchema>;
export interface EntityLinkInvocationPorts {
  hashJson(value: unknown): string;
  hashText(value: string): string;
  /** No production implementation is bundled here. It must prove its producer's complete archive bound. */
  reserve(request: EntityLinkExecutionRequest): EntityLinkReservation | undefined;
  reservationIsCurrent(request: EntityLinkExecutionRequest, reservation: EntityLinkReservation): boolean;
  /** Must prove local process exit; age, remote host and missing lock are insufficient. */
  proveOwnerExited(owner: EntityLinkExecutionOwner): EntityLinkOwnerExit | undefined;
}
const conflict = EntityLinkConflictCodeSchema;
export const EntityLinkInvocationPlanSchema = z.strictObject({ left: EntityLinkEndpointSchema, right: EntityLinkEndpointSchema,
  request: EntityLinkExecutionRequestSchema, producerContextDigest: digest, confirmedDigest: digest, retryOf: id.nullable() });
export type EntityLinkInvocationPlan = z.infer<typeof EntityLinkInvocationPlanSchema>;
const common = { reviewId: id, requestId: id, eventId: id, at: z.iso.datetime({ offset: true }).max(64), actor: KnowledgeActorSchema, expectedGeneration: count };
const application = z.discriminatedUnion('applicationKind', [
  z.strictObject({ applicationKind: z.literal('intent'), intent: LibraryWriteSchema }),
  z.strictObject({ applicationKind: z.literal('conflict'), conflictCode: conflict }),
]);
export const EntityLinkInvocationCommandSchema = z.discriminatedUnion('commandKind', [
  z.strictObject({ ...common, commandKind: z.literal('prepare'), actor: human, input: EntityLinkInvocationPlanSchema }),
  z.strictObject({ ...common, commandKind: z.literal('start'), executionId: id, owner: EntityLinkExecutionOwnerSchema }),
  z.strictObject({ ...common, commandKind: z.literal('cancel_before_start'), reason }),
  z.strictObject({ ...common, commandKind: z.literal('execution_recorded'), executionId: id, outcome: EntityLinkExecutionOutcomeSchema }),
  z.strictObject({ ...common, commandKind: z.literal('execution_unknown'), executionId: id }),
  z.strictObject({ ...common, commandKind: z.literal('reviewed'), actor: human, decision: z.enum(['accept', 'reject']), reason,
    identityConfirmed: z.boolean(), objectLabel: reason.max(256).nullable(), application: application.nullable() }),
  z.strictObject({ ...common, commandKind: z.literal('application_applied'), receipt: LibraryEnvelopeSchema.shape.receipts.element }),
  z.strictObject({ ...common, commandKind: z.literal('application_conflict'), conflictCode: conflict }),
]);
export type EntityLinkInvocationCommand = z.infer<typeof EntityLinkInvocationCommandSchema>;
export const EntityLinkInvocationEventSchema = z.strictObject({ command: EntityLinkInvocationCommandSchema,
  commandDigest: digest, facts: z.record(z.string(), z.json()), eventDigest: digest });
export type EntityLinkInvocationEvent = z.infer<typeof EntityLinkInvocationEventSchema>;
export const EntityLinkInvocationSchema = z.strictObject({ storeKind: z.literal('entity-link-invocation-history'), schemaVersion: z.literal(1),
  reviewId: id, pairKey: digest, generation: count.min(1), writeHeadEventId: id, events: z.array(EntityLinkInvocationEventSchema).min(1).max(6) });
export type EntityLinkInvocation = z.infer<typeof EntityLinkInvocationSchema>;
export const EntityLinkInvocationAdmissionSchema = z.discriminatedUnion('admissionKind', [
  z.strictObject({ admissionKind: z.literal('admitted'), suggestion: EntityLinkSuggestionSchema }),
  z.strictObject({ admissionKind: z.literal('rejected'), reason: z.enum(['failed_execution', 'observed_tools', 'invalid_response', 'reservation_overrun', 'exception']) }),
]);
export type EntityLinkInvocationAdmission = z.infer<typeof EntityLinkInvocationAdmissionSchema>;

export interface EntityLinkInvocationTransaction {
  readonly library: LibraryStore;
  list(): EntityLinkInvocation[];
  read(reviewId: string): EntityLinkInvocation;
  /** CAS publication, with zero meaning exclusive creation. */
  save(history: EntityLinkInvocation, expectedGeneration: number): EntityLinkInvocation;
}
export interface EntityLinkInvocationStore {
  list(): EntityLinkInvocation[];
  read(reviewId: string): EntityLinkInvocation;
  transaction<T>(operation: (transaction: EntityLinkInvocationTransaction) => T): T;
}
export class EntityLinkWriteCapacityError extends Error {}

/** One portable preview. Displayed content/context cannot diverge from the confirmed plan. */
export const EntityLinkPreviewSchema = z.strictObject({ reviewId: id, requestId: id, startRequestId: id,
  input: EntityLinkModelInputSchema, plan: EntityLinkInvocationPlanSchema, producerContext: EntityLinkReservationSchema,
}).superRefine((value, context) => {
  if (new Set([value.reviewId, value.requestId, value.startRequestId]).size !== 3
    || canonicalJson(value.input) !== value.plan.request.prompt
    || value.producerContext.requestDigest !== value.plan.request.requestDigest
    || value.producerContext.reservationDigest !== value.plan.producerContextDigest) {
    context.addIssue({ code: 'custom', message: 'Entity-link preview content/context conflict.' });
  }
});
export type EntityLinkPreview = z.infer<typeof EntityLinkPreviewSchema>;
