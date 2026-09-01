import type {
  ExperienceEpisode,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttributionRole,
  ExperienceFeedbackSignal,
  ExperienceInvocation,
  ExperienceOrchestrationEdge,
  ExperienceReviewBasisCode,
  ExperienceReviewIndicators,
  ExperienceReviewPriority,
  ExperienceReviewerReport,
  ExperienceReviewerReportFinding,
  ExperienceRuntimeSkillType,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import {
  incrementRecordCount,
  sumRecordCounts as sumSafeCounts,
} from '../../shared/record-count.js';
import { checkedSumTokenCounts } from '../../shared/token-usage.js';
import { UNOBSERVED_TRACE_TIMESTAMP } from '../trace-segmenter.js';
import { isAssistantProgressUpdateText } from '../text-signals.js';
import { isAssistantDeliveryEvent } from './timeline.js';
import {
  uniqueBy,
} from './primitives.js';

export const ZERO_INDICATORS: ExperienceReviewIndicators = {
  userMessageCount: 0,
  userFollowUpCount: 0,
  userCorrectionCount: 0,
  userInterruptionCount: 0,
  sessionInterruptedCount: 0,
  negativeFeedbackCount: 0,
  positiveFeedbackCount: 0,
  userGoalShiftCount: 0,
  hardRuleTextHitCount: 0,
  assistantDeliverySignalCount: 0,
  deliverableArtifactSignalCount: 0,
  routerDownstreamCompleted: 0,
  routerDownstreamFailed: 0,
  selfCorrectionCount: 0,
  repeatedExecutionCount: 0,
  toolCallCount: 0,
  toolFailureCount: 0,
  toolCancelledCount: 0,
  toolUnknownCount: 0,
  highObservationCount: 0,
  mediumObservationCount: 0,
  hedgingCount: 0,
  explicitMarkerCount: 0,
};

export function invocationTimestampObserved(invocation: ExperienceInvocation): boolean {
  return invocation.timestampObserved
    ?? invocation.startTimestamp !== UNOBSERVED_TRACE_TIMESTAMP;
}

export function isAssistantProgressUpdateEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return isAssistantProgressUpdateText(text);
}

export function evidenceRefFromTimeline(event: ExperienceTimelineEvent): ExperienceEvidenceRef {
  return {
    id: event.id,
    kind: event.kind,
    traceId: event.traceId,
    sourceTrace: event.sourceTrace,
    sessionId: event.sessionId,
    traceRole: event.traceRole,
    traceLabel: event.traceLabel,
    messageIndex: event.messageIndex,
    logicalMessageIndex: event.logicalMessageIndex ?? event.messageIndex,
    sourceLineIndex: event.sourceLineIndex ?? event.messageIndex,
    messageUuid: event.messageUuid,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    role: event.role,
    modelActivityKind: event.modelActivityKind,
    contentVisibility: event.contentVisibility,
    contentSource: event.contentSource,
    sourceType: event.sourceType,
    runtimeKind: event.runtimeKind,
    label: event.label,
    snippet: event.snippet,
  };
}

export function primarySourceTraceForSession(session: ExperienceSessionSummary): string | undefined {
  return session.sourceTrace
    ?? session.evidenceChain.firstUserMessage?.sourceTrace
    ?? session.fullSessionTimeline.find((event) => event.traceRole === 'main')?.sourceTrace
    ?? session.fullSessionTimeline[0]?.sourceTrace
    ?? session.timelinePreview[0]?.sourceTrace;
}

export function assistantFinalDeliveryEvents(session: ExperienceSessionSummary): ExperienceTimelineEvent[] {
  return (session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview)
    .filter(isAssistantDeliveryEvent);
}

export function assistantProgressUpdateEvents(session: ExperienceSessionSummary): ExperienceTimelineEvent[] {
  return (session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview)
    .filter(isAssistantProgressUpdateEvent);
}

export interface CurrentSkillRuntimeModel {
  skillType: ExperienceRuntimeSkillType;
  isDelegator: boolean;
  hasDownstreamEdges: boolean;
  segments: ExperienceSkillSegment[];
  downstreamEdges: ExperienceOrchestrationEdge[];
  downstreamSignals: ExperienceFeedbackSignal[];
  primarySignals: ExperienceFeedbackSignal[];
  contextSignals: ExperienceFeedbackSignal[];
}

