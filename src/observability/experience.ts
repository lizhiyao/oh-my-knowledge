import type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCautionCode,
  ExperienceAssistiveInferenceCode,
  ExperienceAssistiveInferenceConfidence,
  ExperienceChecklistContribution,
  ExperienceChecklistItem,
  ExperienceChecklistItemStatus,
  ExperienceEpisode,
  ExperienceEpisodeArtifact,
  ExperienceEpisodeArtifactKind,
  ExperienceEpisodeBoundaryReason,
  ExperienceEpisodeOutcome,
  ExperienceEpisodeRole,
  ExperienceEvidenceChain,
  ExperienceEvidenceKind,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceFeedbackAttributionReason,
  ExperienceFeedbackAttributionRole,
  ExperienceFeedbackSignal,
  ExperienceFeedbackSignalType,
  ExperienceGoalEvidenceRef,
  ExperienceGoalSlice,
  ExperienceGoalSliceReasonCode,
  ExperienceInvocation,
  ExperienceMessageRange,
  ExperienceOrchestrationEdge,
  ExperienceOrchestrationEdgeKind,
  ExperienceOrchestrationEdgeStatus,
  ExperienceOutcomeClosure,
  ExperienceParentReason,
  ExperienceReviewBasisCode,
  ExperienceReviewIndicators,
  ExperienceReviewPriority,
  ExperienceReviewerReport,
  ExperienceReviewerReportFinding,
  ExperienceReviewerReportFindingLevel,
  ExperienceReviewerReportFindingSource,
  ExperienceReviewerReportScope,
  ExperienceReviewerReportStep,
  ExperienceReviewerReportStepStatus,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceRuntimeSkillType,
  ExperienceRuntimeSkillTypeSource,
  ExperienceSessionStory,
  ExperienceSessionStoryAnswer,
  ExperienceSessionStoryAnswerKey,
  ExperienceSessionStoryGoalSlice,
  ExperienceSessionStoryGraphEdge,
  ExperienceSessionStoryGraphNode,
  ExperienceSessionStoryNode,
  ExperienceSessionStoryNodeKind,
  ExperienceSessionStorySkillLink,
  ExperienceSessionStorySkillRole,
  ExperienceSessionStorySubagentDispatch,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceSkillSummary,
  ExperienceStoryContext,
  ExperienceTimelineBranch,
  ExperienceTimelineEvent,
  ExperienceTraceTimeline,
  ExperienceTimelineTree,
  ObservationExperienceReport,
} from './contracts/experience.js';
import type { ObservationInboxItem } from './contracts/inbox.js';
import type { ObservationMetricKey, ObservationReviewState } from './contracts/review.js';
import type { TraceSourceMetadata } from './contracts/trace.js';
import {
  buildExperienceProblemPatterns,
  mergeExperienceProblemPatterns,
} from './problem-patterns.js';
import { observationMetricAnnotationVerdict, observationReviewStateKey } from './review-state.js';
import {
  correlateTraceToolEvents,
  type TraceSession,
} from './trace-ir.js';
import {
  skillSegmentTimestampObserved,
  UNOBSERVED_TRACE_TIMESTAMP,
  type SkillSegment,
} from './trace-segmenter.js';
import { createTraceSessionIndex, traceSessionRefIdentity } from './trace-session-index.js';
import { reconstructExperienceTurns } from './turn-index.js';
import { hasAssistantDeliverableArtifactText, hasUserHardRuleText, isSyntheticUserMessageText, isToolResultFailureText, isUserInteractionMetricText, USER_INTERRUPTION_RE } from './text-signals.js';
import {
  compareTimelineEvents,
  hashParts,
  maxString,
  minString,
  snippet,
  unique,
  uniqueTimelineEvents,
} from './experience/primitives.js';
import {
  buildInvocationTimeline,
  buildSessionTimelineTree,
  experienceSessionGroupKey,
  groupSessionsByExperienceKey,
  hasAssistantTurnFailedText,
  isAssistantDeliveryEvent,
  segmentRecordBounds,
} from './experience/timeline.js';
import {
  OBSERVATION_EXPERIENCE_SCHEMA_VERSION,
  storyContextRefForSessionGroup,
  storyContextsFromSessions,
  TIMELINE_PREVIEW_EVENT_LIMIT,
  timelineRefForSessionGroup,
  traceRecordRanges,
  traceTimelinesFromSessions,
  flattenTimelineTree,
} from './experience/report-structure.js';
import {
  assistantFinalDeliveryEvents,
  assistantProgressUpdateEvents,
  basisCodesForIndicators,
  currentSkillRuntimeModel,
  enrichRouterDownstreamIndicators,
  evidenceRefFromTimeline,
  invocationTimestampObserved,
  priorityForReviewerFindings,
  priorityForScore,
  scoreForIndicators,
  sumIndicators,
  sumRecordCounts,
  sumTokenUsage,
  uniqueEvidenceRefs,
  userFacingClosureForSession,
} from './experience/report-derivations.js';
import {
  canonicalFeedbackCountsForSession,
  expectedToolCheckForSession,
  userFeedbackEvidenceRefs,
  type ExpectedToolCheck,
} from './experience/review-checklist.js';
import {
  buildSessionStory,
  deliveryStepText,
  executionOutcomeText,
  inferUserGoal,
  userFeedbackStepStatus,
  userFeedbackStepText,
} from './experience/session-story.js';
import { durationMsBetween } from '../shared/time.js';
import {
  incrementRecordCount,
  ownRecordValue,
  sumRecordCounts as sumSafeCounts,
} from '../shared/record-count.js';
import {
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  hasNegativeFeedbackSignal,
  hasPositiveFeedbackSignal,
  hasUserCorrectionSignal,
  hasUserGoalShiftSignal,
} from './feedback-matchers.js';

export {
  findNegativeFeedbackMatches,
  findPositiveFeedbackMatches,
  findUserCorrectionMatches,
  findUserGoalShiftMatches,
  hasNegativeFeedbackSignal,
  hasPositiveFeedbackSignal,
  hasUserCorrectionSignal,
  hasUserGoalShiftSignal,
} from './feedback-matchers.js';
export type { TextMatchRange } from './feedback-matchers.js';
export { projectTraceSessionTimeline } from './experience/timeline.js';
export { OBSERVATION_EXPERIENCE_SCHEMA_VERSION };
export {
  compactObservationExperienceReport,
  normalizeObservationExperienceReport,
} from './experience/report-codec.js';
export {
  aggregateExperienceChecklistItemStatus,
  foldExperienceChecklistItems,
  hasRecognizableUserGoalText,
  isExperienceTraceInProgress,
} from './experience/review-checklist.js';
export type {
  PersistedExperienceInvocation,
  PersistedExperienceReviewerReport,
  PersistedExperienceSession,
  PersistedExperienceSessionStory,
  PersistedObservationExperienceReport,
} from './experience/report-codec.js';

export type {
  ExperienceAssistiveInference,
  ExperienceAssistiveInferenceCautionCode,
  ExperienceAssistiveInferenceCode,
  ExperienceAssistiveInferenceConfidence,
  ExperienceChecklistContribution,
  ExperienceChecklistItem,
  ExperienceChecklistItemStatus,
  ExperienceEpisode,
  ExperienceEpisodeArtifact,
  ExperienceEpisodeArtifactKind,
  ExperienceEpisodeBoundaryReason,
  ExperienceEpisodeOutcome,
  ExperienceEpisodeRole,
  ExperienceEvidenceChain,
  ExperienceEvidenceKind,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceFeedbackAttributionReason,
  ExperienceFeedbackAttributionRole,
  ExperienceFeedbackSignal,
  ExperienceFeedbackSignalType,
  ExperienceGoalEvidenceRef,
  ExperienceGoalSlice,
  ExperienceGoalSliceReasonCode,
  ExperienceInvocation,
  ExperienceMessageRange,
  ExperienceOrchestrationEdge,
  ExperienceOrchestrationEdgeKind,
  ExperienceOrchestrationEdgeStatus,
  ExperienceOutcomeClosure,
  ExperienceParentReason,
  ExperienceReviewBasisCode,
  ExperienceReviewIndicators,
  ExperienceReviewPriority,
  ExperienceReviewerReport,
  ExperienceReviewerReportFinding,
  ExperienceReviewerReportFindingLevel,
  ExperienceReviewerReportFindingSource,
  ExperienceReviewerReportScope,
  ExperienceReviewerReportStep,
  ExperienceReviewerReportStepStatus,
  ExperienceRuleFinding,
  ExperienceRuleFindingCode,
  ExperienceRuleFindingLevel,
  ExperienceRuntimeSkillType,
  ExperienceRuntimeSkillTypeSource,
  ExperienceSessionStory,
  ExperienceSessionStoryAnswer,
  ExperienceSessionStoryAnswerKey,
  ExperienceSessionStoryGoalSlice,
  ExperienceSessionStoryGraphEdge,
  ExperienceSessionStoryGraphNode,
  ExperienceSessionStoryNode,
  ExperienceSessionStoryNodeKind,
  ExperienceSessionStorySkillLink,
  ExperienceSessionStorySkillRole,
  ExperienceSessionStorySubagentDispatch,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceSkillSummary,
  ExperienceStoryContext,
  ExperienceTimelineBranch,
  ExperienceTimelineEvent,
  ExperienceTraceTimeline,
  ExperienceTimelineTree,
  ObservationExperienceReport,
  ObservationReviewState,
};

interface BuildExperienceInput {
  sessions: TraceSession[];
  segments: SkillSegment[];
  items: ObservationInboxItem[];
  generatedAt: string;
  reviewState?: ObservationReviewState;
}

