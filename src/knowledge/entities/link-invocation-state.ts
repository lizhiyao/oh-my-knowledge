import { z } from 'zod';
import { canonicalJson } from '../store.js';
import { checkEntityLinkSuggestion, entityLinkPairKey, EntityLinkSuggestionSchema } from './links.js';
import {
  EntityLinkInvocationSchema, EntityLinkInvocationCommandSchema, EntityLinkModelInputSchema, EntityLinkReservationSchema, EntityLinkPreviewSchema,
  EntityLinkOwnerExitSchema, EntityLinkInvocationAdmissionSchema,
  type EntityLinkInvocation, type EntityLinkInvocationCommand, type EntityLinkInvocationEvent, type EntityLinkInvocationPlan,
  type EntityLinkInvocationPorts, type EntityLinkInvocationAdmission, type EntityLinkExecutionOutcome,
} from './link-invocation.js';

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
type Integrity = Pick<EntityLinkInvocationPorts, 'hashJson' | 'hashText'>;
export class EntityLinkInvocationConflictError extends Error {}
export type EntityLinkInvocationStatus = 'prepared' | 'running' | 'execution_unknown' | 'awaiting_review' | 'execution_failed'
  | 'cancelled_before_start' | 'rejected' | 'accepted_pending_application' | 'accepted_conflict' | 'applied';
