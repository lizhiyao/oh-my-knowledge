import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { KnowledgeActor } from '../../src/knowledge/contracts.js';
import { canonicalJson } from '../../src/knowledge/store.js';
import { EntityLinkSuggestionSchema } from '../../src/knowledge/entities/links.js';
import {
  EntityLinkExecutionOutcomeSchema, type EntityLinkInvocation, type EntityLinkInvocationCommand, type EntityLinkInvocationPlan,
  type EntityLinkInvocationPorts, type EntityLinkExecutionOutcome, type EntityLinkExecutionResult,
} from '../../src/knowledge/entities/link-invocation.js';
import { entityLinkConfirmationDigest, transitionEntityLinkInvocation, projectEntityLinkInvocation, validateEntityLinkInvocation } from '../../src/knowledge/entities/link-invocation-state.js';
import { entityLinkQuality } from '../../src/knowledge/entity-linking/entity-link-quality.js';

const textHash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const hash = (value: unknown) => textHash(canonicalJson(value));
const human = { actorKind: 'human' as const, actorId: 'fixture-person' }, host = { actorKind: 'agent' as const, actorId: 'fixture-host', executionRef: 'fixture-execution' };
const at = '2026-10-16T00:00:00Z';
function fixture(options: { model?: string; system?: string; endpoint?: string } = {}) {
  const binding = () => ({ analysisId: randomUUID(), entityId: randomUUID(), entityRevisionId: randomUUID(), generation: 1,
    snapshotId: randomUUID(), sourceVersion: textHash('source'), owner: null, mentionIds: [randomUUID()] });
  const left = binding(), right = binding();
  const side = (endpoint: typeof left) => ({ binding: endpoint,
    entity: { entityId: endpoint.entityId, label: '同名对象', description: '只在此来源窗口所指的对象', qualifiers: [], identityStatus: 'proposed', possibleEntityIds: [], uncertainties: [],
      referentKind: 'object', componentRef: null, collection: null },
    mentions: [{ mentionId: endpoint.mentionIds[0], entityId: endpoint.entityId, basis: 'explicit', rationale: '原文提及', selection: { evidenceRef: 'record-1', start: 0, end: 4, quote: '同名对象' } }], limitations: [] });
  const schema = z.record(z.string(), z.json()).parse(z.toJSONSchema(EntityLinkSuggestionSchema)), system = options.system ?? 'fixture prompt only';
  const requestBody = { requestKind: 'entity-link-execution-request' as const, protocolId: 'entity-link-executor/v1' as const, executor: 'openai-api' as const,
    model: options.model ?? 'fixture-model', system, prompt: canonicalJson({ protocolId: 'entity-link-model-input/v1', left: side(left), right: side(right) }),
    promptVersion: 'entity-link-proposal-v1' as const, promptHash: textHash(system), responseSchemaId: 'entity-link-suggestion/v1' as const, responseSchemaHash: hash(schema),
    outputFormat: { mode: 'json-schema' as const, name: 'entity_link_suggestion_v1' as const, schema }, timeoutMs: 300_000 as const, maxOutputTokens: 4096 as const };
  let alive = true, producerCurrent = true, reservationAvailable = true, reservationBytes = 100_000;
  const proof = { fixture: true, endpoint: options.endpoint ?? 'https://fixture.invalid' };
  const reviewId = randomUUID(), inputBody = { left, right, request: { ...requestBody, requestDigest: hash(requestBody) }, retryOf: null, producerContextDigest: hash({ producerId: 'fixture-only/v1', producerRevision: textHash('fixture-producer'), requestDigest: hash(requestBody), sourceChannels: [{ channel: 'fixture-result', maxBytes: reservationBytes }], maxOutcomeJsonBytes: reservationBytes, proof }) };
  const plan: EntityLinkInvocationPlan = { ...inputBody, confirmedDigest: entityLinkConfirmationDigest(reviewId, inputBody, hash) };
  const ports: EntityLinkInvocationPorts = { hashJson: hash, hashText: textHash,
    reserve: request => {
      if (!reservationAvailable) return;
      // An explicit TEST producer only. These numbers are not a production bound.
      const evidence = { producerId: 'fixture-only/v1', producerRevision: textHash('fixture-producer'), requestDigest: request.requestDigest,
        sourceChannels: [{ channel: 'fixture-result', maxBytes: reservationBytes }], maxOutcomeJsonBytes: reservationBytes, proof };
      return { ...evidence, reservationDigest: hash(evidence) };
    }, reservationIsCurrent: (request, reservation) => producerCurrent && reservation.producerId === 'fixture-only/v1' && reservation.requestDigest === request.requestDigest,
    proveOwnerExited: owner => alive ? undefined : { proofKind: 'local-process-exited', owner, observedAt: at } };
  let history: EntityLinkInvocation | undefined;
  const command = <T extends object>(body: T, actor: KnowledgeActor = host) => ({ reviewId, requestId: randomUUID(), eventId: randomUUID(), at, actor, expectedGeneration: history?.generation ?? 0, ...body }) as unknown as EntityLinkInvocationCommand;
  const apply = (value: EntityLinkInvocationCommand) => { const transition = transitionEntityLinkInvocation(history, value, ports); history = transition.history; return transition; };
  const prepare = () => apply(command({ commandKind: 'prepare', input: plan }, human));
  const executionId = randomUUID(), owner = { ownerId: randomUUID(), hostname: 'fixture-local-host', pid: 12345 };
  const start = () => apply(command({ commandKind: 'start', executionId, owner }));
  const output = JSON.stringify({ responseKind: 'entity-link-suggestion', schemaVersion: 1, leftEntityId: left.entityId, rightEntityId: right.entityId,
    assessment: 'same_object', leftMentionIds: left.mentionIds, rightMentionIds: right.mentionIds, rationale: '仍需人工核对' });
  const result = (patch: Partial<EntityLinkExecutionResult> = {}): EntityLinkExecutionResult => ({ ok: true, output, durationMs: 100, durationApiMs: 80,
    inputTokens: 11, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 2, costUSD: 0, costReportedByExecutor: false, stopReason: 'stop', numTurns: 1, ...patch });
  const archive = (outcome: EntityLinkExecutionOutcome) => apply(command({ commandKind: 'execution_recorded', executionId, outcome }));
  return { reviewId, plan, ports, command, apply, prepare, start, result, archive, executionId, owner,
    get history() { return history!; }, setAlive(value: boolean) { alive = value; }, setCurrent(value: boolean) { producerCurrent = value; },
    setAvailable(value: boolean) { reservationAvailable = value; }, setBytes(value: number) { reservationBytes = value; plan.producerContextDigest = ports.reserve(plan.request)!.reservationDigest; plan.confirmedDigest = entityLinkConfirmationDigest(reviewId, plan, hash); } };
}