export function buildObservationExperienceReport(input: BuildExperienceInput): ObservationExperienceReport {
  const traceSessions = input.sessions.map((session) => ({
    ...session,
    events: correlateTraceToolEvents(session.events),
  }));
  const sessionIndex = createTraceSessionIndex(traceSessions);
  const sessionGroupsByKey = groupSessionsByExperienceKey(traceSessions);
  const goalSlices: ExperienceGoalSlice[] = [];
  const invocations: ExperienceInvocation[] = [];

  for (const segment of input.segments) {
    if (segment.skillName === 'general') continue;
    const session = sessionIndex.resolve(segment);
    const sourceTrace = segment.sourceTrace ?? session?.sourcePath ?? '';
    const sessionGroupKey = session ? experienceSessionGroupKey(session) : `trace:${sourceTrace || segment.sessionId}`;
    const relatedItems = relatedObservationItems(segment, input.items);
    const bounds = session ? segmentRecordBounds(session, segment) : { start: 0, end: 0 };
    const timeline = session ? buildInvocationTimeline(session, bounds.start, bounds.end, segment) : [];
    const metricTimeline = metricTimelineForSegment(timeline, segment);
    const metricScopeId = hashParts('session', segment.skillName, sessionGroupKey);
    const userRefs = timeline.filter((event) => event.kind === 'user_message');
    const indicators = indicatorsForSegment(segment, relatedItems, metricTimeline, metricScopeId, input.reviewState);
    const observationRefs = relatedItems.map(observationEvidenceRef);
    const evidenceChain = evidenceChainForTimeline(metricTimeline, observationRefs);
    const ruleFindings = ruleFindingsForEvidence(indicators, metricTimeline, observationRefs, evidenceChain, metricScopeId, input.reviewState);
    const assistiveInference = assistiveInferenceForEvidence(indicators, evidenceChain, ruleFindings);
    const problemPatterns = buildExperienceProblemPatterns({
      skillName: segment.skillName,
      sessionId: sessionGroupKey,
      timeline: metricTimeline,
      metricScopeId,
      reviewState: input.reviewState,
    });
    const hasGoalShift = userRefs.some((ref) => hasUserGoalShiftSignal(ref.snippet ?? ''));
    // traceId 是物理证据流身份。sourcePath 不是身份:一个 Markdown 文件可包含多个
    // session，且不同 block 可能复用同一来源 sessionId。
    const evidenceStreamId = traceSessionRefIdentity(segment);
    const traceId = segment.traceId ?? session?.traceId ?? evidenceStreamId;
    const goalSliceId = hashParts('goal', evidenceStreamId, segment.skillName, String(segment.segmentIndex));
    const invocationId = hashParts('invocation', evidenceStreamId, segment.skillName, String(segment.segmentIndex));

    goalSlices.push({
      id: goalSliceId,
      skillName: segment.skillName,
      sessionId: segment.sessionId,
      traceId,
      sourceTrace,
      cwd: segment.cwd,
      startTimestamp: segment.startTimestamp,
      endTimestamp: segment.endTimestamp,
      timestampObserved: skillSegmentTimestampObserved(segment),
      sliceReasonCode: hasGoalShift ? 'explicit_user_goal_shift' : 'skill_segment_boundary',
      sliceConfidence: hasGoalShift ? 'medium' : 'high',
      inferredUserGoal: inferUserGoal(userRefs),
      userMessageRefs: userRefs.slice(0, 8).map(evidenceRefFromTimeline),
    });

    invocations.push({
      id: invocationId,
      skillName: segment.skillName,
      sessionId: segment.sessionId,
      sessionGroupKey,
      traceId,
      sourceTrace,
      sourceKind: segment.sourceKind ?? session?.sourceKind ?? 'unknown',
      entrypoint: session?.entrypoint,
      sourceMetadata: segment.sourceMetadata ?? session?.sourceMetadata,
      cwd: segment.cwd,
      segmentIndex: segment.segmentIndex,
      goalSliceId,
      startTimestamp: segment.startTimestamp,
      endTimestamp: segment.endTimestamp,
      timestampObserved: skillSegmentTimestampObserved(segment),
      attribution: {
        source: segment.attribution?.source ?? 'unknown',
        confidence: segment.attribution?.confidence ?? 0.3,
        rawSkillRef: segment.attribution?.rawSkillRef,
        pluginName: segment.attribution?.pluginName,
        commandName: segment.attribution?.commandName,
      },
      metrics: segment.metrics,
      toolCounts: countTools(segment),
      indicators,
      evidenceChain,
      ruleFindings,
      assistiveInference,
      problemPatterns,
      relatedObservationIds: relatedItems.map((item) => item.id),
      evidenceRefs: [
        ...observationRefs,
        ...userRefs.slice(0, 5).map(evidenceRefFromTimeline),
      ],
      timelineRef: timelineRefForSessionGroup(sessionGroupKey),
      timelineEventIds: timeline.map((event) => event.id),
      timeline,
    });
  }

  const sessions = summarizeExperienceSessions(invocations, sessionGroupsByKey, input.generatedAt, input.reviewState);
  const skills = summarizeExperienceSkills(sessions, invocations);
  const traceTimelines = traceTimelinesFromSessions(sessions, invocations);
  const storyContexts = storyContextsFromSessions(sessions, invocations);

  return {
    kind: 'observe-experience',
    schemaVersion: OBSERVATION_EXPERIENCE_SCHEMA_VERSION,
    scope: 'evidence-only',
    generatedAt: input.generatedAt,
    meta: {
      sessionCount: sessions.length,
      skillCount: skills.length,
      invocationCount: invocations.length,
      goalSliceCount: goalSlices.length,
      noteCodes: ['no_llm_judge', 'no_auto_verdict', 'default_goal_slice_is_allowed', 'deterministic_assistive_inference'],
    },
    goalSlices,
    traceTimelines,
    storyContexts,
    invocations,
    sessions,
    skills,
  };
}

function sessionTimestampedInvocationCount(session: ExperienceSessionSummary): number {
  return session.timestampedInvocationCount
    ?? (session.startTimestamp === UNOBSERVED_TRACE_TIMESTAMP
      ? 0
      : session.invocationIds.length);
}

function relatedObservationItems(segment: SkillSegment, items: ObservationInboxItem[]): ObservationInboxItem[] {
  return items.filter((item) =>
    item.skillName === segment.skillName
    && (
      item.traceId && segment.traceId
        ? item.traceId === segment.traceId
        : true
    )
    // main/subagent 可以共享逻辑 sessionId，且调用同一个 skill。新数据都有
    // sourceTrace，必须严格按物理 trace 归因；空字符串仅用于兼容旧聚合数据。
    && (!item.sourceTrace || !segment.sourceTrace || item.sourceTrace === segment.sourceTrace)
    && (item.sessionId === segment.sessionId || item.recentSessionIds.includes(segment.sessionId))
    && timestampsOverlap(item.firstSeen, item.lastSeen, segment.startTimestamp, segment.endTimestamp));
}

function metricTimelineForSegment(
  timeline: ExperienceTimelineEvent[],
  segment: SkillSegment,
): ExperienceTimelineEvent[] {
  const callInstanceIds = new Set(
    segment.toolCalls.flatMap((call) => call.callInstanceId ? [call.callInstanceId] : []),
  );
  const legacyToolUseIds = new Set(
    segment.toolCalls.flatMap((call) =>
      !call.callInstanceId && call.toolUseId ? [call.toolUseId] : []
    ),
  );
  return timeline.filter((event) =>
    (event.kind !== 'tool_use' && event.kind !== 'tool_result')
    || (
      event.callInstanceId
        ? callInstanceIds.has(event.callInstanceId)
        : Boolean(event.toolUseId) && legacyToolUseIds.has(event.toolUseId!)
    ));
}

function timestampsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return true;
  return aStart <= bEnd && bStart <= aEnd;
}

function isAssistantDeliverableArtifactEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return hasAssistantDeliverableArtifactText(text);
}

function hasSelfCorrectionSignal(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return /刚才.*(?:不对|错了|有误)|发现.*(?:不对|错了|问题|遗漏)|重新(?:检查|分析|执行|生成|整理|补(?:充)?(?:结论|答案|回答))|改用|换成|修正|我再(?:检查|重新|看)|跑偏|偏(?:题|了|向)|没(?:有)?(?:完整|完全)?(?:回答|覆盖)|漏(?:了|掉)|不完整|我刚追问了一版|按原问题(?:重新)?(?:补|回|答)|\b(?:recheck|retry|rerun|mistake|wrong)\b/i.test(text);
}

function hasRepeatedExecutionSignal(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message' && event.kind !== 'tool_use') return false;
  const text = `${event.label ?? ''} ${event.toolName ?? ''} ${event.fullText ?? event.snippet ?? ''}`;
  return /重复(?:执行|尝试|读取|搜索|调用)|再次(?:执行|读取|搜索|调用)|重新(?:执行|读取|搜索|调用|跑|运行)|再(?:执行|读取|搜索|调用|跑)一遍|重试|\b(?:retry|rerun)\b/i.test(text);
}

function observationEvidenceRef(item: ObservationInboxItem): ExperienceEvidenceRef {
  return {
    id: hashParts('observation', item.id),
    kind: 'observation',
    traceId: item.traceId ?? item.evidence.traceId,
    sourceTrace: item.sourceTrace,
    sessionId: item.sessionId,
    messageIndex: item.evidence.messageIndex,
    logicalMessageIndex: item.evidence.messageIndex,
    sourceLineIndex: item.evidence.messageIndex,
    messageUuid: item.evidence.messageUuid,
    callInstanceId: item.evidence.callInstanceId,
    toolUseId: item.evidence.toolUseId,
    timestamp: item.evidence.segmentTimestamp,
    role: 'other',
    label: `${item.signalType}/${item.signalSubtype}`,
    snippet: snippet(
      item.evidence.userFeedbackSnippet
      || item.evidence.submittedEvidenceSnippet
      || item.evidence.query
      || item.evidence.path
      || item.evidence.assistantSnippet
      || item.evidence.outputSnippet
      || item.evidence.markerToken,
      700,
    ),
  };
}