export function entityLinkConfirmationDigest(reviewId: string, input: Omit<EntityLinkInvocationPlan, 'confirmedDigest'>, hash: Integrity['hashJson']): string {
  return hash({ reviewId, left: input.left, right: input.right, requestDigest: input.request.requestDigest, producerContextDigest: input.producerContextDigest, retryOf: input.retryOf, invocationBudget: 1 });
}
function commandDigest(command: EntityLinkInvocationCommand, hash: Integrity['hashJson']) {
  const semantic: Partial<EntityLinkInvocationCommand> = { ...command };
  delete semantic.expectedGeneration; delete semantic.eventId; delete semantic.at;
  return hash(semantic);
}
function verifyPlan(reviewId: string, input: EntityLinkInvocationPlan, integrity: Integrity, requireCurrentSchema = false) {
  const request = input.request; const { requestDigest, ...wire } = request;
  if (!request.model.trim() || request.promptHash !== integrity.hashText(request.system)
    || request.responseSchemaHash !== integrity.hashJson(request.outputFormat.schema) || requestDigest !== integrity.hashJson(wire)
    || (requireCurrentSchema && !equal(request.outputFormat.schema, z.toJSONSchema(EntityLinkSuggestionSchema)))
    || (request.executor === 'openai-api' ? request.maxOutputTokens !== 4096 : request.maxOutputTokens !== undefined)
    || bytes(request.system) + bytes(request.prompt) > 256 * 1024) throw new EntityLinkInvocationConflictError('Frozen entity-link request conflict.');
  const modelInput = EntityLinkModelInputSchema.parse(JSON.parse(request.prompt));
  if (request.prompt !== canonicalJson(modelInput) || input.left.analysisId === input.right.analysisId || input.retryOf === reviewId
    || !equal(modelInput.left.binding, input.left) || !equal(modelInput.right.binding, input.right)
    || input.confirmedDigest !== entityLinkConfirmationDigest(reviewId, input, integrity.hashJson)) throw new EntityLinkInvocationConflictError('Entity-link confirmation conflict.');
  for (const side of [modelInput.left, modelInput.right]) {
    if (side.entity.entityId !== side.binding.entityId || side.mentions.some(mention => mention.entityId !== side.entity.entityId)
      || new Set(side.mentions.map(mention => mention.mentionId)).size !== side.mentions.length
      || !equal([...side.binding.mentionIds].sort(), side.mentions.map(mention => mention.mentionId).sort())) throw new EntityLinkInvocationConflictError('Entity-link selected evidence conflict.');
  }
  return modelInput;
}
function verifyReservation(input: EntityLinkInvocationPlan, reservation: z.infer<typeof EntityLinkReservationSchema>, integrity: Integrity) {
  const { reservationDigest, ...evidence } = reservation;
  if (reservation.requestDigest !== input.request.requestDigest || reservationDigest !== input.producerContextDigest || reservationDigest !== integrity.hashJson(evidence)) throw new EntityLinkInvocationConflictError('Producer reservation integrity conflict.');
}
/** Verify portable displayed evidence, including its context hash, before asking for confirmation. */
export function validateEntityLinkPreview(value: unknown, integrity: Integrity) {
  const preview = EntityLinkPreviewSchema.parse(value);
  verifyPlan(preview.reviewId, preview.plan, integrity);
  verifyReservation(preview.plan, preview.producerContext, integrity);
  return preview;
}
function admit(input: EntityLinkInvocationPlan, outcome: EntityLinkExecutionOutcome, overrun: boolean): EntityLinkInvocationAdmission {
  if (overrun) return { admissionKind: 'rejected', reason: 'reservation_overrun' };
  if (outcome.outcomeKind === 'exception') return { admissionKind: 'rejected', reason: 'exception' };
  const result = outcome.result;
  if (!result.ok) return { admissionKind: 'rejected', reason: 'failed_execution' };
  if (!Number.isSafeInteger(result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheCreationTokens)) return { admissionKind: 'rejected', reason: 'invalid_response' };
  if (result.toolCalls?.length || result.turns?.some(turn => turn && typeof turn === 'object' && !Array.isArray(turn) && Array.isArray(turn.toolCalls) && turn.toolCalls.length)) return { admissionKind: 'rejected', reason: 'observed_tools' };
  try {
    const suggestion = checkEntityLinkSuggestion(JSON.parse(result.output!), input);
    return { admissionKind: 'admitted', suggestion };
  } catch { return { admissionKind: 'rejected', reason: 'invalid_response' }; }
}
function validateIntent(plan: EntityLinkInvocationPlan, command: Extract<EntityLinkInvocationCommand, { commandKind: 'reviewed' }>, integrity: Integrity) {
  const application = command.application!;
  if (application.applicationKind !== 'intent') return;
  const intent = application.intent; const endpoints = [plan.left, plan.right]; const owners = endpoints.flatMap(endpoint => endpoint.owner ? [endpoint.owner] : []);
  const input = verifyPlan(command.reviewId, plan, integrity);
  if (!equal(intent.revision.revisedBy, command.actor) || intent.revision.reason !== command.reason
    || (command.objectLabel !== null && command.objectLabel !== intent.revision.draft.label)
    || input.left.entity.identityStatus !== 'proposed' || input.right.entity.identityStatus !== 'proposed'
    || input.left.entity.referentKind !== intent.revision.draft.referentKind || input.right.entity.referentKind !== intent.revision.draft.referentKind
    || owners.length > 1 || (owners[0] ? intent.objectId !== owners[0].objectId || intent.expectedGeneration !== owners[0].generation
      || intent.expectedHeadRevisionId !== owners[0].headRevisionId : intent.expectedGeneration !== 0 || intent.expectedHeadRevisionId !== null || intent.revision.draft.members.length !== 2)
    || (intent.revision.parentRevisionId ?? null) !== intent.expectedHeadRevisionId) throw new EntityLinkInvocationConflictError('Reviewed library intent conflict.');
  for (const endpoint of endpoints) {
    const member = intent.revision.draft.members.find(member => member.analysisId === endpoint.analysisId && member.entityId === endpoint.entityId);
    if (!member || member.entityRevisionId !== endpoint.entityRevisionId || !equal(member.mentionIds, endpoint.mentionIds) || member.rationale !== command.reason) throw new EntityLinkInvocationConflictError('Reviewed endpoint conflict.');
  }
}
function factsFor(history: EntityLinkInvocation | undefined, command: EntityLinkInvocationCommand, ports: EntityLinkInvocationPorts) {
  if (command.commandKind === 'prepare') {
    verifyPlan(command.reviewId, command.input, ports, true);
    const reservation = ports.reserve(command.input.request);
    if (!reservation || !ports.reservationIsCurrent(command.input.request, reservation)) throw new EntityLinkInvocationConflictError('A proven producer archive reservation is required before invocation.');
    return { reservation: EntityLinkReservationSchema.parse(reservation) };
  }
  const prepared = history!.events[0].command;
  if (prepared.commandKind !== 'prepare') throw new EntityLinkInvocationConflictError('Missing preparation.');
  if (command.commandKind === 'start') {
    const reservation = EntityLinkReservationSchema.parse(history!.events[0].facts.reservation);
    if (!ports.reservationIsCurrent(prepared.input.request, reservation)) throw new EntityLinkInvocationConflictError('Producer reservation changed before invocation.');
  }
  if (command.commandKind === 'execution_unknown') {
    const started = history!.events.find(event => event.command.commandKind === 'start')?.command;
    if (started?.commandKind !== 'start') throw new EntityLinkInvocationConflictError('Missing execution owner.');
    const exit = ports.proveOwnerExited(started.owner);
    if (!exit) throw new EntityLinkInvocationConflictError('Execution owner is live or unverifiable.');
    return { exit: EntityLinkOwnerExitSchema.parse(exit) };
  }
  if (command.commandKind === 'execution_recorded') {
    const reservation = EntityLinkReservationSchema.parse(history!.events[0].facts.reservation);
    const outcomeBytes = bytes(canonicalJson(command.outcome)), overrun = outcomeBytes > reservation.maxOutcomeJsonBytes;
    // Never drop a completed response just because a producer violated its reservation.
    return { outcomeBytes, reservationStatus: overrun ? 'overrun' : 'within', admission: admit(prepared.input, command.outcome, overrun) };
  }
  return {};
}