describe('entity-link invocation pure production flow', () => {
  it('requires a trusted producer reservation, exact confirmation and current proof before any dispatch effect', () => {
    const f = fixture(); f.setAvailable(false); expect(() => f.prepare()).toThrow('proven producer');
    f.setAvailable(true); const changed = { ...f.plan, request: { ...f.plan.request, model: 'different-model' } };
    expect(() => f.apply(f.command({ commandKind: 'prepare', input: changed }, human))).toThrow('Frozen');
    expect(() => f.apply(f.command({ commandKind: 'prepare', input: f.plan, reservation: {} }, human))).toThrow();
    expect(f.prepare().effect).toBe('none'); f.setCurrent(false); expect(() => f.start()).toThrow('reservation changed');
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'prepared', invocationBudget: { reserved: 1, consumed: 0 } });
  });
  it('claims dispatch once, refuses concurrent starts, and never refunds started or unknown calls', () => {
    const f = fixture(); f.prepare(); const start = f.command({ commandKind: 'start', executionId: f.executionId, owner: { ownerId: randomUUID(), hostname: 'host', pid: 44 } });
    expect(f.apply(start).effect).toBe('dispatch_once'); expect(f.apply({ ...start, eventId: randomUUID(), at: '2026-10-16T01:00:00Z' }).effect).toBe('none');
    expect(() => f.start()).toThrow('Only one'); expect(() => f.apply(f.command({ commandKind: 'cancel_before_start', reason: 'cancel' }))).toThrow('refund');
    expect(() => f.apply(f.command({ commandKind: 'execution_unknown', executionId: f.executionId }))).toThrow('live or unverifiable');
    f.setAlive(false); f.apply(f.command({ commandKind: 'execution_unknown', executionId: f.executionId }));
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'execution_unknown', canStart: false, invocationBudget: { consumed: 1 }, executorAttemptCount: null,
      usage: { inputTokens: null, costUSD: null } });
    const restored = JSON.parse(JSON.stringify(f.history)); expect(validateEntityLinkInvocation(restored, f.ports)).toEqual(f.history);
    f.archive({ outcomeKind: 'result', result: f.result() }); expect(projectEntityLinkInvocation(f.history, f.ports).status).toBe('awaiting_review');
  });
  it('fences a live or unverifiable owner with a versioned human command, preserving late evidence without admission', () => {
    const f = fixture(); f.prepare(); f.start(); const runningBytes = canonicalJson(f.history);
    const body = { commandKind: 'execution_terminated', terminationVersion: 'omk.entity-link-termination/v1', executionId: f.executionId,
      owner: f.owner, reason: '原进程状态不能确认，人工封存本次调用' };
    expect(() => f.apply(f.command(body))).toThrow('human');
    for (const owner of [{ ...f.owner, ownerId: randomUUID() }, { ...f.owner, hostname: 'forged-host' }, { ...f.owner, pid: 99999 }]) {
      expect(() => f.apply(f.command({ ...body, owner }, human))).toThrow('original owner');
    }
    expect(() => f.apply(f.command({ ...body, executionId: randomUUID() }, human))).toThrow('original owner');
    expect(() => f.apply({ ...f.command(body, human), expectedGeneration: 1 })).toThrow('revision conflict');
    const command = f.command(body, human);
    if (command.commandKind !== 'execution_terminated') throw new Error('Missing termination command.');
    f.ports.reserve = () => { throw new Error('Termination must not inspect a producer.'); };
    f.ports.reservationIsCurrent = () => { throw new Error('Termination must not configure a producer.'); };
    f.ports.proveOwnerExited = () => { throw new Error('Termination must not assert owner exit.'); };
    expect(f.apply(command).effect).toBe('none');
    expect(canonicalJson({ ...f.history, generation: 2, writeHeadEventId: f.history.events[1].command.eventId, events: f.history.events.slice(0, 2) })).toBe(runningBytes);
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ projectionVersion: 'omk.entity-link-invocation-projection/v2',
      status: 'execution_terminated', execution: { executionId: f.executionId, owner: f.owner }, termination: command,
      admission: null, decision: null, canStart: false, canResumeOrganization: false, canTerminateExecution: false,
      invocationBudget: { reserved: 0, consumed: 1 }, executorAttemptCount: null, usage: { inputTokens: null, costUSD: null } });
    const outcome = { outcomeKind: 'result' as const, result: f.result({ tokenUsageReportedByExecutor: true, costReportedByExecutor: false }) };
    f.archive(outcome);
    expect(f.history.events.at(-1)).toMatchObject({ command: { outcome }, facts: { archiveDisposition: 'terminated', reservationStatus: 'within' } });
    expect(f.history.events.at(-1)!.facts).not.toHaveProperty('admission');
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'execution_terminated', admission: null, decision: null,
      invocationBudget: { consumed: 1 }, executorAttemptCount: 1, usage: { inputTokens: 11, costUSD: null } });
    const archived = f.history;
    expect(f.apply(command)).toEqual({ history: archived, effect: 'none' });
    expect(f.archive(outcome)).toEqual({ history: archived, effect: 'none' });
    expect(() => f.apply({ ...command, reason: '改变终止原因' })).toThrow('request identity');
    expect(() => f.apply({ ...command, actor: { ...human, actorId: 'other-human' } })).toThrow('request identity');
    expect(() => f.archive({ outcomeKind: 'result', result: f.result({ output: 'changed late bytes' }) })).toThrow('outcome identity');
    for (const decision of ['accept', 'reject'] as const) expect(() => f.apply(f.command({ commandKind: 'reviewed', decision,
      identityConfirmed: false, reason: '不能复活已封存调用', objectLabel: null, application: null }, human))).toThrow('saved response');
    expect(canonicalJson(f.history)).toBe(canonicalJson(archived)); expect(validateEntityLinkInvocation(JSON.parse(JSON.stringify(archived)), f.ports)).toEqual(archived);
  });
  it('permits termination only while running and lets an archived response win a stale termination race', () => {
    const f = fixture(); f.prepare();
    const terminate = () => f.command({ commandKind: 'execution_terminated', terminationVersion: 'omk.entity-link-termination/v1',
      executionId: f.executionId, owner: f.owner, reason: '仅封存仍在运行的调用' }, human);
    expect(() => f.apply(terminate())).toThrow('running execution');
    f.start(); const stale = terminate(); f.archive({ outcomeKind: 'result', result: f.result() });
    expect(() => f.apply(stale)).toThrow('revision conflict'); expect(() => f.apply(terminate())).toThrow('running execution');
    expect(projectEntityLinkInvocation(f.history, f.ports).status).toBe('awaiting_review');
    const unknown = fixture(); unknown.prepare(); unknown.start(); unknown.setAlive(false);
    unknown.apply(unknown.command({ commandKind: 'execution_unknown', executionId: unknown.executionId }));
    expect(() => unknown.apply(unknown.command({ commandKind: 'execution_terminated', terminationVersion: 'omk.entity-link-termination/v1',
      executionId: unknown.executionId, owner: unknown.owner, reason: 'unknown 不冒充 running' }, human))).toThrow('running execution');
  });
  it('cancels only an unstarted reservation and cannot start it after restart', () => {
    const f = fixture(); f.prepare(); f.apply(f.command({ commandKind: 'cancel_before_start', reason: '取消发送' }));
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'cancelled_before_start', invocationBudget: { reserved: 0, consumed: 0 } });
    expect(() => f.start()).toThrow('Only one');
  });
  it.each(['rate_limit', 'timeout', 'cancelled', 'refusal', 'truncation', 'unsupported_output'] as const)('archives failed %s output, refusal and full usage before admission', failureKind => {
    const f = fixture(); f.prepare(); f.start(); const result = f.result({ ok: false, output: '原始部分响应', refusal: '原始拒绝通道', failure: { failureKind, httpStatus: 429, retryAfterMs: 10 },
      error: '脱敏错误', costUSD: 0.02, costReportedByExecutor: true, attemptCount: 2, cached: false, fullNumTurns: 3, numSubAgents: 1,
      turns: [{ role: 'assistant', content: '原始部分响应' }], toolCalls: [{ tool: 'example', input: { value: 1 }, output: null, success: false }], futureProducerField: { retain: true } });
    f.archive({ outcomeKind: 'result', result, cleanupFailure: { diagnostic: 'cleanup failed' } });
    const saved = f.history.events.at(-1)!.command; expect(saved).toMatchObject({ commandKind: 'execution_recorded', outcome: { result, cleanupFailure: { diagnostic: 'cleanup failed' } } });
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'execution_failed', executorAttemptCount: 2, invocationBudget: { consumed: 1 },
      usage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 2, costUSD: 0.02 } });
    expect(() => f.apply(f.command({ commandKind: 'reviewed', decision: 'accept', identityConfirmed: true, reason: 'cannot accept', objectLabel: null,
      application: { applicationKind: 'conflict', conflictCode: 'entity_changed' } }, human))).toThrow('confirmation');
  });
  it('retains unknown usage, bounded exception observation and the consumed slot after a post-start throw', () => {
    const f = fixture(); f.prepare(); f.start(); const error = { representationKind: 'exception-diagnostic/v1' as const, sourceType: 'object' as const,
      name: 'Error', message: 'mkdtemp/pre-abort/dispatch may have thrown; outcome unknown', truncated: false, accessorsSkipped: true };
    const running = f.history; f.archive({ outcomeKind: 'exception', error });
    const resultCommand = f.command({ commandKind: 'execution_recorded', executionId: f.executionId, outcome: { outcomeKind: 'result', result: f.result() } });
    expect(() => f.apply(resultCommand)).toThrow('outcome identity');
    const alternate = transitionEntityLinkInvocation(running, { ...resultCommand, expectedGeneration: running.generation }, f.ports).history.events.at(-1)!;
    const eventBody = { command: resultCommand, commandDigest: alternate.commandDigest, facts: alternate.facts };
    const doubled = { ...f.history, generation: f.history.generation + 1, writeHeadEventId: resultCommand.eventId,
      events: [...f.history.events, { ...eventBody, eventDigest: hash(eventBody) }] };
    expect(() => validateEntityLinkInvocation(doubled, f.ports)).toThrow('receipt conflict');
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'execution_unknown', executorAttemptCount: null, usage: { inputTokens: null, costUSD: null }, invocationBudget: { consumed: 1 } });
    const raw: Record<string, unknown> = {}; raw.self = raw;
    expect(EntityLinkExecutionOutcomeSchema.safeParse({ outcomeKind: 'exception', error: raw }).success).toBe(false);
    expect(EntityLinkExecutionOutcomeSchema.safeParse({ outcomeKind: 'exception', error: { ...error, message: '界'.repeat(1366) } }).success).toBe(false);
  });
  it('saves an unexpected reservation overrun in full and prevents semantic admission rather than dropping raw evidence', () => {
    const f = fixture(); f.setBytes(32); f.prepare(); f.start(); const result = f.result({ output: 'original response '.repeat(1000) });
    f.archive({ outcomeKind: 'result', result });
    expect(f.history.events.at(-1)!.command).toMatchObject({ commandKind: 'execution_recorded', outcome: { result } });
    expect(projectEntityLinkInvocation(f.history, f.ports).admission).toEqual({ admissionKind: 'rejected', reason: 'reservation_overrun' });
  });
  it('recovers an archive acknowledgement without rerunning and rejects changed output under the same execution identity', () => {
    const f = fixture(); f.prepare(); f.start(); const outcome = { outcomeKind: 'result' as const, result: f.result({ tokenUsageReportedByExecutor: false }) };
    f.archive(outcome); const before = f.history; const replay = f.archive(outcome); expect(replay).toEqual({ history: before, effect: 'none' });
    expect(() => f.apply({ ...f.command({ commandKind: 'execution_recorded', executionId: f.executionId, outcome }), reviewId: randomUUID() })).toThrow('review identity');
    expect(() => f.archive({ outcomeKind: 'result', result: f.result({ output: 'different' }) })).toThrow('outcome identity');
    expect(projectEntityLinkInvocation(f.history, f.ports).usage).toEqual({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, costUSD: null });
    const tampered = structuredClone(f.history); const last = tampered.events.at(-1)!.command;
    if (last.commandKind === 'execution_recorded' && last.outcome.outcomeKind === 'result') last.outcome.result.cacheReadTokens = 999;
    expect(() => validateEntityLinkInvocation(tampered, f.ports)).toThrow('integrity');
  });
  it('requires independent human identity review and verifies a stable matching library receipt', () => {
    const f = fixture(); f.prepare(); f.start(); const uncertain = f.result(); uncertain.output = uncertain.output!.replace('same_object', 'insufficient_evidence');
    f.archive({ outcomeKind: 'result', result: uncertain });
    const reason = '人工核对两侧范围后确认同一对象'; const intent = { requestId: randomUUID(), objectId: randomUUID(), expectedGeneration: 0, expectedHeadRevisionId: null,
      revision: { revisionId: randomUUID(), revisedAt: at, revisedBy: human, reason, draft: { label: '人工组织名', description: '限定对象', referentKind: 'object',
        members: [f.plan.left, f.plan.right].map(side => ({ analysisId: side.analysisId, entityId: side.entityId, entityRevisionId: side.entityRevisionId, mentionIds: side.mentionIds, rationale: reason })) } } };
    const body = { commandKind: 'reviewed', decision: 'accept', identityConfirmed: true, reason, objectLabel: '人工组织名', application: { applicationKind: 'intent', intent } };
    expect(() => f.apply(f.command(body))).toThrow(); f.apply(f.command(body, human));
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'accepted_pending_application', canResumeOrganization: true });
    const receipt = { requestId: intent.requestId, commandDigest: hash(intent), committedGeneration: 1, revisionId: intent.revision.revisionId };
    expect(() => f.apply(f.command({ commandKind: 'application_applied', receipt: { ...receipt, revisionId: randomUUID() } }, human))).toThrow('receipt');
    const applied = f.command({ commandKind: 'application_applied', receipt }, human); f.apply(applied); expect(f.apply(applied).effect).toBe('none');
    expect(projectEntityLinkInvocation(f.history, f.ports).status).toBe('applied');
  });
  it('retains a human rejection as terminal and does not allow a later model execution or acceptance', () => {
    const f = fixture(); f.prepare(); f.start(); f.archive({ outcomeKind: 'result', result: f.result() });
    f.apply(f.command({ commandKind: 'reviewed', decision: 'reject', identityConfirmed: false, reason: '同名不证明同一对象', objectLabel: null, application: null }, human));
    const before = JSON.stringify(f.history); expect(projectEntityLinkInvocation(f.history, f.ports).status).toBe('rejected'); expect(() => f.start()).toThrow();
    expect(JSON.stringify(f.history)).toBe(before);
  });
  it.each(['invalid_json', 'observed_tools'] as const)('saves successful transport with %s but refuses semantic admission', mode => {
    const f = fixture(); f.prepare(); f.start(); const result = f.result(mode === 'invalid_json' ? { output: '{bad' } : { toolCalls: [{ tool: 'example', input: null, output: null, success: true }] });
    f.archive({ outcomeKind: 'result', result });
    expect(f.history.events.at(-1)!.command).toMatchObject({ commandKind: 'execution_recorded', outcome: { result } });
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'execution_failed', admission: { admissionKind: 'rejected', reason: mode === 'invalid_json' ? 'invalid_response' : 'observed_tools' } });
  });
  it('records explicit human acceptance with a prepublication conflict as terminal without a library receipt', () => {
    const f = fixture(); f.prepare(); f.start(); f.archive({ outcomeKind: 'result', result: f.result() });
    f.apply(f.command({ commandKind: 'reviewed', decision: 'accept', identityConfirmed: true, reason: '接受判断，但当前owner已经变化', objectLabel: null,
      application: { applicationKind: 'conflict', conflictCode: 'owner_conflict' } }, human));
    expect(projectEntityLinkInvocation(f.history, f.ports)).toMatchObject({ status: 'accepted_conflict', canResumeOrganization: false });
    expect(() => f.apply(f.command({ commandKind: 'application_conflict', conflictCode: 'library_capacity' }, human))).toThrow('stable reviewed intent');
  });

});