function evidenceChainForTimeline(
  timeline: ExperienceTimelineEvent[],
  observationRefs: ExperienceEvidenceRef[],
): ExperienceEvidenceChain {
  const events = uniqueTimelineEvents(timeline).sort(compareTimelineEvents);
  const userEvents = events.filter((event) => event.kind === 'user_message' && !isSyntheticUserMessageText(event.snippet ?? ''));
  const runtimeEvents = events.filter((event) => event.kind === 'runtime_context');
  const skillEvents = events.filter((event) => event.kind === 'skill_context');
  const assistantEvents = events.filter((event) => event.kind === 'assistant_message');
  const toolUseEvents = events.filter((event) => event.kind === 'tool_use');
  const toolResultEvents = events.filter((event) => event.kind === 'tool_result');
  const toolFailureEvents = toolResultEvents.filter(isToolFailureEvent);
  return {
    userMessageCount: userEvents.length,
    runtimeContextCount: runtimeEvents.length,
    skillContextCount: skillEvents.length,
    assistantMessageCount: assistantEvents.length,
    toolUseCount: toolUseEvents.length,
    toolResultCount: toolResultEvents.length,
    toolFailureResultCount: toolFailureEvents.length,
    observationCount: observationRefs.length,
    firstUserMessage: userEvents[0] ? evidenceRefFromTimeline(userEvents[0]) : undefined,
    firstRuntimeContext: runtimeEvents[0] ? evidenceRefFromTimeline(runtimeEvents[0]) : undefined,
    firstSkillContext: skillEvents[0] ? evidenceRefFromTimeline(skillEvents[0]) : undefined,
    firstToolUse: toolUseEvents[0] ? evidenceRefFromTimeline(toolUseEvents[0]) : undefined,
    firstToolFailure: toolFailureEvents[0] ? evidenceRefFromTimeline(toolFailureEvents[0]) : undefined,
    lastAssistantMessage: assistantEvents.at(-1) ? evidenceRefFromTimeline(assistantEvents.at(-1) as ExperienceTimelineEvent) : undefined,
  };
}

function ruleFindingsForEvidence(
  indicators: ExperienceReviewIndicators,
  timeline: ExperienceTimelineEvent[],
  observationRefs: ExperienceEvidenceRef[],
  evidenceChain: ExperienceEvidenceChain,
  metricScopeId: string,
  reviewState?: ObservationReviewState,
): ExperienceRuleFinding[] {
  const events = uniqueTimelineEvents(timeline);
  const userEvents = events.filter((event) => event.kind === 'user_message');
  const metricUserEvents = userEvents.filter((event) => isUserInteractionMetricText(event.snippet ?? ''));
  const refs = (matches: ExperienceTimelineEvent[]): ExperienceEvidenceRef[] =>
    matches.slice(0, 5).map(evidenceRefFromTimeline);
  const findings: ExperienceRuleFinding[] = [];
  const push = (
    code: ExperienceRuleFindingCode,
    level: ExperienceRuleFindingLevel,
    count: number,
    evidenceRefs: ExperienceEvidenceRef[] = [],
  ): void => {
    if (count <= 0) return;
    findings.push({ code, level, count, evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 5) });
  };

  push('high_observation_seen', 'attention', indicators.highObservationCount, observationRefs);
  push('user_correction_seen', 'attention', indicators.userCorrectionCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'user_correction', hasUserCorrectionSignal(event.snippet ?? ''), reviewState, metricScopeId))));
  push('user_interruption_seen', 'attention', indicators.userInterruptionCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'user_interruption', USER_INTERRUPTION_RE.test(event.snippet ?? ''), reviewState, metricScopeId))));
  push('session_interrupted_seen', 'attention', indicators.sessionInterruptedCount, refs(sessionInterruptedEvents(events)));
  push('negative_feedback_seen', 'attention', indicators.negativeFeedbackCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'negative_feedback', hasNegativeFeedbackSignal(event.snippet ?? ''), reviewState))));
  push('tool_failure_seen', 'sample', indicators.toolFailureCount, refs(events.filter(isToolFailureEvent)));
  push('medium_observation_seen', 'sample', indicators.mediumObservationCount, observationRefs);
  push('hedging_seen', 'sample', indicators.hedgingCount, observationRefs);
  push('explicit_marker_seen', 'sample', indicators.explicitMarkerCount, observationRefs);
  push('hard_rule_seen', 'sample', indicators.hardRuleTextHitCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'hard_rule', hasUserHardRuleText(event.snippet ?? ''), reviewState, metricScopeId))));
  push('positive_feedback_seen', 'normal', indicators.positiveFeedbackCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'positive_feedback', hasPositiveFeedbackSignal(event.snippet ?? ''), reviewState))));
  push('user_goal_shift_seen', 'normal', indicators.userGoalShiftCount, refs(metricUserEvents.filter((event) => metricIsActive(event, 'user_goal_shift', hasUserGoalShiftSignal(event.snippet ?? ''), reviewState, metricScopeId))));
  push('runtime_context_excluded', 'normal', evidenceChain.runtimeContextCount, evidenceChain.firstRuntimeContext ? [evidenceChain.firstRuntimeContext] : []);
  push('skill_context_excluded', 'normal', evidenceChain.skillContextCount, evidenceChain.firstSkillContext ? [evidenceChain.firstSkillContext] : []);

  if (findings.filter((finding) => finding.level !== 'normal').length === 0) {
    findings.push({ code: 'no_priority_signal', level: 'normal', count: 1, evidenceRefs: [] });
  }
  return findings;
}

function assistiveInferenceForEvidence(
  indicators: ExperienceReviewIndicators,
  evidenceChain: ExperienceEvidenceChain,
  ruleFindings: ExperienceRuleFinding[],
): ExperienceAssistiveInference {
  const attentionFindings = ruleFindings.filter((finding) => finding.level === 'attention');
  const sampleFindings = ruleFindings.filter((finding) => finding.level === 'sample');
  const normalFindings = ruleFindings.filter((finding) => finding.level === 'normal');
  const basisRuleCodes = unique([
    ...attentionFindings.map((finding) => finding.code),
    ...sampleFindings.map((finding) => finding.code),
    ...normalFindings
      .filter((finding) => finding.code === 'positive_feedback_seen' || finding.code === 'hard_rule_seen' || finding.code === 'user_goal_shift_seen' || finding.code === 'no_priority_signal')
      .map((finding) => finding.code),
  ]);
  const cautionCodes: ExperienceAssistiveInferenceCautionCode[] = ['no_llm_judge', 'rule_only'];
  if (evidenceChain.runtimeContextCount > 0) cautionCodes.push('runtime_context_excluded');
  if (evidenceChain.skillContextCount > 0) cautionCodes.push('skill_context_excluded');
  if (evidenceChain.userMessageCount === 0) cautionCodes.push('no_human_user_message');
  if (evidenceChain.toolUseCount + evidenceChain.toolResultCount + evidenceChain.assistantMessageCount > 24) cautionCodes.push('limited_timeline_window');

  let code: ExperienceAssistiveInferenceCode;
  if (attentionFindings.length > 0) {
    code = 'review_recommended';
  } else if (sampleFindings.length > 0) {
    code = 'sample_recommended';
  } else if (indicators.positiveFeedbackCount > 0) {
    code = 'positive_signal_observed';
  } else if (indicators.userGoalShiftCount > 0) {
    code = 'user_switched_topic_neutral';
  } else if (evidenceChain.userMessageCount === 0 && evidenceChain.toolUseCount === 0 && evidenceChain.observationCount === 0) {
    code = 'insufficient_human_context';
  } else if (evidenceChain.userMessageCount === 0 && indicators.hardRuleTextHitCount === 0) {
    code = 'insufficient_human_context';
  } else {
    code = 'no_obvious_issue_from_rules';
  }

  const confidence: ExperienceAssistiveInferenceConfidence =
    attentionFindings.length > 0 || indicators.positiveFeedbackCount > 0
      ? 'high'
      : sampleFindings.length > 0 || indicators.userGoalShiftCount > 0 || evidenceChain.userMessageCount > 0 || evidenceChain.toolUseCount > 0
        ? 'medium'
        : 'low';
  const evidenceRefs = uniqueEvidenceRefs([
    ...attentionFindings.flatMap((finding) => finding.evidenceRefs),
    ...sampleFindings.flatMap((finding) => finding.evidenceRefs),
    ...(evidenceChain.firstUserMessage ? [evidenceChain.firstUserMessage] : []),
    ...(evidenceChain.firstToolUse ? [evidenceChain.firstToolUse] : []),
    ...(evidenceChain.firstToolFailure ? [evidenceChain.firstToolFailure] : []),
  ]).slice(0, 8);

  return {
    mode: 'deterministic_rules_only',
    code,
    confidence,
    basisRuleCodes,
    cautionCodes: unique(cautionCodes),
    evidenceRefs,
  };
}