export function currentSkillRuntimeModel(session: ExperienceSessionSummary, episodesOverride?: ExperienceEpisode[]): CurrentSkillRuntimeModel | undefined {
  const episodes = episodesOverride ?? session.sessionStory?.episodes ?? [];
  const segments = uniqueBy(
    episodes.flatMap((episode) => episode.skillSegments).filter((segment) => segment.skillName === session.skillName),
    (segment) => segment.id,
  );
  if (segments.length === 0) return undefined;
  const segmentIds = new Set(segments.map((segment) => segment.id));
  const downstreamEdges = episodes.flatMap((episode) => episode.orchestrationEdges)
    .filter((edge) => edge.parentSkillSegmentId && segmentIds.has(edge.parentSkillSegmentId));
  const signals = episodes.flatMap((episode) => episode.feedbackSignals ?? []);
  const signalsForRole = (role: ExperienceFeedbackAttributionRole) => signals.filter((signal) =>
    (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
      attribution.skillName === session.skillName && attribution.attributionRole === role
    )
  );
  const declaredType = segments.map((segment) => segment.skillType).find((type) => type !== 'unknown') ?? 'unknown';
  const inferredType: ExperienceRuntimeSkillType = declaredType !== 'unknown'
    ? declaredType
    : downstreamEdges.length > 0
      ? 'router'
      : segments.some((segment) => segment.episodeRole === 'delegator')
        ? 'delegation'
        : 'unknown';
  return {
    skillType: inferredType,
    isDelegator: segments.some((segment) => segment.episodeRole === 'delegator'),
    hasDownstreamEdges: downstreamEdges.length > 0,
    segments,
    downstreamEdges,
    downstreamSignals: signalsForRole('downstream_related'),
    primarySignals: signalsForRole('primary_fault'),
    contextSignals: signalsForRole('context_only'),
  };
}

export function userFacingClosureForSession(
  session: ExperienceSessionSummary,
  episodesOverride?: ExperienceEpisode[],
): { deliveryCount: number; artifactCount: number; evidenceRefs: ExperienceEvidenceRef[] } {
  const runtime = currentSkillRuntimeModel(session, episodesOverride);
  const canUseDownstream = Boolean(runtime && (runtime.skillType === 'router' || runtime.skillType === 'delegation' || runtime.hasDownstreamEdges || runtime.isDelegator));
  if (!canUseDownstream) {
    return {
      deliveryCount: session.indicators.assistantDeliverySignalCount,
      artifactCount: session.indicators.deliverableArtifactSignalCount,
      evidenceRefs: uniqueEvidenceRefs([
        session.evidenceChain.lastAssistantMessage,
      ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
    };
  }
  const primarySourceTrace = primarySourceTraceForSession(session);
  const finalDeliveryEvents = assistantFinalDeliveryEvents(session)
    .filter((event) => isMainlineEvidenceRef(event, primarySourceTrace));
  const episodes = episodesOverride ?? session.sessionStory?.episodes ?? [];
  const artifacts = episodes
    .flatMap((episode) => episode.outcome.artifacts ?? [])
    .filter((artifact) => isMainlineEvidenceRef(artifact.evidenceRef, primarySourceTrace));
  const deliveryRefs = finalDeliveryEvents.map(evidenceRefFromTimeline);
  const artifactRefs = artifacts.map((artifact) => artifact.evidenceRef);
  return {
    deliveryCount: finalDeliveryEvents.length,
    artifactCount: artifacts.length,
    evidenceRefs: uniqueEvidenceRefs([...deliveryRefs, ...artifactRefs, session.evidenceChain.lastAssistantMessage].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))).slice(0, 5),
  };
}

export function isMainlineEvidenceRef(ref: Pick<ExperienceEvidenceRef, 'sourceTrace'> | undefined, primarySourceTrace?: string): boolean {
  if (!ref || !primarySourceTrace || !ref.sourceTrace) return true;
  return ref.sourceTrace === primarySourceTrace;
}