/** Replay only persisted facts; a historical read must not depend on today's producer or process. */
export function validateEntityLinkInvocation(value: EntityLinkInvocation, integrity: Integrity): EntityLinkInvocation {
  const history = EntityLinkInvocationSchema.parse(value);
  if (history.generation !== history.events.length || history.writeHeadEventId !== history.events.at(-1)!.command.eventId
    || new Set(history.events.map(event => event.command.eventId)).size !== history.events.length
    || new Set(history.events.map(event => event.command.requestId)).size !== history.events.length) throw new EntityLinkInvocationConflictError('Invalid invocation history identities.');
  let status: EntityLinkInvocationStatus | undefined; let prepared: Extract<EntityLinkInvocationCommand, { commandKind: 'prepare' }> | undefined;
  let started: Extract<EntityLinkInvocationCommand, { commandKind: 'start' }> | undefined;
  let admission: EntityLinkInvocationAdmission | undefined; let decision: Extract<EntityLinkInvocationCommand, { commandKind: 'reviewed' }> | undefined;
  for (const [index, event] of history.events.entries()) {
    const command = event.command; const { eventDigest, ...body } = event;
    if (command.reviewId !== history.reviewId || command.expectedGeneration !== index || event.commandDigest !== commandDigest(command, integrity.hashJson)
      || eventDigest !== integrity.hashJson(body)) throw new EntityLinkInvocationConflictError('Invalid invocation event integrity.');
    if (command.commandKind === 'prepare') {
      if (index !== 0) throw new EntityLinkInvocationConflictError('Preparation is immutable.');
      prepared = command; verifyPlan(command.reviewId, command.input, integrity);
      const reservation = EntityLinkReservationSchema.parse(event.facts.reservation); verifyReservation(command.input, reservation, integrity);
      if (!equal(event.facts, { reservation }) || history.pairKey !== entityLinkPairKey(command.input.left, command.input.right, integrity.hashJson)) throw new EntityLinkInvocationConflictError('Invalid preparation facts.');
      status = 'prepared'; continue;
    }
    if (!prepared) throw new EntityLinkInvocationConflictError('Preparation required.');
    if (command.commandKind === 'start') {
      if (status !== 'prepared' || !equal(event.facts, {})) throw new EntityLinkInvocationConflictError('Only one invocation may start.');
      started = command; status = 'running';
    } else if (command.commandKind === 'cancel_before_start') {
      if (status !== 'prepared' || !equal(event.facts, {})) throw new EntityLinkInvocationConflictError('Cannot refund an invocation that may have started.');
      status = 'cancelled_before_start';
    } else if (command.commandKind === 'execution_unknown') {
      const exit = EntityLinkOwnerExitSchema.parse(event.facts.exit);
      if (status !== 'running' || !started || command.executionId !== started.executionId || !equal(exit.owner, started.owner)
        || !equal(event.facts, { exit })) throw new EntityLinkInvocationConflictError('Unknown execution lacks matching owner-exit facts.');
      status = 'execution_unknown';
    } else if (command.commandKind === 'execution_recorded') {
      if (admission || !['running', 'execution_unknown'].includes(status!) || !started || command.executionId !== started.executionId) throw new EntityLinkInvocationConflictError('Execution receipt conflict.');
      const reservation = EntityLinkReservationSchema.parse(history.events[0].facts.reservation);
      const outcomeBytes = bytes(canonicalJson(command.outcome)), overrun = outcomeBytes > reservation.maxOutcomeJsonBytes;
      admission = admit(prepared.input, command.outcome, overrun);
      if (!equal(event.facts, { outcomeBytes, reservationStatus: overrun ? 'overrun' : 'within', admission })) throw new EntityLinkInvocationConflictError('Execution facts conflict.');
      status = command.outcome.outcomeKind === 'exception' ? 'execution_unknown' : admission.admissionKind === 'admitted' ? 'awaiting_review' : 'execution_failed';
    } else if (command.commandKind === 'reviewed') {
      if (!admission || !['awaiting_review', 'execution_failed', 'execution_unknown'].includes(status!) || !equal(event.facts, {})) throw new EntityLinkInvocationConflictError('A saved response is required for human review.');
      if (command.decision === 'reject') {
        if (command.application || command.identityConfirmed || command.objectLabel !== null) throw new EntityLinkInvocationConflictError('Rejected review cannot publish.');
        status = 'rejected';
      } else {
        if (!command.identityConfirmed || !command.application || admission?.admissionKind !== 'admitted') throw new EntityLinkInvocationConflictError('Explicit human identity confirmation required.');
        validateIntent(prepared.input, command, integrity);
        status = command.application.applicationKind === 'conflict' ? 'accepted_conflict' : 'accepted_pending_application';
      }
      decision = command;
    } else {
      if (status !== 'accepted_pending_application' || !decision || decision.application?.applicationKind !== 'intent'
        || !equal(command.actor, decision.actor) || !equal(event.facts, {})) throw new EntityLinkInvocationConflictError('A stable reviewed intent is required for publication.');
      if (command.commandKind === 'application_applied') {
        const intent = decision.application.intent, receipt = command.receipt;
        if (receipt.requestId !== intent.requestId || receipt.commandDigest !== integrity.hashJson(intent) || receipt.revisionId !== intent.revision.revisionId
          || receipt.committedGeneration !== intent.expectedGeneration + 1) throw new EntityLinkInvocationConflictError('Library receipt does not match reviewed intent.');
        status = 'applied';
      } else status = 'accepted_conflict';
    }
  }
  return history;
}