function indicatorsForSegment(
  segment: SkillSegment,
  relatedItems: ObservationInboxItem[],
  timeline: ExperienceTimelineEvent[],
  metricScopeId: string,
  reviewState?: ObservationReviewState,
): ExperienceReviewIndicators {
  const userRefs = timeline.filter((event) => event.kind === 'user_message');
  const humanUserRefs = userRefs.filter((ref) => Boolean(ref.snippet) && !isSyntheticUserMessageText(ref.snippet ?? ''));
  const interactionUserRefs = humanUserRefs.filter((ref) => isUserInteractionMetricText(ref.snippet ?? ''));
  return {
    userMessageCount: humanUserRefs.length,
    userFollowUpCount: interactionUserRefs.reduce((sum, ref, index) => sum + (metricIsActive(ref, 'user_follow_up', index > 0 && !hasUserGoalShiftSignal(ref.snippet ?? ''), reviewState, metricScopeId) ? 1 : 0), 0),
    userCorrectionCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'user_correction', findUserCorrectionMatches(ref.snippet ?? '').length, reviewState, metricScopeId), 0),
    userInterruptionCount: interactionUserRefs.reduce((sum, ref) => sum + (metricIsActive(ref, 'user_interruption', USER_INTERRUPTION_RE.test(ref.snippet ?? ''), reviewState, metricScopeId) ? 1 : 0), 0),
    sessionInterruptedCount: sessionInterruptedEvents(timeline).length,
    negativeFeedbackCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'negative_feedback', findNegativeFeedbackMatches(ref.snippet ?? '').length, reviewState), 0),
    positiveFeedbackCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'positive_feedback', findPositiveFeedbackMatches(ref.snippet ?? '').length, reviewState), 0),
    userGoalShiftCount: interactionUserRefs.reduce((sum, ref) => sum + metricCount(ref, 'user_goal_shift', findUserGoalShiftMatches(ref.snippet ?? '').length, reviewState, metricScopeId), 0),
    hardRuleTextHitCount: interactionUserRefs.reduce((sum, ref) => sum + (metricIsActive(ref, 'hard_rule', hasUserHardRuleText(ref.snippet ?? ''), reviewState, metricScopeId) ? 1 : 0), 0),
    assistantDeliverySignalCount: timeline.filter(isAssistantDeliveryEvent).length,
    deliverableArtifactSignalCount: timeline.reduce((sum, ref) => sum + (metricIsActive(ref, 'deliverable_artifact', isAssistantDeliverableArtifactEvent(ref), reviewState) ? 1 : 0), 0),
    routerDownstreamCompleted: 0,
    routerDownstreamFailed: 0,
    selfCorrectionCount: timeline.reduce((sum, ref) => sum + (metricIsActive(ref, 'self_correction', hasSelfCorrectionSignal(ref), reviewState) ? 1 : 0), 0),
    repeatedExecutionCount: timeline.reduce((sum, ref) => sum + (metricIsActive(ref, 'repeated_execution', hasRepeatedExecutionSignal(ref), reviewState) ? 1 : 0), 0),
    toolCallCount: segment.metrics.numToolCalls,
    toolFailureCount: Math.max(segment.metrics.numToolFailures, timeline.filter(isToolFailureEvent).length),
    toolCancelledCount: segment.metrics.numToolCancelled,
    toolUnknownCount: segment.metrics.numToolUnknown,
    highObservationCount: relatedItems.filter((item) => item.severity === 'high').length,
    mediumObservationCount: relatedItems.filter((item) => item.severity === 'medium').length,
    hedgingCount: sumSafeCounts(
      ...relatedItems
        .filter((item) => item.signalType === 'hedging')
        .map((item) => item.occurrences),
    ),
    explicitMarkerCount: sumSafeCounts(
      ...relatedItems
        .filter((item) => item.signalType === 'explicit_marker')
        .map((item) => item.occurrences),
    ),
  };
}

function isToolFailureEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'tool_result') return false;
  if (event.toolStatus !== undefined) return event.toolStatus === 'failure';
  return event.isError === true || isToolResultFailureText(event.fullText ?? event.snippet ?? '');
}

function isSessionInterruptedType(type: string): boolean {
  return /^turn[._-](?:aborted|interrupted)$/i.test(type);
}

function sessionInterruptedEvents(timeline: ExperienceTimelineEvent[]): ExperienceTimelineEvent[] {
  const events = uniqueTimelineEvents(timeline).sort(compareTimelineEvents);
  const interrupted: ExperienceTimelineEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const text = `${event.label ?? ''}\n${event.snippet ?? ''}\n${event.fullText ?? ''}`;
    if (isSessionInterruptedType(event.label ?? '') || hasAssistantTurnFailedText(text)) {
      interrupted.push(event);
      continue;
    }
    if (/^session[._-]ended$/i.test(event.label ?? '')) {
      const next = events.slice(index + 1).find((candidate) => /^session[._-]started$/i.test(candidate.label ?? ''));
      if (next) interrupted.push(event);
    }
  }
  return uniqueTimelineEvents(interrupted);
}

function metricIsActive(
  ref: ExperienceTimelineEvent,
  metricKey: ObservationMetricKey,
  ruleDetected: boolean,
  reviewState?: ObservationReviewState,
  metricScopeId?: string,
): boolean {
  const verdict = observationMetricAnnotationVerdict(reviewState, { ...ref, metricScopeId }, metricKey);
  if (verdict === 'confirmed') return true;
  if (verdict === 'rejected') return false;
  return ruleDetected;
}

function metricCount(
  ref: ExperienceTimelineEvent,
  metricKey: ObservationMetricKey,
  ruleCount: number,
  reviewState?: ObservationReviewState,
  metricScopeId?: string,
): number {
  const verdict = observationMetricAnnotationVerdict(reviewState, { ...ref, metricScopeId }, metricKey);
  if (verdict === 'confirmed') return Math.max(1, ruleCount);
  if (verdict === 'rejected') return 0;
  return ruleCount;
}