export function enrichRouterDownstreamIndicators(session: ExperienceSessionSummary): ExperienceReviewIndicators {
  const runtime = currentSkillRuntimeModel(session);
  if (!runtime || !(runtime.skillType === 'router' || runtime.hasDownstreamEdges)) return session.indicators;
  const closure = userFacingClosureForSession(session);
  const completedByEdge = runtime.downstreamEdges.some((edge) => edge.status === 'completed' || edge.runnerCompletedRef);
  const failedByEdge = runtime.downstreamEdges.some((edge) => edge.status === 'failed');
  const completed = closure.deliveryCount > 0 || closure.artifactCount > 0 || completedByEdge;
  const failed = failedByEdge || (!completed && runtime.downstreamSignals.length > 0);
  return {
    ...session.indicators,
    routerDownstreamCompleted: completed ? 1 : 0,
    routerDownstreamFailed: failed ? 1 : 0,
  };
}

export function sumTokenUsage(invocations: ExperienceInvocation[]): Omit<ExperienceReviewerReport['oneLookMetrics']['tokenUsage'], 'attribution'> {
  const observed = invocations.filter((invocation) => invocation.metrics.tokenUsageObserved);
  const inputTokens = checkedSumTokenCounts(...observed.map((invocation) => invocation.metrics.inputTokens));
  const outputTokens = checkedSumTokenCounts(...observed.map((invocation) => invocation.metrics.outputTokens));
  const cacheReadTokens = checkedSumTokenCounts(...observed.map((invocation) => invocation.metrics.cacheReadTokens));
  const cacheCreationTokens = checkedSumTokenCounts(...observed.map((invocation) => invocation.metrics.cacheCreationTokens));
  const aggregateValid = [
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  ].every((value) => value !== undefined)
    && checkedSumTokenCounts(
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    ) !== undefined;
  const observedInvocationCount = aggregateValid ? observed.length : 0;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheCreationTokens: cacheCreationTokens ?? 0,
    observedInvocationCount,
    invocationCount: invocations.length,
    coverage: invocations.length > 0
      ? Number((observedInvocationCount / invocations.length).toFixed(4))
      : 1,
  };
}

export function scoreForIndicators(indicators: ExperienceReviewIndicators): number {
  return sumSafeCounts(
    weightedCount(indicators.highObservationCount, 3),
    indicators.mediumObservationCount,
    weightedCount(indicators.userCorrectionCount, 2),
    weightedCount(indicators.userInterruptionCount, 2),
    weightedCount(indicators.sessionInterruptedCount, 2),
    weightedCount(indicators.negativeFeedbackCount, 2),
    indicators.hardRuleTextHitCount,
    indicators.toolFailureCount,
    weightedCount(indicators.routerDownstreamFailed, 2),
    indicators.hedgingCount,
    weightedCount(indicators.explicitMarkerCount, 2),
  );
}

export function weightedCount(count: number, weight: number): number {
  const weighted = count * weight;
  if (!Number.isSafeInteger(weighted) || weighted < 0) {
    throw new RangeError('Weighted observation count exceeds Number.MAX_SAFE_INTEGER');
  }
  return weighted;
}

export function priorityForScore(score: number): ExperienceReviewPriority {
  if (score >= 3) return 'review_first';
  if (score > 0) return 'sample_review';
  return 'routine_sample';
}

export function priorityForReviewerFindings(
  session: ExperienceSessionSummary,
  findings: ExperienceReviewerReportFinding[],
): ExperienceReviewPriority {
  const fallback = priorityForScore(session.reviewPriorityScore);
  const attentionFindings = findings.filter((finding) => finding.level === 'attention');
  if (attentionFindings.length === 0) return fallback;
  const criticalMissing = attentionFindings.some((finding) =>
    finding.ruleSource === 'final_delivery_absent'
    || finding.ruleSource === 'router_user_facing_closure_absent'
    || finding.ruleSource === 'session_interrupted'
    || finding.ruleSource === 'expected_tools_missed')
    || session.indicators.userMessageCount === 0
    || session.indicators.toolCallCount === 0;
  if (criticalMissing) return 'review_first';
  return fallback === 'routine_sample' ? 'sample_review' : fallback;
}