describe('entity-link quality saved-fact projection', () => {
  it('separates invocation, admission and human decision denominators, including rejected executions and unknown usage', () => {
    const prepared = fixture(); prepared.prepare();
    const cancelled = fixture(); cancelled.prepare(); cancelled.apply(cancelled.command({ commandKind: 'cancel_before_start', reason: '停止发送' }, human));
    const running = fixture(); running.prepare(); running.start();
    const unknown = fixture(); unknown.prepare(); unknown.start(); unknown.setAlive(false); unknown.apply(unknown.command({ commandKind: 'execution_unknown', executionId: unknown.executionId }));
    const admitted = fixture(); admitted.prepare(); admitted.start(); admitted.archive({ outcomeKind: 'result', result: admitted.result() });
    const accepted = fixture(); accepted.prepare(); accepted.start(); accepted.archive({ outcomeKind: 'result', result: accepted.result({ output: accepted.result().output!.replace('same_object', 'different_objects') }) });
    accepted.apply(accepted.command({ commandKind: 'reviewed', decision: 'accept', identityConfirmed: true, reason: '人审独立确认', objectLabel: null, application: { applicationKind: 'conflict', conflictCode: 'owner_conflict' } }, human));
    const rejected = fixture(); rejected.prepare(); rejected.start(); rejected.archive({ outcomeKind: 'result', result: rejected.result({ output: rejected.result().output!.replace('same_object', 'insufficient_evidence') }) });
    rejected.apply(rejected.command({ commandKind: 'reviewed', decision: 'reject', identityConfirmed: false, reason: '证据不足', objectLabel: null, application: null }, human));
    const failed = fixture(); failed.prepare(); failed.start(); failed.archive({ outcomeKind: 'result', result: failed.result({ ok: false, output: '拒绝', failure: { failureKind: 'refusal' }, tokenUsageReportedByExecutor: false }) });
    failed.apply(failed.command({ commandKind: 'reviewed', decision: 'reject', identityConfirmed: false, reason: '拒绝失败结果', objectLabel: null, application: null }, human));
    const exception = fixture(); exception.prepare(); exception.start(); exception.archive({ outcomeKind: 'exception', error: {
      representationKind: 'exception-diagnostic/v1', sourceType: 'undefined', name: null, message: 'unknown thrown result', truncated: true, accessorsSkipped: true } });
    const terminated = fixture(), late = fixture();
    for (const f of [terminated, late]) { f.prepare(); f.start(); f.apply(f.command({ commandKind: 'execution_terminated',
      terminationVersion: 'omk.entity-link-termination/v1', executionId: f.executionId, owner: f.owner, reason: '人工封存不等于身份拒绝' }, human)); }
    late.archive({ outcomeKind: 'result', result: late.result() });
    const histories = [prepared, cancelled, running, unknown, admitted, accepted, rejected, failed, exception, terminated, late].map(f => f.history), before = canonicalJson(histories);
    const result = entityLinkQuality(histories, prepared.ports);
    expect(result).toMatchObject({ projectionVersion: 'omk.entity-link-quality/v2', readStatus: 'available', reviewCount: 11 }); expect(result.groups).toHaveLength(1);
    const group = result.groups[0];
    expect(group.reviews).toMatchObject({ total: 11, notDispatched: 2, dispatched: 9, reserved: 1, resultRecorded: 5, exceptionRecorded: 1, outcomeUnrecorded: 3, byStatus: { execution_terminated: 2 } });
    expect(group.admission).toEqual({ recorded: 5, admitted: 3, rejected: 2, unrecordedDispatched: 2, terminatedDispatched: 2, admissionRate: 0.6, reasons: [{ reason: 'exception', count: 1 }, { reason: 'failed_execution', count: 1 }] });
    expect(group.humanTerminations).toEqual({ total: 2, outcomeUnrecorded: 1, lateOutcomeRecorded: 1 });
    expect(group.humanDecisions).toEqual({ decided: 3, accepted: 1, rejected: 2, undecidedAdmitted: 1, undecidedRejected: 1, acceptanceRate: 1 / 3 });
    expect(group.assessments).toEqual([{ assessment: 'different_objects', admitted: 1, humanAccepted: 1, humanRejected: 0, humanUndecided: 0 },
      { assessment: 'insufficient_evidence', admitted: 1, humanAccepted: 0, humanRejected: 1, humanUndecided: 0 },
      { assessment: 'same_object', admitted: 1, humanAccepted: 0, humanRejected: 0, humanUndecided: 1 }]);
    expect(group.usage.inputTokens).toEqual({ knownReviewCount: 4, unknownReviewCount: 5, reportingUnspecifiedReviewCount: 4, knownTotal: 44, overflow: false });
    expect(group.usage.costUSD).toEqual({ knownReviewCount: 0, unknownReviewCount: 9, reportingUnspecifiedReviewCount: 0, knownTotal: null, overflow: false });
    expect(group.executionFailures).toEqual([{ failureKind: 'refusal', count: 1 }]); expect(group.organization.acceptedConflict).toBe(1);
    expect(canonicalJson(histories)).toBe(before); expect(entityLinkQuality([...histories].reverse(), prepared.ports)).toEqual(result);
  });
  it('keeps model, prompt and producer policy groups separate, rejects duplicate/corrupt histories and never mixes unknown with zero', () => {
    const all = [fixture(), fixture({ model: 'other-model' }), fixture({ system: 'other prompt' }), fixture({ endpoint: 'https://other.invalid' })];
    for (const f of all) f.prepare();
    const result = entityLinkQuality(all.map(f => f.history), all[0].ports); expect(result.groups).toHaveLength(4);
    expect(result.groups.every(group => group.admission.admissionRate === null && group.humanDecisions.acceptanceRate === null && group.usage.inputTokens.knownTotal === null)).toBe(true);
    expect(() => entityLinkQuality([all[0].history, all[0].history], all[0].ports)).toThrow('Duplicate');
    const corrupt = structuredClone(all[0].history); corrupt.events[0].command.at = '2026-10-17T00:00:00Z';
    expect(() => entityLinkQuality([corrupt], all[0].ports)).toThrow('integrity');
    expect(entityLinkQuality([], all[0].ports)).toMatchObject({ readStatus: 'available', reviewCount: 0, groups: [] });
  });
  it('preserves reported zero and refuses unsafe usage sums while retaining per-review known/unknown counts', () => {
    const all = Array.from({ length: 3 }, () => fixture());
    for (const [index, f] of all.entries()) { f.prepare(); f.start(); f.archive({ outcomeKind: 'result', result: f.result({ inputTokens: index ? Number.MAX_SAFE_INTEGER - 10 : 0,
      outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, tokenUsageReportedByExecutor: true, costUSD: 0, costReportedByExecutor: true }) }); }
    const result = entityLinkQuality(all.map(f => f.history), all[0].ports);
    expect(result.groups[0].usage.inputTokens).toEqual({ knownReviewCount: 3, unknownReviewCount: 0, reportingUnspecifiedReviewCount: 0, knownTotal: null, overflow: true });
    expect(result.groups[0].usage.costUSD).toEqual({ knownReviewCount: 3, unknownReviewCount: 0, reportingUnspecifiedReviewCount: 0, knownTotal: 0, overflow: false });
  });
});