function summarizeExperienceSessions(
  invocations: ExperienceInvocation[],
  sessionGroupsByKey: Map<string, TraceSession[]>,
  generatedAt: string,
  reviewState?: ObservationReviewState,
): ExperienceSessionSummary[] {
  const byKey = new Map<string, ExperienceInvocation[]>();
  const canonicalEpisodesBySessionGroup = new Map<string, ExperienceEpisode[]>();
  const timelineBySessionGroup = new Map<string, {
    tree?: ExperienceTimelineTree;
    flattened: ExperienceTimelineEvent[];
  }>();
  for (const invocation of invocations) {
    const key = `${invocation.skillName}\u0000${invocation.sessionGroupKey}`;
    const group = byKey.get(key) ?? [];
    group.push(invocation);
    byKey.set(key, group);
  }

  return Array.from(byKey.values()).map((group): ExperienceSessionSummary => {
    const first = group[0];
    const indicators = sumIndicators(group.map((invocation) => invocation.indicators));
    const relatedObservationIds = unique(group.flatMap((invocation) => invocation.relatedObservationIds));
    const reviewBasisCodes = basisCodesForIndicators(indicators);
    const reviewPriorityScore = scoreForIndicators(indicators);
    const timeline = uniqueTimelineEvents(group.flatMap((invocation) => invocation.timeline)).sort(compareTimelineEvents);
    const sessionGroup = sessionGroupsByKey.get(first.sessionGroupKey) ?? [];
    const sourceSessionStartTimestamp = minString(sessionGroup.map((session) => session.startTimestamp));
    const sourceSessionEndTimestamp = maxString(sessionGroup.map((session) => session.endTimestamp));
    const timestampedInvocations = group.filter(invocationTimestampObserved);
    const timestampedInvocationCount = timestampedInvocations.length;
    const invocationStartTimestamp = minString(
      timestampedInvocations.map((invocation) => invocation.startTimestamp),
    ) ?? first.startTimestamp;
    const invocationEndTimestamp = maxString(
      timestampedInvocations.map((invocation) => invocation.endTimestamp),
    ) ?? first.endTimestamp;
    let cachedTimeline = timelineBySessionGroup.get(first.sessionGroupKey);
    if (!cachedTimeline) {
      const tree = sessionGroup.length > 0
        ? buildSessionTimelineTree(first.sessionId, sessionGroup)
        : undefined;
      cachedTimeline = {
        tree,
        flattened: tree ? flattenTimelineTree(tree) : timeline,
      };
      timelineBySessionGroup.set(first.sessionGroupKey, cachedTimeline);
    }
    const timelineTree = cachedTimeline.tree;
    const fullSessionTimeline = cachedTimeline.flattened;
    const fullSessionEventCount = fullSessionTimeline.length;
    const previewEvents = timeline.slice(0, TIMELINE_PREVIEW_EVENT_LIMIT);
    const fullSessionPositionById = new Map(
      fullSessionTimeline.map((event, index) => [event.id, index]),
    );
    const previewPositions = previewEvents
      .map((event) => fullSessionPositionById.get(event.id))
      .filter((index): index is number => typeof index === 'number');
    const omittedBeforeCount = previewPositions.length > 0
      ? Math.min(...previewPositions)
      : 0;
    const omittedAfterCount = previewPositions.length > 0
      ? fullSessionTimeline.length - 1 - Math.max(...previewPositions)
      : 0;
    const observationRefs = uniqueEvidenceRefs(group.flatMap((invocation) => invocation.evidenceRefs.filter((ref) => ref.kind === 'observation')));
    const evidenceChain = evidenceChainForTimeline(timeline, observationRefs);
    const metricScopeId = hashParts('session', first.skillName, first.sessionGroupKey);
    const ruleFindings = ruleFindingsForEvidence(indicators, timeline, observationRefs, evidenceChain, metricScopeId);
    const assistiveInference = assistiveInferenceForEvidence(indicators, evidenceChain, ruleFindings);
    const problemPatterns = mergeExperienceProblemPatterns(group.flatMap((invocation) => invocation.problemPatterns));
    const sourceThreadId = sessionGroup.find((session) => session.role === 'main')?.rootRunId
      ?? sessionGroup[0]?.rootRunId
      ?? first.sessionId;
    const threadId = hashParts('thread', first.sessionGroupKey);
    const turns = reconstructExperienceTurns(fullSessionTimeline);
    const storyInvocations = invocations
      .filter((invocation) => invocation.sessionGroupKey === first.sessionGroupKey)
      .sort(compareStoryInvocations);
    const baseSession: Omit<ExperienceSessionSummary, 'sessionStory' | 'reviewerReport'> = {
      id: metricScopeId,
      skillName: first.skillName,
      threadId,
      sourceThreadId,
      sessionId: first.sessionId,
      sourceTrace: first.sourceTrace,
      sourceKind: first.sourceKind,
      entrypoint: first.entrypoint,
      sourceMetadata: mergeSourceMetadata(group.map((invocation) => invocation.sourceMetadata)),
      cwd: first.cwd,
      sourceSessionStartTimestamp,
      sourceSessionEndTimestamp,
      sourceSessionDurationMs: durationMsBetween(sourceSessionStartTimestamp, sourceSessionEndTimestamp),
      startTimestamp: invocationStartTimestamp,
      endTimestamp: invocationEndTimestamp,
      timestampedInvocationCount,
      timestampCoverage: group.length > 0 ? timestampedInvocationCount / group.length : 0,
      invocationIds: group.map((invocation) => invocation.id),
      goalSliceIds: unique(group.map((invocation) => invocation.goalSliceId)),
      reviewPriority: priorityForScore(reviewPriorityScore),
      reviewPriorityScore,
      reviewBasisCodes,
      indicators,
      evidenceChain,
      ruleFindings,
      assistiveInference,
      problemPatterns,
      relatedObservationIds,
      timelineRef: timelineRefForSessionGroup(first.sessionGroupKey),
      timelinePreviewEventIds: previewEvents.map((event) => event.id),
      attributedEventIds: timeline.map((event) => event.id),
      turns,
      timelinePreview: previewEvents,
      fullSessionTimeline,
      timelineTree,
      timelineScope: {
        mode: 'skill_segment_window',
        segmentEventCount: timeline.length,
        previewEventCount: previewEvents.length,
        fullSessionEventCount,
        segmentRecordRanges: traceRecordRanges(timeline),
        previewRecordRanges: traceRecordRanges(previewEvents),
        sessionRecordRanges: traceRecordRanges(fullSessionTimeline),
        truncated: timeline.length > previewEvents.length || omittedBeforeCount > 0 || omittedAfterCount > 0,
        omittedBeforeCount,
        omittedAfterCount,
      },
      attributionSources: unique(group.map((invocation) => invocation.attribution.source).filter(Boolean)).sort(),
      pluginNames: unique(group.map((invocation) => invocation.attribution.pluginName).filter((value): value is string => Boolean(value))).sort(),
      rawSkillRefs: unique(group.map((invocation) => invocation.attribution.rawSkillRef).filter((value): value is string => Boolean(value))).sort(),
      commandNames: unique(group.map((invocation) => invocation.attribution.commandName).filter((value): value is string => Boolean(value))).sort(),
    };
    let canonicalEpisodes = canonicalEpisodesBySessionGroup.get(first.sessionGroupKey);
    if (!canonicalEpisodes) {
      const canonicalSession = canonicalStorySession(baseSession, storyInvocations);
      canonicalEpisodes = buildSessionStory(
        canonicalSession,
        storyInvocations,
        undefined,
        reviewState,
      ).episodes ?? [];
      canonicalEpisodesBySessionGroup.set(first.sessionGroupKey, canonicalEpisodes);
    }
    const sessionStory = {
      ...buildSessionStory(
        baseSession,
        storyInvocations,
        canonicalEpisodes,
        reviewState,
      ),
      contextRef: storyContextRefForSessionGroup(first.sessionGroupKey),
    };
    const sessionWithStoryBase: ExperienceSessionSummary = {
      ...baseSession,
      sessionStory,
    };
    const enrichedIndicators = enrichRouterDownstreamIndicators(sessionWithStoryBase);
    const enrichedReviewPriorityScore = scoreForIndicators(enrichedIndicators);
    const sessionWithStory: ExperienceSessionSummary = {
      ...sessionWithStoryBase,
      indicators: enrichedIndicators,
      reviewPriority: priorityForScore(enrichedReviewPriorityScore),
      reviewPriorityScore: enrichedReviewPriorityScore,
      reviewBasisCodes: basisCodesForIndicators(enrichedIndicators),
    };
    const reviewerReport = buildReviewerReport(sessionWithStory, group, generatedAt, reviewState, storyInvocations, sessionStory);
    return {
      ...sessionWithStory,
      reviewPriority: priorityForReviewerFindings(sessionWithStory, reviewerReport.findings),
      reviewerReport,
    };
  }).sort((a, b) => {
    const priorityDiff = experiencePriorityRank(b.reviewPriority) - experiencePriorityRank(a.reviewPriority);
    if (priorityDiff !== 0) return priorityDiff;
    if (b.reviewPriorityScore !== a.reviewPriorityScore) return b.reviewPriorityScore - a.reviewPriorityScore;
    const timestampCoverageDiff =
      sessionTimestampedInvocationCount(b) - sessionTimestampedInvocationCount(a);
    if (timestampCoverageDiff !== 0) return timestampCoverageDiff;
    return b.endTimestamp.localeCompare(a.endTimestamp);
  });
}

function compareStoryInvocations(
  left: ExperienceInvocation,
  right: ExperienceInvocation,
): number {
  return left.startTimestamp.localeCompare(right.startTimestamp)
    || left.sourceTrace.localeCompare(right.sourceTrace)
    || left.segmentIndex - right.segmentIndex
    || left.skillName.localeCompare(right.skillName)
    || left.id.localeCompare(right.id);
}

function canonicalStorySession(
  base: Omit<ExperienceSessionSummary, 'sessionStory' | 'reviewerReport'>,
  invocations: ExperienceInvocation[],
): ExperienceSessionSummary {
  const first = invocations[0];
  const indicators = sumIndicators(invocations.map((invocation) => invocation.indicators));
  const relatedObservationIds = unique(
    invocations.flatMap((invocation) => invocation.relatedObservationIds),
  );
  const observationRefs = uniqueEvidenceRefs(
    invocations.flatMap((invocation) =>
      invocation.evidenceRefs.filter((ref) => ref.kind === 'observation')
    ),
  );
  const evidenceChain = evidenceChainForTimeline(base.fullSessionTimeline, observationRefs);
  const reviewPriorityScore = scoreForIndicators(indicators);
  const id = hashParts('session-story', first?.sessionGroupKey ?? base.sessionId);
  const timestampedInvocations = invocations.filter(invocationTimestampObserved);
  const ruleFindings = ruleFindingsForEvidence(
    indicators,
    base.fullSessionTimeline,
    observationRefs,
    evidenceChain,
    id,
  );
  return {
    ...base,
    id,
    skillName: first?.skillName ?? base.skillName,
    sourceTrace: base.fullSessionTimeline.find((event) =>
      event.traceRole === 'main' || event.traceRole === 'standalone'
    )?.sourceTrace ?? first?.sourceTrace ?? base.sourceTrace,
    sourceKind: first?.sourceKind ?? base.sourceKind,
    entrypoint: first?.entrypoint ?? base.entrypoint,
    sourceMetadata: mergeSourceMetadata(
      invocations.map((invocation) => invocation.sourceMetadata),
    ),
    cwd: first?.cwd ?? base.cwd,
    startTimestamp: minString(
      timestampedInvocations.map((invocation) => invocation.startTimestamp),
    ) ?? base.startTimestamp,
    endTimestamp: maxString(
      timestampedInvocations.map((invocation) => invocation.endTimestamp),
    ) ?? base.endTimestamp,
    timestampedInvocationCount: timestampedInvocations.length,
    timestampCoverage: invocations.length > 0
      ? timestampedInvocations.length / invocations.length
      : 0,
    invocationIds: invocations.map((invocation) => invocation.id),
    goalSliceIds: unique(invocations.map((invocation) => invocation.goalSliceId)),
    reviewPriority: priorityForScore(reviewPriorityScore),
    reviewPriorityScore,
    reviewBasisCodes: basisCodesForIndicators(indicators),
    indicators,
    evidenceChain,
    ruleFindings,
    assistiveInference: assistiveInferenceForEvidence(
      indicators,
      evidenceChain,
      ruleFindings,
    ),
    problemPatterns: mergeExperienceProblemPatterns(
      invocations.flatMap((invocation) => invocation.problemPatterns),
    ),
    relatedObservationIds,
    attributionSources: unique(
      invocations.map((invocation) => invocation.attribution.source).filter(Boolean),
    ).sort(),
    pluginNames: unique(
      invocations
        .map((invocation) => invocation.attribution.pluginName)
        .filter((value): value is string => Boolean(value)),
    ).sort(),
    rawSkillRefs: unique(
      invocations
        .map((invocation) => invocation.attribution.rawSkillRef)
        .filter((value): value is string => Boolean(value)),
    ).sort(),
    commandNames: unique(
      invocations
        .map((invocation) => invocation.attribution.commandName)
        .filter((value): value is string => Boolean(value)),
    ).sort(),
  };
}

function experiencePriorityRank(priority: ExperienceReviewPriority): number {
  if (priority === 'review_first') return 2;
  if (priority === 'sample_review') return 1;
  return 0;
}

const REVIEWER_REPORT_RULE_VERSION = 'reviewer-report.v1';