export function basisCodesForIndicators(indicators: ExperienceReviewIndicators): ExperienceReviewBasisCode[] {
  const codes: ExperienceReviewBasisCode[] = [];
  if (indicators.highObservationCount > 0) codes.push('has_high_observation');
  if (indicators.mediumObservationCount > 0) codes.push('has_medium_observation');
  if (indicators.userCorrectionCount > 0) codes.push('user_correction');
  if (indicators.userInterruptionCount > 0) codes.push('user_interruption');
  if (indicators.sessionInterruptedCount > 0) codes.push('session_interrupted');
  if (indicators.negativeFeedbackCount > 0) codes.push('negative_feedback');
  if (indicators.hardRuleTextHitCount > 0) codes.push('hard_rule_text_hit');
  if (indicators.toolFailureCount > 0) codes.push('tool_failure');
  if (indicators.hedgingCount > 0) codes.push('hedging_signal');
  if (indicators.explicitMarkerCount > 0) codes.push('explicit_marker');
  return codes;
}

export function sumRecordCounts(values: Array<Record<string, number>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value)) {
      incrementRecordCount(counts, key, count);
    }
  }
  return counts;
}

export function sumIndicators(values: ExperienceReviewIndicators[]): ExperienceReviewIndicators {
  return values.reduce((acc, value) => ({
    userMessageCount: sumSafeCounts(acc.userMessageCount, value.userMessageCount),
    userFollowUpCount: sumSafeCounts(acc.userFollowUpCount, value.userFollowUpCount),
    userCorrectionCount: sumSafeCounts(acc.userCorrectionCount, value.userCorrectionCount),
    userInterruptionCount: sumSafeCounts(acc.userInterruptionCount, value.userInterruptionCount),
    sessionInterruptedCount: sumSafeCounts(acc.sessionInterruptedCount, value.sessionInterruptedCount ?? 0),
    negativeFeedbackCount: sumSafeCounts(acc.negativeFeedbackCount, value.negativeFeedbackCount ?? 0),
    positiveFeedbackCount: sumSafeCounts(acc.positiveFeedbackCount, value.positiveFeedbackCount ?? 0),
    userGoalShiftCount: sumSafeCounts(acc.userGoalShiftCount, value.userGoalShiftCount ?? 0),
    hardRuleTextHitCount: sumSafeCounts(acc.hardRuleTextHitCount, value.hardRuleTextHitCount),
    assistantDeliverySignalCount: sumSafeCounts(acc.assistantDeliverySignalCount, value.assistantDeliverySignalCount ?? 0),
    deliverableArtifactSignalCount: sumSafeCounts(acc.deliverableArtifactSignalCount, value.deliverableArtifactSignalCount ?? 0),
    routerDownstreamCompleted: sumSafeCounts(acc.routerDownstreamCompleted, value.routerDownstreamCompleted ?? 0),
    routerDownstreamFailed: sumSafeCounts(acc.routerDownstreamFailed, value.routerDownstreamFailed ?? 0),
    selfCorrectionCount: sumSafeCounts(acc.selfCorrectionCount, value.selfCorrectionCount ?? 0),
    repeatedExecutionCount: sumSafeCounts(acc.repeatedExecutionCount, value.repeatedExecutionCount ?? 0),
    toolCallCount: sumSafeCounts(acc.toolCallCount, value.toolCallCount),
    toolFailureCount: sumSafeCounts(acc.toolFailureCount, value.toolFailureCount),
    toolCancelledCount: sumSafeCounts(acc.toolCancelledCount ?? 0, value.toolCancelledCount ?? 0),
    toolUnknownCount: sumSafeCounts(acc.toolUnknownCount ?? 0, value.toolUnknownCount ?? 0),
    highObservationCount: sumSafeCounts(acc.highObservationCount, value.highObservationCount),
    mediumObservationCount: sumSafeCounts(acc.mediumObservationCount, value.mediumObservationCount),
    hedgingCount: sumSafeCounts(acc.hedgingCount, value.hedgingCount),
    explicitMarkerCount: sumSafeCounts(acc.explicitMarkerCount, value.explicitMarkerCount),
  }), { ...ZERO_INDICATORS });
}

export function uniqueEvidenceRefs(refs: ExperienceEvidenceRef[]): ExperienceEvidenceRef[] {
  const byId = new Map<string, ExperienceEvidenceRef>();
  for (const ref of refs) {
    byId.set(ref.id, ref);
  }
  return Array.from(byId.values());
}
