import { canonicalJson } from '../../knowledge/store.js';
import { EntityLinkReservationSchema, type EntityLinkInvocation, type EntityLinkInvocationPorts } from '../../knowledge/entities/link-invocation.js';
import { projectEntityLinkInvocation, type EntityLinkInvocationStatus } from '../../knowledge/entities/link-invocation-state.js';

type Integrity = Pick<EntityLinkInvocationPorts, 'hashJson' | 'hashText'>;
type Projection = ReturnType<typeof projectEntityLinkInvocation>;
type Assessment = Extract<NonNullable<Projection['admission']>, { admissionKind: 'admitted' }>['suggestion']['assessment'];
type UsageKey = keyof Projection['usage'];
interface UsageCount { knownReviewCount: number; unknownReviewCount: number; reportingUnspecifiedReviewCount: number; knownTotal: number | null; overflow: boolean }
interface QualityGroup {
  identity: {
    historySchemaVersion: 1; invocationProtocol: string; promptVersion: string; promptHash: string;
    executor: string; model: string; responseSchemaId: string; responseSchemaHash: string;
    outputMode: string; timeoutMs: number; maxOutputTokens: number | null; invocationBudget: 1;
    producerId: string; producerRevision: string; sourceChannels: unknown; maxOutcomeJsonBytes: number; producerPolicy: unknown;
  };
  reviews: { total: number; notDispatched: number; dispatched: number; reserved: number; resultRecorded: number; exceptionRecorded: number;
    outcomeUnrecorded: number; byStatus: Record<EntityLinkInvocationStatus, number> };
  admission: { recorded: number; admitted: number; rejected: number; unrecordedDispatched: number; admissionRate: number | null;
    reasons: { reason: string; count: number }[] };
  assessments: { assessment: Assessment; admitted: number; humanAccepted: number; humanRejected: number; humanUndecided: number }[];
  humanDecisions: { decided: number; accepted: number; rejected: number; undecidedAdmitted: number; undecidedRejected: number; acceptanceRate: number | null };
  organization: { applied: number; acceptedPending: number; acceptedConflict: number };
  executionFailures: { failureKind: string; count: number }[];
  usage: Record<UsageKey, UsageCount>;
}
interface QualityBody { projectionKind: 'entity-link-quality'; projectionVersion: 'omk.entity-link-quality/v1' }
export type EntityLinkQuality = QualityBody & (
  { readStatus: 'available'; reviewCount: number; groups: QualityGroup[] }
  | { readStatus: 'unreadable'; reviewCount: null; groups: [] }
);
const body: QualityBody = { projectionKind: 'entity-link-quality', projectionVersion: 'omk.entity-link-quality/v1' };
const statuses: EntityLinkInvocationStatus[] = ['prepared', 'running', 'execution_unknown', 'awaiting_review', 'execution_failed',
  'cancelled_before_start', 'rejected', 'accepted_pending_application', 'accepted_conflict', 'applied'];
