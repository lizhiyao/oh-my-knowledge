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
import { observationMetricAnnotationVerdict } from './review-state.js';
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
  basisCodesForIndicators,
  enrichRouterDownstreamIndicators,
  evidenceRefFromTimeline,
  invocationTimestampObserved,
  priorityForReviewerFindings,
  priorityForScore,
  scoreForIndicators,
  sumIndicators,
  sumRecordCounts,
  uniqueEvidenceRefs,
} from './experience/report-derivations.js';
import {
  buildSessionStory,
  inferUserGoal,
} from './experience/session-story.js';
import { buildReviewerReport } from './experience/reviewer-report.js';
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