function buildReviewerReport(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  generatedAt: string,
  reviewState?: ObservationReviewState,
  storyInvocations: ExperienceInvocation[] = invocations,
  sessionStory: ExperienceSessionStory = buildSessionStory(session, storyInvocations),
): ExperienceReviewerReport {
  const indicators = session.indicators;
  const scopeReasons = reviewerScopeReasonCodes(session);
  const scopeKind: ExperienceReviewerReportScope = scopeReasons.length === 0 ? 'single_skill_single_goal' : 'degraded_complex';
  const findings = reviewerFindingsForSession(session, reviewState);
  const attentionCount = findings.filter((finding) => finding.level === 'attention').length;
  const possibleFalsePositiveCount = findings.filter((finding) => finding.level === 'possible_false_positive').length;
  const tokenUsage = sumTokenUsage(invocations);
  const title = reviewerTitle(session, attentionCount, possibleFalsePositiveCount);
  const expectedToolCheck = expectedToolCheckForSession(session);
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  const traceLinks = uniqueEvidenceRefs([
    ...(session.evidenceChain.firstUserMessage ? [session.evidenceChain.firstUserMessage] : []),
    ...(session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : []),
    ...(session.evidenceChain.firstToolFailure ? [session.evidenceChain.firstToolFailure] : []),
    ...(session.evidenceChain.lastAssistantMessage ? [session.evidenceChain.lastAssistantMessage] : []),
    ...findings.flatMap((finding) => finding.evidenceRefs),
  ]).slice(0, 10);

  return {
    schemaVersion: 1,
    mode: 'deterministic_session_story',
    generatedAt,
    title,
    summary: reviewerSummary(session, scopeKind, attentionCount, possibleFalsePositiveCount),
    scope: {
      kind: scopeKind,
      reasonCodes: scopeReasons,
    },
    chainSteps: [
      reviewerStep(1, '用户期待', userGoalStepText(session), session.evidenceChain.firstUserMessage ? 'ok' : 'unknown', session.evidenceChain.firstUserMessage ? [session.evidenceChain.firstUserMessage] : []),
      reviewerStep(2, '选择能力', skillSelectionStepText(session), 'ok', [session.evidenceChain.firstSkillContext, session.evidenceChain.firstToolUse].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
      reviewerStep(3, '执行流程', executionStepText(session, expectedToolCheck), executionStepStatus(session, expectedToolCheck), session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : []),
      reviewerStep(4, '结果 / 产物', deliveryStepText(session), userFacingClosureForSession(session).deliveryCount > 0 ? 'ok' : 'unknown', userFacingClosureForSession(session).evidenceRefs),
      reviewerStep(5, '用户反馈', userFeedbackStepText(session, reviewState), userFeedbackStepStatus(session, reviewState), userFeedbackEvidenceRefs(session)),
    ],
    findings,
      oneLookMetrics: {
      toolCallCount: indicators.toolCallCount,
      toolFailureCount: indicators.toolFailureCount,
      toolCancelledCount: indicators.toolCancelledCount ?? 0,
      toolUnknownCount: indicators.toolUnknownCount ?? 0,
      userMessageCount: indicators.userMessageCount,
      userFollowUpCount: feedbackCounts.userFollowUpCount,
      assistantDeliverySignalCount: indicators.assistantDeliverySignalCount,
      deliverableArtifactSignalCount: indicators.deliverableArtifactSignalCount,
      routerDownstreamCompleted: indicators.routerDownstreamCompleted,
      routerDownstreamFailed: indicators.routerDownstreamFailed,
      assistantProgressUpdateCount: assistantProgressUpdateEvents(session).length,
      selfCorrectionCount: indicators.selfCorrectionCount,
      repeatedExecutionCount: indicators.repeatedExecutionCount,
      finalDeliverySignalCount: assistantFinalDeliveryEvents(session).length,
      traceEventCount: session.fullSessionTimeline.length || session.timelinePreview.length,
      tokenUsage: {
        ...tokenUsage,
        attribution: 'skill_segment',
      },
    },
    sessionStory,
    authorSuggestions: reviewerAuthorSuggestions(session, findings),
    traceLinks,
  };
}

function reviewerScopeReasonCodes(session: ExperienceSessionSummary): string[] {
  const reasons: string[] = [];
  if (session.invocationIds.length !== 1) reasons.push('multiple_invocations');
  if (session.goalSliceIds.length !== 1) reasons.push('multiple_goal_slices');
  if ((session.timelineTree?.branches.length ?? 0) > 0) reasons.push('subagent_branches_present');
  if (session.pluginNames.length > 1 || session.commandNames.length > 1) reasons.push('multiple_skill_entrypoints');
  return reasons;
}

function reviewerStep(
  order: number,
  label: string,
  text: string,
  status: ExperienceReviewerReportStepStatus,
  evidenceRefs: ExperienceEvidenceRef[] = [],
): ExperienceReviewerReportStep {
  return {
    order,
    label,
    status,
    text,
    evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 4),
  };
}

function userGoalStepText(session: ExperienceSessionSummary): string {
  const goal = session.evidenceChain.firstUserMessage?.snippet;
  if (!goal) return '没有看到明确人工用户目标；当前只能按运行证据做常规复盘。';
  return `用户目标：${goal}`;
}

function skillSelectionStepText(session: ExperienceSessionSummary): string {
  const entrypoint = session.commandNames.length > 0 ? `，入口 ${session.commandNames.join('、')}` : session.entrypoint ? `，入口 ${session.entrypoint}` : '';
  return `本次使用的能力：${session.skillName}${entrypoint}。`;
}

function executionStepStatus(session: ExperienceSessionSummary, expectedToolCheck: ExpectedToolCheck): ExperienceReviewerReportStepStatus {
  if (session.indicators.toolFailureCount > 0 || expectedToolCheck.declared && expectedToolCheck.matchedTools.length === 0) return 'attention';
  if (
    (session.indicators.toolCancelledCount ?? 0) > 0
    || (session.indicators.toolUnknownCount ?? 0) > 0
  ) return 'unknown';
  if (session.indicators.toolCallCount > 0) return 'ok';
  return 'unknown';
}

function executionStepText(session: ExperienceSessionSummary, expectedToolCheck: ExpectedToolCheck = expectedToolCheckForSession(session)): string {
  const expected = expectedToolCheck.declared
    ? expectedToolCheck.matchedTools.length > 0
      ? `命中声明的核心工具：${expectedToolCheck.matchedTools.join('、')}。`
      : `但没有命中能力声明的核心工具：${expectedToolCheck.expectedTools.join('、')}。`
    : '';
  return `${executionOutcomeText(session.indicators)}${expected}`;
}

function reviewerFindingsForSession(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): ExperienceReviewerReportFinding[] {
  const findings: ExperienceReviewerReportFinding[] = [];
  const push = (
    level: ExperienceReviewerReportFindingLevel,
    title: string,
    body: string,
    ruleSource: string,
    evidenceRefs: ExperienceEvidenceRef[] = [],
  ): void => {
    const id = hashParts('reviewer-finding', session.id, ruleSource, title);
    const judgmentId = hashParts('reviewer-judgment', session.id, ruleSource, title, evidenceRefs.map((ref) => ref.id).join('|'));
    const reviewEntry = reviewState?.entries[observationReviewStateKey('reviewer_judgment', judgmentId)];
    findings.push({
      id,
      judgmentId,
      source: 'deterministic_rule',
      level,
      title,
      body,
      ruleSource,
      ruleVersion: REVIEWER_REPORT_RULE_VERSION,
      evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 5),
      reviewStateRef: {
        targetType: 'reviewer_judgment',
        targetId: judgmentId,
        ...(reviewEntry?.verdict ? { verdict: reviewEntry.verdict } : {}),
        ...(reviewEntry?.reason ? { reason: reviewEntry.reason } : {}),
        ...(reviewEntry?.note ? { note: reviewEntry.note } : {}),
        ...(reviewEntry?.reviewedAt ? { reviewedAt: reviewEntry.reviewedAt } : {}),
      },
    });
  };
  const findingRefs = (code: ExperienceRuleFindingCode): ExperienceEvidenceRef[] =>
    session.ruleFindings.filter((finding) => finding.code === code).flatMap((finding) => finding.evidenceRefs);
  const expectedToolCheck = expectedToolCheckForSession(session);

  if (session.indicators.toolFailureCount > 0) {
    push(
      'attention',
      `工具调用失败 ${session.indicators.toolFailureCount} 次`,
      '执行中遇到工具报错。看下失败的步骤是否在 SKILL.md 里写明了重试或回退方式。',
      'tool_error_recovery',
      findingRefs('tool_failure_seen'),
    );
  }
  const closure = userFacingClosureForSession(session);
  const runtime = currentSkillRuntimeModel(session);
  if (closure.deliveryCount === 0) {
    const isUpstreamOrchestration = Boolean(runtime && (runtime.skillType === 'router' || runtime.skillType === 'delegation' || runtime.hasDownstreamEdges || runtime.isDelegator));
    push(
      'attention',
      isUpstreamOrchestration ? '下游结果没有回传给用户' : '没看到给用户的最终答复',
      isUpstreamOrchestration
        ? '这个 skill 已经把任务派发到下游，但没有看到下游结果被清楚回传给用户。需要确认 child 是否完成、结果是否匹配原目标、是否主动通知用户。'
        : 'assistant 没说「完成 / 结果如下」这种收尾，可能任务还没跑完，或收尾文案不够清楚让用户知道事情结束了。',
      isUpstreamOrchestration ? 'router_user_facing_closure_absent' : 'final_delivery_absent',
      closure.evidenceRefs.length > 0 ? closure.evidenceRefs : session.evidenceChain.lastAssistantMessage ? [session.evidenceChain.lastAssistantMessage] : [],
    );
  }
  if (session.indicators.sessionInterruptedCount > 0) {
    push(
      'attention',
      `会话异常断开 ${session.indicators.sessionInterruptedCount} 次`,
      '任务中途被异常中断或重启。如果是网络/超时，看是否要在 skill 里加重试；如果是程序原因，跟开发反馈。',
      'session_interrupted',
      findingRefs('session_interrupted_seen'),
    );
  }
  if (expectedToolCheck.declared && expectedToolCheck.matchedTools.length === 0) {
    push(
      'attention',
      '没用上 SKILL.md 声明的核心工具',
      `SKILL.md 里声明 ${expectedToolCheck.expectedTools.join('、')} 是核心工具，但这次没看到调用。要么 description 指引不够清楚，要么用户的诉求不属于这个 skill 的场景。`,
      'expected_tools_missed',
      session.evidenceChain.firstToolUse ? [session.evidenceChain.firstToolUse] : [],
    );
  }
  if (session.indicators.userCorrectionCount > 0) {
    push(
      'attention',
      `用户纠正 ${session.indicators.userCorrectionCount} 次`,
      '用户在过程中纠正了方向。看原文确认是 skill 理解偏差，还是 skill 不该处理这种诉求。',
      'user_correction',
      findingRefs('user_correction_seen'),
    );
  }
  if (session.indicators.userInterruptionCount > 0) {
    push(
      'attention',
      `用户手动叫停 ${session.indicators.userInterruptionCount} 次`,
      '用户主动喊停了执行。常见原因：跑偏 / 太慢 / 用错工具。看原文定位是哪一步触发的。',
      'user_interruption',
      findingRefs('user_interruption_seen'),
    );
  }
  if (session.indicators.negativeFeedbackCount > 0) {
    push(
      'attention',
      `用户说了 ${session.indicators.negativeFeedbackCount} 次不满意`,
      '用户出现了「不对 / 错了 / 不行」等负向表达。先看是 skill 给的结果不达预期，还是用户对方向本身有疑问。',
      'negative_feedback',
      findingRefs('negative_feedback_seen'),
    );
  }
  if (session.indicators.hardRuleTextHitCount > 0) {
    push(
      'note',
      `用户提了 ${session.indicators.hardRuleTextHitCount} 次硬性要求`,
      '用户在对话里强调了某些必须做/不能做的规则。如果同类要求反复出现，可以沉淀到 SKILL.md 的 hardRules。',
      'user_hard_rule',
      findingRefs('hard_rule_seen'),
    );
  }
  if (reviewerScopeReasonCodes(session).length > 0) {
    push(
      'note',
      '复杂链路降级展示',
      '本次不是严格的 1 次会话 × 1 个目标 × 1 个能力场景。当前先做通用展示，不强行拆分多能力、子任务或目标切换。',
      'complex_scope_degraded',
      [],
    );
  }
  if (findings.length === 0) {
    push(
      'note',
      '未命中优先问题信号',
      '没有看到需要优先关注的纠正、中断、负向反馈、工具失败或没收尾的信号。',
      'no_priority_signal',
      [],
    );
  }
  return findings;
}