const usageKeys: UsageKey[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUSD'];
const countReason = <K extends string>(rows: ({ count: number } & Record<K, string>)[], key: K, value: string) => {
  const row = rows.find(row => row[key] === value); if (row) row.count++; else rows.push({ [key]: value, count: 1 } as { count: number } & Record<K, string>);
};

/** An unreadable namespace proves neither zero reviews nor complete partial coverage. */
export function unreadableEntityLinkQuality(): EntityLinkQuality { return { ...body, readStatus: 'unreadable', reviewCount: null, groups: [] }; }

/** A read-only projection of saved invocation facts. No source reread, executor, or human correctness label is inferred. */
export function entityLinkQuality(histories: readonly EntityLinkInvocation[], integrity: Integrity): EntityLinkQuality {
  const groups = new Map<string, QualityGroup>(), seen = new Set<string>();
  for (const history of [...histories].sort((a, b) => a.reviewId < b.reviewId ? -1 : a.reviewId > b.reviewId ? 1 : 0)) {
    if (seen.has(history.reviewId)) throw new Error('Duplicate entity-link review identity.'); seen.add(history.reviewId);
    const projection = projectEntityLinkInvocation(history, integrity), prepare = history.events[0].command;
    if (prepare.commandKind !== 'prepare') throw new Error('Missing entity-link preparation.');
    const request = prepare.input.request, reservation = EntityLinkReservationSchema.parse(history.events[0].facts.reservation);
    // The full request/body digest is per review. All other producer proof fields
    // remain in the comparison identity, including unknown producer policies.
    const proof = reservation.proof;
    const producerPolicy = reservation.producerId === 'openai-chat-archive/v1' && proof && typeof proof === 'object' && !Array.isArray(proof)
      && proof.proofKind === 'openai-chat-return-bound/v1'
      ? Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'bodyDigest')) : proof;
    const identity: QualityGroup['identity'] = { historySchemaVersion: history.schemaVersion, invocationProtocol: request.protocolId,
      promptVersion: request.promptVersion, promptHash: request.promptHash, executor: request.executor, model: request.model,
      responseSchemaId: request.responseSchemaId, responseSchemaHash: request.responseSchemaHash, outputMode: request.outputFormat.mode,
      timeoutMs: request.timeoutMs, maxOutputTokens: request.maxOutputTokens ?? null, invocationBudget: 1,
      producerId: reservation.producerId, producerRevision: reservation.producerRevision, sourceChannels: reservation.sourceChannels,
      maxOutcomeJsonBytes: reservation.maxOutcomeJsonBytes, producerPolicy };
    const key = canonicalJson(identity); let group = groups.get(key);
    if (!group) {
      group = { identity, reviews: { total: 0, notDispatched: 0, dispatched: 0, reserved: 0, resultRecorded: 0, exceptionRecorded: 0, outcomeUnrecorded: 0,
        byStatus: Object.fromEntries(statuses.map(status => [status, 0])) as Record<EntityLinkInvocationStatus, number> },
      admission: { recorded: 0, admitted: 0, rejected: 0, unrecordedDispatched: 0, admissionRate: null, reasons: [] },
      assessments: (['same_object', 'different_objects', 'insufficient_evidence'] as const).map(assessment => ({ assessment, admitted: 0, humanAccepted: 0, humanRejected: 0, humanUndecided: 0 })),
      humanDecisions: { decided: 0, accepted: 0, rejected: 0, undecidedAdmitted: 0, undecidedRejected: 0, acceptanceRate: null },
      organization: { applied: 0, acceptedPending: 0, acceptedConflict: 0 }, executionFailures: [],
      usage: Object.fromEntries(usageKeys.map(key => [key, { knownReviewCount: 0, unknownReviewCount: 0, reportingUnspecifiedReviewCount: 0, knownTotal: null, overflow: false }])) as Record<UsageKey, UsageCount> };
      groups.set(key, group);
    }
    group.reviews.total++; group.reviews.byStatus[projection.status]++;
    group.reviews.reserved += projection.invocationBudget.reserved;
    const dispatched = projection.invocationBudget.consumed === 1;
    group.reviews[dispatched ? 'dispatched' : 'notDispatched']++;
    const recorded = history.events.find(event => event.command.commandKind === 'execution_recorded')?.command;
    const result = recorded?.commandKind === 'execution_recorded' && recorded.outcome.outcomeKind === 'result' ? recorded.outcome.result : undefined;
    if (recorded?.commandKind === 'execution_recorded') {
      group.reviews[recorded.outcome.outcomeKind === 'result' ? 'resultRecorded' : 'exceptionRecorded']++;
      if (recorded.outcome.outcomeKind === 'result' && recorded.outcome.result.failure) countReason(group.executionFailures, 'failureKind', recorded.outcome.result.failure.failureKind);
    } else if (dispatched) group.reviews.outcomeUnrecorded++;
    const admission = projection.admission, decision = projection.decision;
    if (admission) {
      group.admission.recorded++; group.admission[admission.admissionKind === 'admitted' ? 'admitted' : 'rejected']++;
      if (admission.admissionKind === 'rejected') countReason(group.admission.reasons, 'reason', admission.reason);
      else {
        const row = group.assessments.find(row => row.assessment === admission.suggestion.assessment)!;
        row.admitted++; row[!decision ? 'humanUndecided' : decision.decision === 'accept' ? 'humanAccepted' : 'humanRejected']++;
      }
      if (!decision) group.humanDecisions[admission.admissionKind === 'admitted' ? 'undecidedAdmitted' : 'undecidedRejected']++;
    } else if (dispatched) group.admission.unrecordedDispatched++;
    if (decision) { group.humanDecisions.decided++; group.humanDecisions[decision.decision === 'accept' ? 'accepted' : 'rejected']++; }
    if (projection.status === 'applied') group.organization.applied++;
    if (projection.status === 'accepted_pending_application') group.organization.acceptedPending++;
    if (projection.status === 'accepted_conflict') group.organization.acceptedConflict++;
    if (dispatched) for (const key of usageKeys) {
      const value = projection.usage[key], counts = group.usage[key];
      if (value === null) { counts.unknownReviewCount++; continue; }
      counts.knownReviewCount++;
      // Preserve the existing single-review projection, while disclosing legacy
      // numeric fields that do not attest to an explicit producer usage report.
      if (result && (key === 'costUSD' ? result.costReportedByExecutor : result.tokenUsageReportedByExecutor) === undefined) counts.reportingUnspecifiedReviewCount++;
      if (!counts.overflow) {
        const sum = (counts.knownTotal ?? 0) + value;
        if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) { counts.knownTotal = null; counts.overflow = true; }
        else counts.knownTotal = sum;
      }
    }
  }
  for (const group of groups.values()) {
    group.admission.admissionRate = group.admission.recorded ? group.admission.admitted / group.admission.recorded : null;
    group.humanDecisions.acceptanceRate = group.humanDecisions.decided ? group.humanDecisions.accepted / group.humanDecisions.decided : null;
    group.admission.reasons.sort((a, b) => a.reason.localeCompare(b.reason));
    group.executionFailures.sort((a, b) => a.failureKind.localeCompare(b.failureKind)); group.assessments.sort((a, b) => a.assessment.localeCompare(b.assessment));
  }
  return { ...body, readStatus: 'available', reviewCount: histories.length,
    groups: [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => group) };
}