/** Persist returned history under the workspace lock before honoring dispatch_once. */
export function transitionEntityLinkInvocation(previous: EntityLinkInvocation | undefined, input: EntityLinkInvocationCommand,
  ports: EntityLinkInvocationPorts): { history: EntityLinkInvocation; effect: 'none' | 'dispatch_once' } {
  const command = EntityLinkInvocationCommandSchema.parse(input); const digest = commandDigest(command, ports.hashJson);
  const current = previous ? validateEntityLinkInvocation(previous, ports) : undefined;
  if (current && command.reviewId !== current.reviewId) throw new EntityLinkInvocationConflictError('Invocation review identity conflict.');
  const replay = current?.events.find(event => event.command.requestId === command.requestId);
  if (replay) {
    if (replay.commandDigest !== digest) throw new EntityLinkInvocationConflictError('Invocation request identity conflict.');
    return { history: current!, effect: 'none' };
  }
  const archived = current?.events.find(event => event.command.commandKind === 'execution_recorded');
  if (command.commandKind === 'execution_recorded' && archived?.command.commandKind === 'execution_recorded') {
    if (archived.command.executionId !== command.executionId || !equal(archived.command.outcome, command.outcome)) throw new EntityLinkInvocationConflictError('Execution outcome identity conflict.');
    return { history: current!, effect: 'none' };
  }
  if ((!current && command.commandKind !== 'prepare') || command.expectedGeneration !== (current?.generation ?? 0)) throw new EntityLinkInvocationConflictError('Invocation revision conflict.');
  const facts = factsFor(current, command, ports);
  const eventBody = { command, commandDigest: digest, facts };
  const event = { ...eventBody, eventDigest: ports.hashJson(eventBody) } as EntityLinkInvocationEvent;
  const history = { storeKind: 'entity-link-invocation-history' as const, schemaVersion: 1 as const, reviewId: command.reviewId,
    pairKey: current?.pairKey ?? entityLinkPairKey((command as Extract<EntityLinkInvocationCommand, { commandKind: 'prepare' }>).input.left,
      (command as Extract<EntityLinkInvocationCommand, { commandKind: 'prepare' }>).input.right, ports.hashJson),
    generation: (current?.generation ?? 0) + 1, writeHeadEventId: command.eventId, events: [...(current?.events ?? []), event] };
  return { history: validateEntityLinkInvocation(history, ports), effect: command.commandKind === 'start' ? 'dispatch_once' : 'none' };
}