function reviewerTitle(session: ExperienceSessionSummary, attentionCount: number, possibleFalsePositiveCount: number): string {
  const suffix = possibleFalsePositiveCount > 0 ? ` · ${possibleFalsePositiveCount} 项疑似误判` : '';
  if (attentionCount > 0) return `${session.skillName} · ${attentionCount} 项要看一眼${suffix}`;
  if (session.indicators.assistantDeliverySignalCount > 0) return `${session.skillName} · 看起来有结果 · 常规抽样${suffix}`;
  return `${session.skillName} · 常规抽样 · 未见高优先级信号${suffix}`;
}

function reviewerSummary(
  session: ExperienceSessionSummary,
  scopeKind: ExperienceReviewerReportScope,
  attentionCount: number,
  possibleFalsePositiveCount: number,
): string {
  const scopeText = scopeKind === 'single_skill_single_goal'
    ? '本次属于单个能力 / 单个目标报告范围。'
    : '本次是复杂链路，当前先做降级展示，不强行拆分语义分支。';
  const reviewText = attentionCount > 0
    ? `发现 ${attentionCount} 条事实层复核点。`
    : '没有发现优先级较高的事实层复核点。';
  const falsePositiveText = possibleFalsePositiveCount > 0 ? `另有 ${possibleFalsePositiveCount} 条疑似误判需要人工确认。` : '';
  return [scopeText, reviewText, falsePositiveText].filter(Boolean).join(' ');
}

function reviewerAuthorSuggestions(session: ExperienceSessionSummary, findings: ExperienceReviewerReportFinding[]): string[] {
  const suggestions = new Map<string, { text: string; severity: number }>();
  const pushSuggestion = (key: string, text: string, severity: number): void => {
    const existing = suggestions.get(key);
    if (!existing || severity > existing.severity) suggestions.set(key, { text, severity });
  };
  for (const answer of session.sessionStory?.answers ?? []) {
    for (const item of answer.checklistItems ?? []) {
      if (!item.suggestionKey) continue;
      const text = suggestionTextForChecklistItem(item.suggestionKey);
      if (!text) continue;
      pushSuggestion(item.suggestionKey, text, severityForChecklistStatus(item.status));
    }
  }
  if (findings.some((finding) => finding.ruleSource === 'router_user_facing_closure_absent')) {
    pushSuggestion('router_user_facing_closure_absent', '补充下游结果回传和异步闭环规范，避免路由能力只负责启动、不负责结果回收。', 4);
  } else if (findings.some((finding) => finding.ruleSource === 'final_delivery_absent')) {
    pushSuggestion('final_delivery_absent', '补充明确的产物交付表达或交付标记，避免过程进展被当成完成。', 4);
  }
  if (findings.some((finding) => finding.ruleSource === 'tool_error_recovery')) {
    pushSuggestion('tool_error_recovery', '复查失败工具调用前后的执行流程，必要时把稳定路径写入能力说明文档。', 4);
  }
  if (findings.some((finding) => finding.ruleSource === 'session_interrupted')) {
    pushSuggestion('session_interrupted', '复查会话异常中断前后的上下文，确认是否需要补充中断恢复或重跑策略。', 4);
  }
  if (findings.some((finding) => finding.ruleSource === 'expected_tools_missed')) {
    pushSuggestion('expected_tools_missed', '如果能力依赖核心工具，请在能力定义里维护 expected_tools，并确认运行链路实际命中这些工具。', 4);
  }
  if (session.indicators.hardRuleTextHitCount > 0) {
    pushSuggestion('user_hard_rule', '把反复出现的用户硬性要求沉淀为能力规则，并在后续观测中追踪是否减少纠偏。', 2);
  }
  if (session.indicators.userCorrectionCount > 0 || session.indicators.negativeFeedbackCount > 0) {
    pushSuggestion('user_negative_review', '优先打开原始片段，确认用户纠正/负向反馈发生在交付前还是交付后。', 4);
  }
  if (reviewerScopeReasonCodes(session).length > 0) {
    pushSuggestion('complex_scope_review', '复杂链路暂按降级报告处理；后续再拆多能力、子任务或目标切换。', 1);
  }
  if (suggestions.size === 0) pushSuggestion('routine_sample', '进入常规抽样池，保留 evidenceRef 以便人工抽查。', 0);
  return Array.from(suggestions.values())
    .sort((a, b) => b.severity - a.severity || a.text.localeCompare(b.text))
    .map((entry) => entry.text);
}

function severityForChecklistStatus(status: ExperienceChecklistItemStatus): number {
  if (status === 'degraded') return 5;
  if (status === 'failed') return 4;
  if (status === 'unknown') return 3;
  if (status === 'not_declared') return 2;
  if (status === 'passed') return 1;
  return 0;
}

function suggestionTextForChecklistItem(key: string): string | undefined {
  const suggestions: Record<string, string> = {
    final_delivery_absent: '在最后回复里加上「已完成 / 结果如下」之类的明确收尾，让用户知道任务跑完了。',
    router_user_facing_closure_absent: '在路由 / 调度能力里写清楚：下游完成后必须回收结果并同步给用户；如果未完成，要说明当前状态和下一步。',
    artifact_absent: '如果 skill 应该产出文档、demo、代码或报告，最终回复里要附上文件路径、链接或代码块。',
    goal_shift_review: '用户中途切了目标，后续追问不属于这个 skill。看下是否要在 description 里说清楚 skill 的边界。',
    user_negative_or_interrupted: '用户出现了不满 / 纠正 / 叫停。先看原文是哪一步触发的，再决定改 description、补标准流程还是补硬性规则。',
    workflow_not_declared: '在 SKILL.md 里补一个标准流程声明，把这个 skill 的执行步骤写清楚。否则报告只能猜流程是否完整。',
    workflow_execution_review: '声明了标准流程但执行证据不够。补一下每个步骤的输出形态，让运行时能验证是否真的跑过。',
    hardrule_not_declared: '在 SKILL.md 里补硬性规则声明，把那些「必须做 / 不能做」的约束写明。',
    hardrule_execution_review: '声明了硬性规则但执行证据不够。补一下每条规则的触发场景，让运行时能验证。',
    expected_tools_not_declared: '在 SKILL.md frontmatter 里声明 expected_tools。否则报告分不出「真用上了 skill 工具」还是「只是随便调了个工具」。',
    expected_tools_missed: '声明了核心工具但没用上。先确认 description 是否清楚指引到这些工具，或者用户的诉求不属于这个 skill。',
    negative_feedback_review: '打开用户负向反馈的原文，看问题出在理解目标、执行过程还是最后没收尾。',
    user_correction_review: '用户纠正了多次。把纠正内容沉淀到 SKILL.md 的标准流程或硬性规则，避免下次同类返工。',
    follow_up_review: '用户追问比较多。看是围绕产物继续推进（好事），还是因为没拿到结果而反复问（要改）。',
    user_interruption_review: '用户叫停了执行。看下断的那一步是不是 skill 没声明标准流程导致跑偏。',
    downstream_feedback_review: '这次任务的下游执行链路被用户追问、纠正或中断。路由 / 调度类 skill 需要把下游状态、结果回收和异常通知写清楚，避免只负责启动、不负责闭环。',
  };
  return suggestions[key];
}

function summarizeExperienceSkills(
  sessions: ExperienceSessionSummary[],
  invocations: ExperienceInvocation[],
): ExperienceSkillSummary[] {
  const bySkill = new Map<string, ExperienceSessionSummary[]>();
  for (const session of sessions) {
    const group = bySkill.get(session.skillName) ?? [];
    group.push(session);
    bySkill.set(session.skillName, group);
  }
  const invocationCountBySkill = invocations.reduce((acc, invocation) => {
    incrementRecordCount(acc, invocation.skillName);
    return acc;
  }, {} as Record<string, number>);
  const invocationGroupBySkill = invocations.reduce((acc, invocation) => {
    const group = acc.get(invocation.skillName) ?? [];
    group.push(invocation);
    acc.set(invocation.skillName, group);
    return acc;
  }, new Map<string, ExperienceInvocation[]>());

  return Array.from(bySkill.entries()).map(([skillName, group]): ExperienceSkillSummary => {
    const first = group[0];
    const skillInvocations = invocationGroupBySkill.get(skillName) ?? [];
    const indicators = sumIndicators(group.map((session) => session.indicators));
    const evidenceChain = sumEvidenceChains(group.map((session) => session.evidenceChain));
    const ruleFindings = mergeRuleFindings(group.flatMap((session) => session.ruleFindings));
    const problemPatterns = mergeExperienceProblemPatterns(group.flatMap((session) => session.problemPatterns));
    const timestampedInvocations = skillInvocations.filter(invocationTimestampObserved);
    const timestampedInvocationCount = timestampedInvocations.length;
    const firstSeen = minString(timestampedInvocations.map((invocation) => invocation.startTimestamp))
      ?? first.startTimestamp;
    const lastSeen = maxString(timestampedInvocations.map((invocation) => invocation.endTimestamp))
      ?? first.endTimestamp;
    return {
      skillName,
      invocationCount: ownRecordValue(invocationCountBySkill, skillName) ?? 0,
      sessionCount: group.length,
      sourceKinds: unique(group.map((session) => session.sourceKind)).sort(),
      entrypoints: unique(group.map((session) => session.entrypoint).filter((value): value is string => Boolean(value))).sort(),
      entrypointCounts: countBy(skillInvocations.map((invocation) => invocation.entrypoint ?? invocation.sourceKind ?? 'unknown')),
      sourceMetadataCounts: summarizeSourceMetadataCounts(skillInvocations.map((invocation) => invocation.sourceMetadata)),
      attributionCounts: countBy(skillInvocations.map((invocation) => invocation.attribution.source || 'unknown')),
      pluginNames: unique(skillInvocations.map((invocation) => invocation.attribution.pluginName).filter((value): value is string => Boolean(value))).sort(),
      rawSkillRefs: unique(skillInvocations.map((invocation) => invocation.attribution.rawSkillRef).filter((value): value is string => Boolean(value))).sort(),
      commandNames: unique(skillInvocations.map((invocation) => invocation.attribution.commandName).filter((value): value is string => Boolean(value))).sort(),
      toolCounts: sumRecordCounts(skillInvocations.map((invocation) => invocation.toolCounts)),
      firstSeen,
      lastSeen,
      timestampedInvocationCount,
      timestampCoverage: skillInvocations.length > 0
        ? timestampedInvocationCount / skillInvocations.length
        : 0,
      reviewFirstSessionCount: group.filter((session) => session.reviewPriority === 'review_first').length,
      sampleReviewSessionCount: group.filter((session) => session.reviewPriority === 'sample_review').length,
      indicators,
      evidenceChain,
      ruleFindings,
      assistiveInference: assistiveInferenceForEvidence(indicators, evidenceChain, ruleFindings),
      problemPatterns,
      relatedObservationIds: unique(group.flatMap((session) => session.relatedObservationIds)),
    };
  }).sort((a, b) => {
    const aScore = a.reviewFirstSessionCount * 100 + a.sampleReviewSessionCount * 10 + a.indicators.highObservationCount;
    const bScore = b.reviewFirstSessionCount * 100 + b.sampleReviewSessionCount * 10 + b.indicators.highObservationCount;
    if (bScore !== aScore) return bScore - aScore;
    return b.invocationCount - a.invocationCount;
  });
}

function mergeSourceMetadata(values: Array<TraceSourceMetadata | undefined>): TraceSourceMetadata | undefined {
  const channels = unique(values.map((value) => value?.channel).filter((value): value is string => Boolean(value)));
  const senders = unique(values.map((value) => value?.sender).filter((value): value is string => Boolean(value)));
  const senderIds = unique(values.map((value) => value?.senderId).filter((value): value is string => Boolean(value)));
  const providers = unique(values.map((value) => value?.provider).filter((value): value is string => Boolean(value)));
  const models = unique(values.map((value) => value?.model).filter((value): value is string => Boolean(value)));
  const modelApis = unique(values.map((value) => value?.modelApi).filter((value): value is string => Boolean(value)));
  const businessActions = unique(values.flatMap((value) => sourceBusinessActions(value)));
  const merged: TraceSourceMetadata = {};
  if (channels.length > 0) merged.channel = channels.join(', ');
  if (senders.length > 0) merged.sender = senders.join(', ');
  if (senderIds.length > 0) merged.senderId = senderIds.join(', ');
  if (providers.length > 0) merged.provider = providers.join(', ');
  if (models.length > 0) merged.model = models.join(', ');
  if (modelApis.length > 0) merged.modelApi = modelApis.join(', ');
  if (businessActions.length > 0) merged.businessActions = businessActions.sort();
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function summarizeSourceMetadataCounts(values: Array<TraceSourceMetadata | undefined>): ExperienceSkillSummary['sourceMetadataCounts'] {
  return {
    channels: countBy(values.map((value) => value?.channel).filter((value): value is string => Boolean(value))),
    senders: countBy(values.map((value) => sourceSenderLabel(value)).filter((value): value is string => Boolean(value))),
    businessActions: countBy(values.flatMap((value) => sourceBusinessActions(value))),
    providers: countBy(values.map((value) => value?.provider).filter((value): value is string => Boolean(value))),
    models: countBy(values.map((value) => value?.model).filter((value): value is string => Boolean(value))),
  };
}

function sourceBusinessActions(value?: TraceSourceMetadata): string[] {
  if (!value) return [];
  const legacyKey = ['ai', 'maCommands'].join('');
  const legacy = (value as unknown as Record<string, unknown>)[legacyKey];
  if (Array.isArray(legacy)) return unique([...(value.businessActions ?? []), ...legacy.filter((item): item is string => typeof item === 'string')]);
  return value.businessActions ?? [];
}

function sourceSenderLabel(value?: TraceSourceMetadata): string | undefined {
  if (!value?.sender && !value?.senderId) return undefined;
  if (value.sender && value.senderId) return `${value.sender}(${value.senderId})`;
  return value.sender ?? value.senderId;
}

function countTools(segment: SkillSegment): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const toolCall of segment.toolCalls) {
    incrementRecordCount(counts, toolCall.tool);
  }
  return counts;
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    incrementRecordCount(counts, value);
  }
  return counts;
}

function sumEvidenceChains(values: ExperienceEvidenceChain[]): ExperienceEvidenceChain {
  return values.reduce((acc, value) => ({
    userMessageCount: sumSafeCounts(acc.userMessageCount, value?.userMessageCount ?? 0),
    runtimeContextCount: sumSafeCounts(acc.runtimeContextCount, value?.runtimeContextCount ?? 0),
    skillContextCount: sumSafeCounts(acc.skillContextCount, value?.skillContextCount ?? 0),
    assistantMessageCount: sumSafeCounts(acc.assistantMessageCount, value?.assistantMessageCount ?? 0),
    toolUseCount: sumSafeCounts(acc.toolUseCount, value?.toolUseCount ?? 0),
    toolResultCount: sumSafeCounts(acc.toolResultCount, value?.toolResultCount ?? 0),
    toolFailureResultCount: sumSafeCounts(acc.toolFailureResultCount, value?.toolFailureResultCount ?? 0),
    observationCount: sumSafeCounts(acc.observationCount, value?.observationCount ?? 0),
    firstUserMessage: acc.firstUserMessage ?? value?.firstUserMessage,
    firstRuntimeContext: acc.firstRuntimeContext ?? value?.firstRuntimeContext,
    firstSkillContext: acc.firstSkillContext ?? value?.firstSkillContext,
    firstToolUse: acc.firstToolUse ?? value?.firstToolUse,
    firstToolFailure: acc.firstToolFailure ?? value?.firstToolFailure,
    lastAssistantMessage: value?.lastAssistantMessage ?? acc.lastAssistantMessage,
  }), {
    userMessageCount: 0,
    runtimeContextCount: 0,
    skillContextCount: 0,
    assistantMessageCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    toolFailureResultCount: 0,
    observationCount: 0,
  });
}

function mergeRuleFindings(values: ExperienceRuleFinding[]): ExperienceRuleFinding[] {
  const byCode = new Map<ExperienceRuleFindingCode, ExperienceRuleFinding>();
  for (const value of values) {
    const existing = byCode.get(value.code);
    if (existing) {
      existing.count = sumSafeCounts(existing.count, value.count);
      existing.evidenceRefs = uniqueEvidenceRefs([...existing.evidenceRefs, ...value.evidenceRefs]).slice(0, 5);
    } else {
      byCode.set(value.code, { ...value, evidenceRefs: uniqueEvidenceRefs(value.evidenceRefs).slice(0, 5) });
    }
  }
  return Array.from(byCode.values()).sort((a, b) => {
    const rank: Record<ExperienceRuleFindingLevel, number> = { attention: 0, sample: 1, normal: 2 };
    if (rank[a.level] !== rank[b.level]) return rank[a.level] - rank[b.level];
    return b.count - a.count;
  });
}