export function projectEntityLinkInvocation(input: EntityLinkInvocation, integrity: Integrity) {
  const history = validateEntityLinkInvocation(input, integrity), commands = history.events.map(event => event.command);
  const last = commands.at(-1)!; const started = commands.find(command => command.commandKind === 'start');
  const recorded = history.events.find(event => event.command.commandKind === 'execution_recorded');
  const reviewed = commands.find(command => command.commandKind === 'reviewed');
  const status: EntityLinkInvocationStatus = last.commandKind === 'prepare' ? 'prepared' : last.commandKind === 'start' ? 'running'
    : last.commandKind === 'cancel_before_start' ? 'cancelled_before_start' : last.commandKind === 'execution_unknown' ? 'execution_unknown'
      : last.commandKind === 'application_applied' ? 'applied' : last.commandKind === 'application_conflict' ? 'accepted_conflict'
        : last.commandKind === 'reviewed' ? last.decision === 'reject' ? 'rejected' : last.application?.applicationKind === 'conflict' ? 'accepted_conflict' : 'accepted_pending_application'
          : last.commandKind === 'execution_recorded' && last.outcome.outcomeKind === 'exception' ? 'execution_unknown'
          : EntityLinkInvocationAdmissionSchema.parse(recorded!.facts.admission).admissionKind === 'admitted' ? 'awaiting_review' : 'execution_failed';
  const outcome = recorded?.command.commandKind === 'execution_recorded' ? recorded.command.outcome : undefined;
  const result = outcome?.outcomeKind === 'result' ? outcome.result : undefined;
  return { reviewId: history.reviewId, generation: history.generation, status, invocationBudget: { reserved: status === 'prepared' ? 1 : 0, consumed: started ? 1 : 0 },
    executorAttemptCount: result ? result.attemptCount ?? 1 : null,
    usage: { inputTokens: result && result.tokenUsageReportedByExecutor !== false ? result.inputTokens : null,
      outputTokens: result && result.tokenUsageReportedByExecutor !== false ? result.outputTokens : null,
      cacheReadTokens: result && result.tokenUsageReportedByExecutor !== false ? result.cacheReadTokens : null,
      cacheCreationTokens: result && result.tokenUsageReportedByExecutor !== false ? result.cacheCreationTokens : null,
      costUSD: result && result.costReportedByExecutor !== false ? result.costUSD : null },
    admission: recorded ? EntityLinkInvocationAdmissionSchema.parse(recorded.facts.admission) : null,
    canStart: status === 'prepared', canResumeOrganization: status === 'accepted_pending_application', decision: reviewed ?? null };
}
