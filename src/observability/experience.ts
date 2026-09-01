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
import { hasAssistantDeliverableArtifactText, hasUserHardRuleText, isAssistantProgressUpdateText, isSyntheticUserMessageText, isToolResultFailureText, isUserInteractionMetricText } from './text-signals.js';
import {
  compareTimelineEvents,
  hashParts,
  isObjectRecord,
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
  primarySourceTraceForSession,
  priorityForReviewerFindings,
  priorityForScore,
  scoreForIndicators,
  sumIndicators,
  sumRecordCounts,
  sumTokenUsage,
  uniqueEvidenceRefs,
  userFacingClosureForSession,
  type CurrentSkillRuntimeModel,
} from './experience/report-derivations.js';
import { durationMsBetween } from '../shared/time.js';
import {
  incrementRecordCount,
  ownRecordValue,
  sumRecordCounts as sumSafeCounts,
} from '../shared/record-count.js';
import {
  loadExpectedToolsForSkill,
  loadFrontmatterSkillType,
  loadSkillDeclarationCheck,
} from './experience-frontmatter.js';
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

export function aggregateExperienceChecklistItemStatus(statuses: ExperienceChecklistItemStatus[]): ExperienceChecklistItemStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('not_declared')) return 'not_declared';
  if (statuses.includes('passed')) return 'passed';
  return 'not_applicable';
}

interface ExperienceEpisodeRange {
  startMessageIndex: number;
  endMessageIndex: number;
  traceId?: string;
  sourceTrace?: string;
  sessionId?: string;
  boundaryReason?: ExperienceEpisodeBoundaryReason;
}

const USER_INTERRUPTION_RE = /\[Request interrupted by user(?: for tool use)?\]|interrupted by user|用户中断|停止任务|停一下|先别|别动|等一下|等下|等等|取消(?:任务|执行)?|先暂停|暂停一下/i;

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

function buildSessionStory(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  canonicalEpisodes?: ExperienceEpisode[],
  reviewState?: ObservationReviewState,
): ExperienceSessionStory {
  const nodes: ExperienceSessionStoryNode[] = [];
  const push = (
    kind: ExperienceSessionStoryNodeKind,
    label: string,
    status: ExperienceReviewerReportStepStatus,
    text: string,
    evidenceRefs: ExperienceEvidenceRef[] = [],
  ): ExperienceSessionStoryNode => {
    nodes.push({
      id: hashParts('session-story-node', session.id, kind, String(nodes.length), text),
      order: nodes.length + 1,
      kind,
      label,
      status,
      text,
      evidenceRefs: uniqueEvidenceRefs(evidenceRefs).slice(0, 5),
    });
    return nodes[nodes.length - 1];
  };

  const goalSlices = sessionStoryGoalSlices(session, invocations);
  const subagentDispatches = sessionStorySubagentDispatches(session);
  const skillLinks = sessionStorySkillLinks(session, invocations);
  const progressUpdates = assistantProgressUpdateEvents(session);
  const finalDeliveries = assistantFinalDeliveryEvents(session);

  const userGoalNode = push(
    'user_goal',
    '用户提出目标',
    session.evidenceChain.firstUserMessage ? 'ok' : 'unknown',
    goalSlices.length > 1
      ? `识别到 ${goalSlices.length} 个目标段：${goalSlices.map((goal) => goal.inferredUserGoal ?? '未提取到明确目标').slice(0, 3).join('；')}${goalSlices.length > 3 ? '；...' : ''}`
      : session.evidenceChain.firstUserMessage?.snippet
        ? `用户目标：${session.evidenceChain.firstUserMessage.snippet}`
        : '没有看到明确人工用户目标；当前只能按运行证据还原链路。',
    session.evidenceChain.firstUserMessage ? [session.evidenceChain.firstUserMessage] : [],
  );

  const roleSummary = skillLinks.map((link) => `${link.skillName}：${skillRoleLabel(link.role)}`).join('；');
  const invocationText = skillLinks.length > 1
    ? `本次链路识别到 ${skillLinks.length} 个能力：${roleSummary}。`
    : skillLinks[0]
      ? `本次使用能力：${skillLinks[0].skillName}，角色判断：${skillRoleLabel(skillLinks[0].role)}。`
      : `本次使用能力：${session.skillName}。`;
  const invocationNode = push(
    'skill_invocation',
    '能力介入',
    'ok',
    invocationText,
    uniqueEvidenceRefs([session.evidenceChain.firstSkillContext, session.evidenceChain.firstToolUse].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
  );

  let subagentNode: ExperienceSessionStoryNode | undefined;
  if (subagentDispatches.length > 0) {
    subagentNode = push(
      'subagent_branch',
      '分支 / 子任务',
      'unknown',
      `检测到 ${subagentDispatches.length} 条分支或子任务执行线；主线和分支已单独列出，仍需要结合原文确认真实委派关系。`,
      subagentDispatches.flatMap((dispatch) => dispatch.evidenceRefs.slice(0, 1)),
    );
  }

  const executionNode = push(
    'tool_execution',
    '执行过程',
    session.indicators.toolFailureCount > 0
      ? 'attention'
      : (session.indicators.toolCancelledCount ?? 0) > 0
        || (session.indicators.toolUnknownCount ?? 0) > 0
        ? 'unknown'
        : session.indicators.toolCallCount > 0 ? 'ok' : 'unknown',
    session.indicators.toolCallCount > 0
      ? executionOutcomeText(session.indicators)
      : '没有看到明确工具调用；只能根据消息上下文复盘。',
    uniqueEvidenceRefs([
      session.evidenceChain.firstToolUse,
      session.evidenceChain.firstToolFailure,
    ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
  );

  const deliveryNode = push(
    'delivery',
    '交付产物',
    finalDeliveries.length > 0 ? 'ok' : 'attention',
    deliveryStepText(session),
    uniqueEvidenceRefs([
      ...finalDeliveries.slice(-2).map(evidenceRefFromTimeline),
      ...progressUpdates.slice(-2).map(evidenceRefFromTimeline),
      session.evidenceChain.lastAssistantMessage,
    ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))),
  );

  const feedbackNode = push(
    'user_feedback',
    '用户反馈',
    userFeedbackStepStatus(session, reviewState),
    userFeedbackStepText(session, reviewState),
    userFeedbackEvidenceRefs(session),
  );

  if (session.indicators.userGoalShiftCount > 0) {
    push(
      'goal_shift',
      '目标切换',
      'unknown',
      `用户中途切换了 ${session.indicators.userGoalShiftCount} 次目标，后续诉求可能不属于当前 skill。`,
      userFeedbackEvidenceRefs(session),
    );
  }

  const episodes = canonicalEpisodes ?? sessionStoryEpisodes(session, invocations, goalSlices, subagentDispatches, skillLinks);
  const goalChecklistItems = checklistItemsForAnswer(session, 'goal_satisfaction', episodes, reviewState);
  const declaredBehaviorChecklistItems = checklistItemsForAnswer(session, 'declared_behavior_fit', episodes);
  const userFeelingChecklistItems = checklistItemsForAnswer(session, 'user_feeling', episodes, reviewState);
  const answers: ExperienceSessionStoryAnswer[] = [
    sessionStoryAnswer('goal_satisfaction', '用户目标有没有被满足', goalChecklistItems, [
      session.evidenceChain.firstUserMessage,
      session.evidenceChain.lastAssistantMessage,
      ...userFeedbackEvidenceRefs(session),
    ]),
    sessionStoryAnswer('declared_behavior_fit', '行为是否符合能力用途', declaredBehaviorChecklistItems, [
      session.evidenceChain.firstSkillContext,
      session.evidenceChain.firstToolUse,
      session.evidenceChain.firstToolFailure,
    ]),
    sessionStoryAnswer('user_feeling', '用户是否觉得有用或绕路', userFeelingChecklistItems, userFeedbackEvidenceRefs(session)),
  ];

  const summary = answers.some((answer) => answer.status === 'degraded')
    ? '这次数据本身有可信度问题（比如 skill 没真的被加载），先确认数据再下判断。'
    : answers.some((answer) => answer.status === 'attention')
    ? '这次有几条需要看一眼的事项，从红色标记的事实和原文开始看。'
    : answers.every((answer) => answer.status === 'ok')
      ? '这次从目标、执行到反馈都没有明显异常，进入常规抽样。'
    : '这次链路已按语义节点展开，但部分结论仍需要人工结合原文判断。';

  return {
    schemaVersion: 1,
    summary,
    invocationCount: invocations.length,
    goalSliceCount: goalSlices.length,
    branchCount: subagentDispatches.length,
    progressUpdateCount: progressUpdates.length,
    finalDeliverySignalCount: finalDeliveries.length,
    mainlineNodeIds: [
      userGoalNode.id,
      invocationNode.id,
      ...(subagentNode ? [subagentNode.id] : []),
      executionNode.id,
      deliveryNode.id,
      feedbackNode.id,
    ],
    goalSlices,
    subagentDispatches,
    skillLinks,
    episodes,
    graph: sessionStoryGraph(nodes, skillLinks),
    nodes,
    answers,
  };
}

function sessionStoryEpisodes(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  goalSlices: ExperienceSessionStoryGoalSlice[],
  subagentDispatches: ExperienceSessionStorySubagentDispatch[],
  skillLinks: ExperienceSessionStorySkillLink[],
): ExperienceEpisode[] {
  const baseSkillSegments = sessionStorySkillSegments(session, invocations, skillLinks);
  const baseEpisodeId = hashParts('session-story-episode', session.id, '0');
  const orchestrationEdges = sessionStoryOrchestrationEdges(baseEpisodeId, baseSkillSegments, subagentDispatches, session, invocations);
  const skillSegments = skillSegmentsWithOrchestrationRoles(baseSkillSegments, orchestrationEdges);
  const feedbackSignals = sessionStoryFeedbackSignals(session, invocations, skillSegments, orchestrationEdges);
  const artifacts = sessionStoryArtifacts(invocations);
  const closure = sessionStoryOutcomeClosure(session, artifacts);
  const timeline = session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview;
  const ranges = sessionStoryEpisodeRanges(session, timeline);
  return ranges.map((range, index) => {
    const episodeId = hashParts('session-story-episode', session.id, String(index));
    const rangedSkillSegments = skillSegments.filter((segment) =>
      (segment.messageRanges ?? []).some((messageRange) =>
        messageRangeOverlapsEpisodeRange(messageRange, range)
      )
    );
    const rangedSegmentIds = new Set(rangedSkillSegments.map((segment) => segment.id));
    const episodeEdges = orchestrationEdges
      .filter((edge) => {
        if (edge.edgeKind === 'internal_skill' && edge.parentSkillSegmentId && edge.executorSkillSegmentId) {
          return rangedSegmentIds.has(edge.parentSkillSegmentId) && rangedSegmentIds.has(edge.executorSkillSegmentId);
        }
        return (edge.parentSkillSegmentId && rangedSegmentIds.has(edge.parentSkillSegmentId))
          || edge.evidenceRefs.some((ref) => episodeRangeContainsRef(range, ref));
      })
      .map((edge) => ({ ...edge, episodeId }));
    const linkedSegmentIds = new Set(episodeEdges.flatMap((edge) => [
      edge.parentSkillSegmentId,
      edge.executorSkillSegmentId,
    ].filter((id): id is string => Boolean(id))));
    const episodeSkillSegments = skillSegments.filter((segment) =>
      rangedSegmentIds.has(segment.id) || linkedSegmentIds.has(segment.id)
    );
    const segmentIds = new Set(episodeSkillSegments.map((segment) => segment.id));
    const episodeFeedbackSignals = feedbackSignals
      .filter((signal) => episodeRangeContainsRef(range, signal.evidenceRef))
      .map((signal) => {
        const attributions = (signal.canonicalAttributions ?? signal.attributions).filter((attribution) =>
          episodeFeedbackAttributionBelongsToEpisode(attribution, segmentIds, episodeEdges)
        );
        return {
          ...signal,
          canonicalAttributions: attributions,
          attributions,
        };
      })
      .filter((signal) => signal.attributions.length > 0);
    const episodeArtifacts = artifacts.filter((artifact) => episodeRangeContainsRef(range, artifact.evidenceRef));
    const episodeGoalSlices = goalSlices.filter((goal) => goal.evidenceRefs.some((ref) => episodeRangeContainsRef(range, ref)));
    const episodeTimeline = timeline.filter((event) => episodeRangeContainsRef(range, event));
    const startRef = episodeTimeline[0] ? evidenceRefFromTimeline(episodeTimeline[0]) : session.evidenceChain.firstUserMessage;
    const endRef = episodeTimeline.at(-1) ? evidenceRefFromTimeline(episodeTimeline.at(-1) as ExperienceTimelineEvent) : session.evidenceChain.lastAssistantMessage;
    const primaryGoal = episodeGoalSlices[0]?.inferredUserGoal
      ?? episodeTimeline.find((event) => event.kind === 'user_message')?.snippet
      ?? goalSlices[0]?.inferredUserGoal
      ?? session.evidenceChain.firstUserMessage?.snippet;
    const episodeClosure = index === ranges.length - 1 ? closure : 'unknown';
    return {
      id: episodeId,
      order: index + 1,
      sessionId: session.sessionId,
      primaryGoal,
      goalEvidenceRefs: [
        ...episodeGoalSlices.map((goal) => ({
          kind: 'goal_slice' as const,
          goalSliceId: goal.id,
          evidenceRef: goal.evidenceRefs[0],
          label: goal.inferredUserGoal ?? `目标段 ${goal.order}`,
        })),
        ...(episodeTimeline.find((event) => event.kind === 'user_message') ? [{
          kind: 'user_message' as const,
          evidenceRef: evidenceRefFromTimeline(episodeTimeline.find((event) => event.kind === 'user_message') as ExperienceTimelineEvent),
          label: episodeTimeline.find((event) => event.kind === 'user_message')?.snippet,
        }] : []),
      ],
      startTimestamp: minString([startRef?.timestamp, ...episodeSkillSegments.map((segment) => segment.startTimestamp)]) ?? session.startTimestamp,
      endTimestamp: maxString([endRef?.timestamp, ...episodeSkillSegments.map((segment) => segment.endTimestamp)]) ?? session.endTimestamp,
      startRef,
      endRef,
      boundaryReason: range.boundaryReason ?? sessionStoryEpisodeBoundaryReason(session, subagentDispatches, episodeEdges, episodeClosure),
      skillSegments: episodeSkillSegments,
      orchestrationEdges: episodeEdges,
      feedbackSignals: episodeFeedbackSignals,
      outcome: {
        closure: episodeClosure,
        artifacts: episodeArtifacts,
        verdict: session.reviewPriority,
        acceptanceCriteria: sessionStoryAcceptanceCriteria(session, episodeFeedbackSignals, episodeArtifacts),
      },
    };
  });
}

function episodeFeedbackAttributionBelongsToEpisode(
  attribution: ExperienceFeedbackAttribution,
  segmentIds: Set<string>,
  episodeEdges: ExperienceOrchestrationEdge[],
): boolean {
  if (!attribution.skillSegmentId || !segmentIds.has(attribution.skillSegmentId)) return false;
  if (attribution.reasonCode !== 'orchestration_edge') return true;
  return episodeEdges.some((edge) =>
    edge.parentSkillSegmentId === attribution.skillSegmentId
    || edge.executorSkillSegmentId === attribution.skillSegmentId
  );
}

function skillSegmentsWithOrchestrationRoles(
  skillSegments: ExperienceSkillSegment[],
  orchestrationEdges: ExperienceOrchestrationEdge[],
): ExperienceSkillSegment[] {
  if (orchestrationEdges.length === 0) return skillSegments;
  const parentIds = new Set(orchestrationEdges.map((edge) => edge.parentSkillSegmentId).filter((value): value is string => Boolean(value)));
  const executorIds = new Set(orchestrationEdges.map((edge) => edge.executorSkillSegmentId).filter((value): value is string => Boolean(value)));
  return skillSegments.map((segment) => {
    if (parentIds.has(segment.id)) {
      const inferredFromTrace = !segment.declaredSkillType;
      return {
        ...segment,
        skillType: inferredFromTrace ? 'router' : segment.skillType,
        skillTypeSource: inferredFromTrace ? 'trace' : segment.skillTypeSource,
        traceInferredSkillType: inferredFromTrace ? 'router' : segment.traceInferredSkillType,
        episodeRole: 'router',
      };
    }
    if (executorIds.has(segment.id)) {
      const inferredFromTrace = !segment.declaredSkillType;
      return {
        ...segment,
        skillType: inferredFromTrace ? 'executor' : segment.skillType,
        skillTypeSource: inferredFromTrace ? 'trace' : segment.skillTypeSource,
        traceInferredSkillType: inferredFromTrace ? 'executor' : segment.traceInferredSkillType,
        episodeRole: 'main_executor',
      };
    }
    return segment;
  });
}

function sessionStoryEpisodeRanges(
  session: ExperienceSessionSummary,
  timeline: ExperienceTimelineEvent[],
): ExperienceEpisodeRange[] {
  const primarySourceTrace = primarySourceTraceForSession(session);
  const primaryTraceId = primaryTraceIdForSession(session, primarySourceTrace);
  const rangeTimeline = timeline.filter((event) =>
    primaryTraceId
      ? !event.traceId || event.traceId === primaryTraceId
      : !primarySourceTrace || !event.sourceTrace || event.sourceTrace === primarySourceTrace
  );
  const indexes = rangeTimeline
    .map((event) => event.messageIndex)
    .filter((value): value is number => typeof value === 'number');
  const persistedRange = session.timelineScope.sessionRecordRanges?.find((range) =>
    primaryTraceId
      ? range.traceId === primaryTraceId
      : range.sourceTrace === primarySourceTrace
  );
  const sessionStart = minDefined(indexes)
    ?? persistedRange?.startRecordIndex
    ?? session.timelineScope.sessionStartRecordIndex
    ?? 0;
  const sessionEnd = maxDefined(indexes)
    ?? persistedRange?.endRecordIndex
    ?? session.timelineScope.sessionEndRecordIndex
    ?? sessionStart;
  const goalShiftStarts = unique(timeline
    .filter((event) =>
      event.kind === 'user_message'
      && typeof event.messageIndex === 'number'
      && event.messageIndex > sessionStart
      && (
        primaryTraceId
          ? !event.traceId || event.traceId === primaryTraceId
          : !primarySourceTrace || !event.sourceTrace || event.sourceTrace === primarySourceTrace
      )
    )
    .filter((event) => hasUserGoalShiftSignal(event.snippet ?? event.fullText ?? ''))
    .map((event) => event.messageIndex as number))
    .sort((a, b) => a - b);
  const starts = [sessionStart, ...goalShiftStarts];
  return starts.map((start, index) => ({
    startMessageIndex: start,
    endMessageIndex: (starts[index + 1] ?? (sessionEnd + 1)) - 1,
    traceId: primaryTraceId,
    sourceTrace: primarySourceTrace,
    sessionId: session.sessionId,
    boundaryReason: index < starts.length - 1 ? 'goal_shift' : undefined,
  }));
}

function primaryTraceIdForSession(
  session: ExperienceSessionSummary,
  primarySourceTrace = primarySourceTraceForSession(session),
): string | undefined {
  const timeline = session.fullSessionTimeline.length > 0
    ? session.fullSessionTimeline
    : session.timelinePreview;
  return timeline.find((event) =>
    event.traceRole === 'main'
    && (!primarySourceTrace || event.sourceTrace === primarySourceTrace)
  )?.traceId
    ?? timeline.find((event) =>
      !primarySourceTrace || event.sourceTrace === primarySourceTrace
    )?.traceId;
}

function episodeRangeContainsRef(
  range: ExperienceEpisodeRange,
  ref?: Pick<ExperienceEvidenceRef, 'messageIndex' | 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (!ref || typeof ref.messageIndex !== 'number') return false;
  if (range.traceId && ref.traceId && range.traceId !== ref.traceId) return false;
  if (range.sourceTrace && ref.sourceTrace && range.sourceTrace !== ref.sourceTrace) return false;
  if (range.sessionId && ref.sessionId && range.sessionId !== ref.sessionId) return false;
  return ref.messageIndex >= range.startMessageIndex && ref.messageIndex <= range.endMessageIndex;
}

function messageRangeOverlapsEpisodeRange(messageRange: ExperienceMessageRange, range: ExperienceEpisodeRange): boolean {
  if (range.traceId && messageRange.traceId && range.traceId !== messageRange.traceId) return false;
  if (range.sourceTrace && messageRange.sourceTrace && range.sourceTrace !== messageRange.sourceTrace) return false;
  if (range.sessionId && messageRange.sessionId && range.sessionId !== messageRange.sessionId) return false;
  return messageRange.endMessageIndex >= range.startMessageIndex
    && messageRange.startMessageIndex <= range.endMessageIndex;
}

function sessionStoryEpisodeBoundaryReason(
  session: ExperienceSessionSummary,
  subagentDispatches: ExperienceSessionStorySubagentDispatch[],
  orchestrationEdges: ExperienceOrchestrationEdge[],
  closure: ExperienceOutcomeClosure,
): ExperienceEpisodeBoundaryReason {
  if (session.indicators.userGoalShiftCount > 0) return 'goal_shift';
  if (subagentDispatches.length > 0) return 'checkpoint_or_subagent';
  if (orchestrationEdges.length > 0 && closure === 'closed') return 'downstream_closed';
  return 'session_end';
}

function sessionStorySkillSegments(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  skillLinks: ExperienceSessionStorySkillLink[],
): ExperienceSkillSegment[] {
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  return skillLinks.map((link, index) => {
    const group = link.invocationIds.map((id) => invocationById.get(id)).filter((value): value is ExperienceInvocation => Boolean(value));
    const declaredSkillType = loadFrontmatterSkillType(link.skillName, session.cwd);
    const traceInferredSkillType = traceInferredSkillTypeForLink(link);
    const skillType = declaredSkillType ?? traceInferredSkillType ?? 'unknown';
    const evidenceRefs = uniqueEvidenceRefs([
      ...link.evidenceRefs,
      ...group.flatMap((invocation) => invocation.evidenceRefs.slice(0, 2)),
    ]).slice(0, 6);
    const messageRanges: ExperienceMessageRange[] = group
      .map((invocation): ExperienceMessageRange | undefined => {
        const timelineWithIndex = invocation.timeline.filter((event) => typeof event.messageIndex === 'number');
        const indexes = timelineWithIndex
          .map((event) => event.messageIndex)
          .filter((value): value is number => typeof value === 'number');
        const startMessageIndex = minDefined(indexes);
        const endMessageIndex = maxDefined(indexes);
        const traceId = invocation.traceId ?? timelineWithIndex[0]?.traceId;
        const sourceTrace = invocation.sourceTrace ?? timelineWithIndex[0]?.sourceTrace;
        const sessionId = invocation.sessionId ?? timelineWithIndex[0]?.sessionId;
        return typeof startMessageIndex === 'number' && typeof endMessageIndex === 'number'
          ? { startMessageIndex, endMessageIndex, traceId, sourceTrace, sessionId }
          : undefined;
      })
      .filter((value): value is ExperienceMessageRange => Boolean(value));
    const messageIndexes = messageRanges.flatMap((range) => [range.startMessageIndex, range.endMessageIndex]);
    return {
      id: hashParts('session-story-skill-segment', session.id, link.skillName, String(index)),
      order: index + 1,
      skillName: link.skillName,
      skillType,
      skillTypeSource: declaredSkillType ? 'frontmatter' : traceInferredSkillType ? 'trace' : 'unknown',
      declaredSkillType,
      traceInferredSkillType,
      episodeRole: episodeRoleForLink(link, session, skillType),
      skillInvocationIds: link.invocationIds,
      startMessageIndex: minDefined(messageIndexes),
      endMessageIndex: maxDefined(messageIndexes),
      messageRanges,
      startTimestamp: minString(group.map((invocation) => invocation.startTimestamp)) ?? session.startTimestamp,
      endTimestamp: maxString(group.map((invocation) => invocation.endTimestamp)) ?? session.endTimestamp,
      typeSpecificChecklist: [],
      evidenceRefs,
    };
  });
}

function traceInferredSkillTypeForLink(link: ExperienceSessionStorySkillLink): ExperienceRuntimeSkillType | undefined {
  if (link.role === 'router') return 'router';
  if (link.role === 'executor' || link.role === 'mixed') return 'executor';
  return undefined;
}

function episodeRoleForLink(
  link: ExperienceSessionStorySkillLink,
  session: ExperienceSessionSummary,
  resolvedSkillType?: ExperienceRuntimeSkillType,
): ExperienceEpisodeRole {
  const skillType = resolvedSkillType ?? loadFrontmatterSkillType(link.skillName, session.cwd) ?? traceInferredSkillTypeForLink(link) ?? 'unknown';
  if (skillType === 'router') return 'router';
  if (skillType === 'delegation') return 'delegator';
  if (skillType === 'executor') return 'main_executor';
  if (skillType === 'advisory') return 'observer';
  if (skillType === 'workflow_owner') return 'router';
  if (link.role === 'router') return 'router';
  if (link.role === 'executor' || link.role === 'mixed') return 'main_executor';
  return 'supporting';
}


function sessionStoryOrchestrationEdges(
  episodeId: string,
  skillSegments: ExperienceSkillSegment[],
  subagentDispatches: ExperienceSessionStorySubagentDispatch[],
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
): ExperienceOrchestrationEdge[] {
  const edges: ExperienceOrchestrationEdge[] = [];
  const router = skillSegments.find((segment) => segment.episodeRole === 'router');
  const delegator = skillSegments.find((segment) => segment.episodeRole === 'delegator' || segment.skillType === 'delegation');
  const timeline = uniqueTimelineEvents(invocations.flatMap((invocation) => invocation.timeline))
    .sort(compareTimelineEvents);
  const runnerEvent = timeline
    .find(isOrchestrationRuntimeEvent);
  const runnerRef = runnerEvent ? evidenceRefFromTimeline(runnerEvent) : undefined;
  const runnerOwner = runnerRef ? skillSegmentForEvidenceRef(runnerRef, skillSegments) : undefined;
  const mentionedUpstream = runnerOwner
    ? mentionedUpstreamSkillSegmentForRuntime(runnerOwner, runnerEvent, timeline, skillSegments)
    : undefined;
  const runnerExecutor = mentionedUpstream && runnerOwner && runnerOwner.id !== mentionedUpstream.id
    ? runnerOwner
    : undefined;
  const priorUpstreamCandidate = runnerOwner
    ? bestPriorUpstreamSkillSegmentForRuntime(runnerOwner, runnerEvent, timeline, skillSegments)
    : undefined;
  const parentSegment = priorUpstreamCandidate
    ?? mentionedUpstream
    ?? router
    ?? (runnerOwner && (runnerOwner.skillType === 'router' || runnerOwner.skillType === 'delegation' || runnerOwner.episodeRole === 'delegator') ? runnerOwner : undefined)
    ?? delegator;
  const executor = runnerExecutor
    ?? (runnerOwner && parentSegment?.id !== runnerOwner.id ? runnerOwner : undefined)
    ?? (parentSegment?.id === router?.id ? skillSegments.find((segment) =>
    segment.id !== parentSegment?.id
    && segment.id !== router?.id
    && segment.episodeRole === 'main_executor'
  ) : undefined);
  if (parentSegment && (executor || runnerEvent) && parentSegment.id !== executor?.id) {
    const edgeKind = executor && skillSegmentsSharePhysicalTrace(parentSegment, executor)
      ? 'internal_skill'
      : 'external_child_session';
    // A concrete branch below is the authoritative external-child edge.
    // Keep this inferred edge only for an internal handoff or when no branch
    // trace was captured, otherwise the same launch appears twice.
    if (edgeKind === 'internal_skill' || subagentDispatches.length === 0) {
      edges.push({
        id: hashParts('session-story-edge', episodeId, parentSegment.id, executor?.id ?? 'downstream', '0'),
        episodeId,
        edgeKind,
        parentSkillSegmentId: parentSegment.id,
        executorSkillSegmentId: executor?.id,
        childSessionId: sessionStoryChildSessionId(runnerEvent),
        runnerStartedRef: runnerRef,
        status: runnerEvent || subagentDispatches.length > 0 ? 'started' : 'unknown',
        evidenceRefs: uniqueEvidenceRefs([
          ...parentSegment.evidenceRefs.slice(0, 2),
          ...(executor?.evidenceRefs.slice(0, 2) ?? []),
          ...(runnerRef ? [runnerRef] : []),
          ...subagentDispatches.flatMap((dispatch) => dispatch.evidenceRefs.slice(0, 1)),
        ]).slice(0, 6),
      });
    }
  }
  for (const dispatch of subagentDispatches) {
    const executor = skillSegmentForTrace(
      skillSegments,
      dispatch.traceId,
      dispatch.sourceTrace,
    );
    const parentSegment = dispatchParentSkillSegment(
      skillSegments,
      executor,
      session,
      dispatch,
      router,
      delegator,
      runnerOwner,
    );
    const distinctExecutor = executor?.id === parentSegment?.id ? undefined : executor;
    const dispatchRunnerRef = dispatchAttachmentEvidenceRef(session, dispatch);
    const terminal = dispatchTerminalLifecycle(session, dispatch);
    edges.push({
      id: hashParts('session-story-edge', episodeId, dispatch.id),
      episodeId,
      edgeKind: 'external_child_session',
      parentSkillSegmentId: parentSegment?.id,
      executorSkillSegmentId: distinctExecutor?.id,
      childSessionId: dispatch.childSessionId,
      runnerStartedRef: dispatchRunnerRef,
      runnerCompletedRef: terminal?.status === 'completed' ? terminal.evidenceRef : undefined,
      status: terminal?.status ?? 'started',
      evidenceRefs: uniqueEvidenceRefs([
        ...(parentSegment?.evidenceRefs.slice(0, 2) ?? []),
        ...(distinctExecutor?.evidenceRefs.slice(0, 2) ?? []),
        ...(dispatchRunnerRef ? [dispatchRunnerRef] : []),
        ...(terminal ? [terminal.evidenceRef] : []),
        ...dispatch.evidenceRefs,
      ]).slice(0, 6),
    });
  }
  if (edges.length === 0 && subagentDispatches.length === 0) {
    const fallbackEdge = fallbackOrchestrationEdgeFromRuntime(episodeId, skillSegments, invocations);
    if (fallbackEdge) edges.push(fallbackEdge);
  }
  return edges;
}

function skillSegmentForTrace(
  skillSegments: ExperienceSkillSegment[],
  traceId: string,
  sourceTrace: string,
): ExperienceSkillSegment | undefined {
  return skillSegments
    .filter((segment) =>
      (segment.messageRanges ?? []).some((range) =>
        range.traceId === traceId || range.sourceTrace === sourceTrace
      )
      || segment.evidenceRefs.some((ref) =>
        ref.traceId === traceId || ref.sourceTrace === sourceTrace
      )
    )
    .sort((a, b) => a.order - b.order)[0];
}

function dispatchParentSkillSegment(
  skillSegments: ExperienceSkillSegment[],
  executor: ExperienceSkillSegment | undefined,
  session: ExperienceSessionSummary,
  dispatch: ExperienceSessionStorySubagentDispatch,
  router: ExperienceSkillSegment | undefined,
  delegator: ExperienceSkillSegment | undefined,
  runnerOwner: ExperienceSkillSegment | undefined,
): ExperienceSkillSegment | undefined {
  const mainTraceIds = new Set(
    (session.timelineTree?.main ?? [])
      .map((event) => event.traceId)
      .filter((value): value is string => Boolean(value)),
  );
  const mainSourceTraces = new Set(
    (session.timelineTree?.main ?? [])
      .map((event) => event.sourceTrace)
      .filter(Boolean),
  );
  const isMainline = (segment: ExperienceSkillSegment): boolean =>
    (segment.messageRanges ?? []).some((range) =>
      Boolean(range.traceId && mainTraceIds.has(range.traceId))
      || Boolean(range.sourceTrace && mainSourceTraces.has(range.sourceTrace))
    )
    || segment.evidenceRefs.some((ref) =>
      ref.traceRole === 'main'
      || ref.traceRole === 'standalone'
      || Boolean(ref.traceId && mainTraceIds.has(ref.traceId))
      || mainSourceTraces.has(ref.sourceTrace)
    );
  const preferred = [router, delegator]
    .filter((segment): segment is ExperienceSkillSegment => Boolean(segment))
    .find((segment) => segment.id !== executor?.id && isMainline(segment));
  if (preferred) return preferred;
  const dispatchStart = minString(dispatch.evidenceRefs.map((ref) => ref.timestamp));
  const mainline = skillSegments
    .filter((segment) => segment.id !== executor?.id && isMainline(segment))
    .filter((segment) => !dispatchStart || segment.startTimestamp <= dispatchStart)
    .sort((a, b) =>
      b.startTimestamp.localeCompare(a.startTimestamp)
      || b.order - a.order
    )[0];
  if (mainline) return mainline;
  if (runnerOwner?.id !== executor?.id && runnerOwner && isMainline(runnerOwner)) return runnerOwner;
  return executor && isMainline(executor) ? executor : undefined;
}

function dispatchAttachmentEvidenceRef(
  session: ExperienceSessionSummary,
  dispatch: ExperienceSessionStorySubagentDispatch,
): ExperienceEvidenceRef | undefined {
  const attachTo = dispatch.attachTo;
  if (!attachTo) return undefined;
  if (!attachTo.callInstanceId && !attachTo.toolUseId && attachTo.messageIndex === undefined) {
    return undefined;
  }
  const event = (session.timelineTree?.main ?? []).find((candidate) => {
    if (candidate.kind !== 'tool_use') return false;
    if (attachTo.callInstanceId) {
      return candidate.callInstanceId === attachTo.callInstanceId;
    }
    if (attachTo.toolUseId && candidate.toolUseId !== attachTo.toolUseId) return false;
    return attachTo.messageIndex === undefined
      || candidate.messageIndex === attachTo.messageIndex;
  });
  return event ? evidenceRefFromTimeline(event) : undefined;
}

function dispatchTerminalLifecycle(
  session: ExperienceSessionSummary,
  dispatch: ExperienceSessionStorySubagentDispatch,
): { status: 'completed' | 'failed'; evidenceRef: ExperienceEvidenceRef } | undefined {
  const branch = session.timelineTree?.branches.find((candidate) =>
    candidate.id === dispatch.branchId
    || candidate.traceId === dispatch.traceId
    || candidate.sourceTrace === dispatch.sourceTrace
  );
  const event = branch?.events.at(-1);
  if (event?.kind !== 'lifecycle' && event?.kind !== 'runtime_context') return undefined;
  if (event.label === 'turn_completed' || event.label === 'session_ended') {
    return { status: 'completed', evidenceRef: evidenceRefFromTimeline(event) };
  }
  if (event.label === 'turn_aborted' || event.label === 'turn_interrupted') {
    return { status: 'failed', evidenceRef: evidenceRefFromTimeline(event) };
  }
  return undefined;
}

function bestPriorUpstreamSkillSegmentForRuntime(
  runnerOwner: ExperienceSkillSegment,
  runnerEvent: ExperienceTimelineEvent | undefined,
  timeline: ExperienceTimelineEvent[],
  skillSegments: ExperienceSkillSegment[],
): ExperienceSkillSegment | undefined {
  const runnerMessageIndex = runnerEvent?.messageIndex;
  const contextText = timeline
    .filter((event) => {
      if (!timelineEventSharesTraceScope(event, runnerEvent)) return false;
      if (typeof runnerMessageIndex !== 'number' || typeof event.messageIndex !== 'number') return true;
      return event.messageIndex <= runnerMessageIndex && event.messageIndex >= Math.max(0, runnerMessageIndex - 20);
    })
    .map((event) => `${event.toolName ?? ''} ${event.snippet ?? ''} ${event.fullText ?? ''}`)
    .join('\n');
  return skillSegments
    .filter((segment) => segment.id !== runnerOwner.id && segment.order < runnerOwner.order)
    .sort((a, b) =>
      upstreamParentScore(b, runnerOwner, contextText) - upstreamParentScore(a, runnerOwner, contextText)
      || b.order - a.order
    )[0];
}

function mentionedUpstreamSkillSegmentForRuntime(
  runnerOwner: ExperienceSkillSegment,
  runnerEvent: ExperienceTimelineEvent | undefined,
  timeline: ExperienceTimelineEvent[],
  skillSegments: ExperienceSkillSegment[],
): ExperienceSkillSegment | undefined {
  if (!runnerEvent) return undefined;
  const runnerMessageIndex = runnerEvent.messageIndex;
  const nearbyText = timeline
    .filter((event) => {
      if (!timelineEventSharesTraceScope(event, runnerEvent)) return false;
      if (typeof runnerMessageIndex !== 'number' || typeof event.messageIndex !== 'number') return true;
      return event.messageIndex <= runnerMessageIndex && event.messageIndex >= Math.max(0, runnerMessageIndex - 8);
    })
    .map((event) => `${event.toolName ?? ''} ${event.snippet ?? ''} ${event.fullText ?? ''}`)
    .join('\n');
  return skillSegments
    .filter((segment) => segment.id !== runnerOwner.id)
    .filter((segment) => segment.order < runnerOwner.order)
    .filter((segment) => {
      const name = segment.skillName.toLowerCase();
      const lowerText = nearbyText.toLowerCase();
      const compactName = compactObjectText(name);
      const compactText = compactObjectText(lowerText);
      const mentionIndex = name.length >= 4 ? lowerText.indexOf(name) : -1;
      const localContext = mentionIndex >= 0
        ? lowerText.slice(Math.max(0, mentionIndex - 40), mentionIndex + name.length + 100)
        : lowerText;
      const explicitlyMentioned = mentionIndex >= 0;
      const compactMentioned = compactName.length >= 6 && compactText.includes(compactName);
      if (!explicitlyMentioned && !compactMentioned) return false;
      return /skill|技能|流程|工作流|按|根据|启动|触发|委派|分发|delegate|dispatch|route/i.test(localContext);
    })
    .sort((a, b) =>
      upstreamParentScore(b, runnerOwner, nearbyText) - upstreamParentScore(a, runnerOwner, nearbyText)
      || Math.abs(a.order - runnerOwner.order) - Math.abs(b.order - runnerOwner.order)
    )[0];
}

function upstreamParentScore(segment: ExperienceSkillSegment, runnerOwner: ExperienceSkillSegment, contextText: string): number {
  const lowerName = segment.skillName.toLowerCase();
  const lowerText = contextText.toLowerCase();
  let score = 0;
  if (segment.episodeRole === 'router' || segment.skillType === 'router') score += 80;
  if (segment.episodeRole === 'delegator' || segment.skillType === 'delegation') score += 70;
  if (segment.episodeRole === 'observer' || segment.skillType === 'advisory') score += 45;
  const nameIndex = lowerText.indexOf(lowerName);
  if (nameIndex >= 0) {
    const localContext = lowerText.slice(Math.max(0, nameIndex - 50), nameIndex + lowerName.length + 120);
    if (/按|根据|流程|工作流|skill|技能|启动|触发/.test(localContext)) score += 30;
    if (/读取|搜索|文档|链接|知识库/.test(localContext)) score -= 10;
  }
  if (segment.order < runnerOwner.order) score += Math.max(0, 20 - (runnerOwner.order - segment.order) * 3);
  return score;
}

function fallbackOrchestrationEdgeFromRuntime(
  episodeId: string,
  skillSegments: ExperienceSkillSegment[],
  invocations: ExperienceInvocation[],
): ExperienceOrchestrationEdge | undefined {
  const timeline = uniqueTimelineEvents(invocations.flatMap((invocation) => invocation.timeline)).sort(compareTimelineEvents);
  const runtimeEvent = timeline.find(isOrchestrationRuntimeEvent);
  if (!runtimeEvent) return undefined;
  const runtimeRef = evidenceRefFromTimeline(runtimeEvent);
  const executor = skillSegmentForEvidenceRef(runtimeRef, skillSegments);
  if (!executor) return undefined;
  const parent = skillSegments
    .filter((segment) => segment.id !== executor.id && segment.order < executor.order)
    .sort((a, b) => b.order - a.order)[0];
  if (!parent) return undefined;
  const edgeKind = skillSegmentsSharePhysicalTrace(parent, executor) ? 'internal_skill' : 'external_child_session';
  return {
    id: hashParts('session-story-edge', episodeId, parent.id, executor.id, 'fallback'),
    episodeId,
    edgeKind,
    parentSkillSegmentId: parent.id,
    executorSkillSegmentId: executor.id,
    childSessionId: sessionStoryChildSessionId(runtimeEvent),
    runnerStartedRef: runtimeRef,
    status: 'started',
    evidenceRefs: uniqueEvidenceRefs([
      ...parent.evidenceRefs.slice(0, 2),
      ...executor.evidenceRefs.slice(0, 2),
      runtimeRef,
    ]).slice(0, 6),
  };
}

function isOrchestrationRuntimeEvent(event: ExperienceTimelineEvent): boolean {
  const text = `${event.toolName ?? ''} ${event.snippet ?? ''} ${event.fullText ?? ''}`;
  if (event.kind === 'tool_use') {
    return /^(?:Task|Agent)$/i.test(event.toolName ?? '')
      || /runner\.js|send-input\.js|check-session\.js/i.test(text);
  }
  if (event.kind === 'assistant_message') {
    return /ttyd|(?:已启动|启动了|spawned|started).{0,80}(?:subagent|sub-agent|child agent|子\s*(?:agent|代理|智能体|Claude|Codex))|(?:subagent|sub-agent|child agent|子\s*(?:agent|代理|智能体|Claude|Codex)).{0,48}(?:已启动|启动中|正在(?:执行|运行|分析)|spawned|started|running)/i.test(text)
      || /\b(?:session|thread|agent)(?:\s+id)?\s*[:=]\s*[a-z0-9][a-z0-9._-]*/i.test(text);
  }
  return false;
}

function sessionStoryChildSessionId(event?: ExperienceTimelineEvent): string | undefined {
  const text = `${event?.snippet ?? ''} ${event?.fullText ?? ''}`;
  return text.match(
    /["']?(?:child_?session_?id|agent_?id|thread_?id|session_?id)["']?\s*[:=]\s*["']?([a-z0-9][a-z0-9._-]*)/i,
  )?.[1]
    ?? text.match(/\b(?:session|thread|agent)(?:\s+id)?\s*[:=]\s*([a-z0-9][a-z0-9._-]*)/i)?.[1]
    ?? text.match(/\b(?:claude|codex|agent|subagent)-[a-z0-9_-]+\b/i)?.[0];
}

function sessionStoryFeedbackSignals(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  skillSegments: ExperienceSkillSegment[],
  orchestrationEdges: ExperienceOrchestrationEdge[],
): ExperienceFeedbackSignal[] {
  const timeline = uniqueTimelineEvents(invocations.flatMap((invocation) => invocation.timeline))
    .sort(compareTimelineEvents);
  const promises = sessionStoryPromiseOwners(timeline, skillSegments);
  const userEvents = timeline.filter((event) =>
    event.kind === 'user_message'
    && isUserInteractionMetricText(event.snippet ?? event.fullText ?? '')
  );
  return userEvents
    .map((event, index): ExperienceFeedbackSignal | undefined => {
      const text = event.snippet ?? event.fullText ?? '';
      const type = feedbackSignalType(text, index);
      if (type === 'unknown' && index === 0) return undefined;
      const evidenceRef = evidenceRefFromTimeline(event);
      const canonicalAttributions = feedbackAttributionsForText(text, evidenceRef, skillSegments, orchestrationEdges, timeline, promises);
      return {
        id: hashParts('session-story-feedback', session.id, event.id, String(index)),
        order: index + 1,
        type,
        text,
        targetObject: feedbackTargetObject(text, skillSegments),
        sourceWindow: orchestrationEdges.length > 0 && /有结论|进度|没返回|为什么|停止|中断|跑偏|不对|组件.*pr|master/i.test(text)
          ? 'episode'
          : 'skill_invocation',
        evidenceRef,
        canonicalAttributions,
        attributions: canonicalAttributions,
      };
    })
    .filter((value): value is ExperienceFeedbackSignal => Boolean(value));
}

function feedbackSignalType(text: string, index: number): ExperienceFeedbackSignalType {
  if (USER_INTERRUPTION_RE.test(text)) return 'interruption';
  if (hasUserCorrectionSignal(text) || /不是|不对|错了|跑偏|漏了|组件.*pr|master/i.test(text)) return 'correction';
  if (hasNegativeFeedbackSignal(text) || /烦|失望|怎么.*还|为什么.*没|没返回|有结论吗/i.test(text)) return 'frustration';
  if (hasPositiveFeedbackSignal(text)) return 'positive';
  if (index > 0) return 'follow_up';
  return 'unknown';
}

function feedbackTargetObject(text: string, skillSegments: ExperienceSkillSegment[]): string | undefined {
  const skillOwner = targetObjectSkillOwner(text, skillSegments);
  if (skillOwner) return skillOwner.skillName;
  if (/pr|pull request/i.test(text)) return 'PR';
  if (/有结论|进度|没返回|通知|返回/i.test(text)) return '异步结果';
  if (/停止|暂停|中断|别动/i.test(text)) return '执行流程';
  if (/产物|文档|报告|demo/i.test(text)) return '产物';
  return undefined;
}

function feedbackAttributionsForText(
  text: string,
  evidenceRef: ExperienceEvidenceRef,
  skillSegments: ExperienceSkillSegment[],
  orchestrationEdges: ExperienceOrchestrationEdge[],
  timeline: ExperienceTimelineEvent[],
  promises: ExperiencePromiseOwner[],
): ExperienceFeedbackAttribution[] {
  const lower = text.toLowerCase();
  const targetOwner = targetObjectSkillOwner(text, skillSegments);
  const promiseOwner = promiseOwnerForFeedback(evidenceRef, text, promises);
  const promisePrimaryOwner = promiseOwner && shouldPromiseOwnerReceivePrimaryFeedback(text)
    ? upstreamPromiseOwnerForFeedback(promiseOwner, orchestrationEdges, skillSegments) ?? promiseOwner
    : promiseOwner;
  const actionOwner = actionOwnerForFeedback(evidenceRef, text, timeline, skillSegments);
  const windowMatched = skillSegmentForEvidenceRef(evidenceRef, skillSegments);
  const windowOwner = windowMatched && shouldUseWindowFeedbackOwner(windowMatched, text) ? windowMatched : undefined;
  const promiseLike = isAsyncPromiseFeedbackText(text);
  const explicitTargetOwner = targetOwner && isExplicitSkillTargetText(text, targetOwner);
  const ownerDecision = explicitTargetOwner
    ? { segment: targetOwner, reason: 'object_match' as const }
    : promisePrimaryOwner && promiseLike
      ? { segment: promisePrimaryOwner, reason: 'promise_match' as const }
      : targetOwner
        ? { segment: targetOwner, reason: 'object_match' as const }
      : actionOwner
        ? actionOwner
        : windowOwner
          ? { segment: windowOwner, reason: feedbackAttributionReasonForText(lower) }
          : undefined;
  const primary = ownerDecision?.segment;
  const attributions: ExperienceFeedbackAttribution[] = [];
  if (ownerDecision) {
    attributions.push({
      skillName: ownerDecision.segment.skillName,
      skillSegmentId: ownerDecision.segment.id,
      attributionRole: 'primary_fault',
      reasonCode: ownerDecision.reason,
      evidenceRefs: [evidenceRef],
    });
  }
  if (promiseOwner && promiseOwner.id !== primary?.id && shouldPromiseOwnerReceivePrimaryFeedback(text)) {
    attributions.push({
      skillName: promiseOwner.skillName,
      skillSegmentId: promiseOwner.id,
      attributionRole: promisePrimaryOwner?.id !== promiseOwner.id ? 'context_only' : 'primary_fault',
      reasonCode: 'promise_match',
      evidenceRefs: [evidenceRef],
    });
  }
  const downstreamParents = primary
    ? downstreamRelatedParentsForPrimary(primary, skillSegments, orchestrationEdges)
    : promiseOwner
      ? downstreamRelatedParentsForPrimary(promiseOwner, skillSegments, orchestrationEdges)
      : [];
  for (const { segment, edge } of downstreamParents) {
    attributions.push({
      skillName: segment.skillName,
      skillSegmentId: segment.id,
      attributionRole: 'downstream_related',
      reasonCode: 'orchestration_edge',
      evidenceRefs: [evidenceRef, ...edge.evidenceRefs.slice(0, 2)].slice(0, 3),
    });
  }
  if (attributions.length === 0 && windowMatched) {
    attributions.push({
      skillName: windowMatched.skillName,
      skillSegmentId: windowMatched.id,
      attributionRole: 'context_only',
      reasonCode: 'episode_context',
      evidenceRefs: [evidenceRef],
    });
  } else if (attributions.length === 0 && skillSegments[0]) {
    attributions.push({
      skillName: skillSegments[0].skillName,
      skillSegmentId: skillSegments[0].id,
      attributionRole: 'context_only',
      reasonCode: 'episode_context',
      evidenceRefs: [evidenceRef],
    });
  }
  return dedupeFeedbackAttributions(attributions);
}

function upstreamPromiseOwnerForFeedback(
  promiseOwner: ExperienceSkillSegment,
  orchestrationEdges: ExperienceOrchestrationEdge[],
  skillSegments: ExperienceSkillSegment[],
): ExperienceSkillSegment | undefined {
  const segmentById = new Map(skillSegments.map((segment) => [segment.id, segment]));
  const parents = orchestrationEdges
    .filter((edge) => edge.executorSkillSegmentId === promiseOwner.id && edge.parentSkillSegmentId && edge.parentSkillSegmentId !== promiseOwner.id)
    .map((edge) => segmentById.get(edge.parentSkillSegmentId as string))
    .filter((segment): segment is ExperienceSkillSegment => Boolean(segment));
  return parents
    .sort((a, b) => upstreamPromiseOwnerScore(b) - upstreamPromiseOwnerScore(a))[0];
}

function upstreamPromiseOwnerScore(segment: ExperienceSkillSegment): number {
  let score = 0;
  if (segment.episodeRole === 'router' || segment.skillType === 'router') score += 80;
  if (segment.episodeRole === 'delegator' || segment.skillType === 'delegation') score += 70;
  return score;
}

function downstreamRelatedParentsForPrimary(
  primary: ExperienceSkillSegment,
  skillSegments: ExperienceSkillSegment[],
  orchestrationEdges: ExperienceOrchestrationEdge[],
): Array<{ segment: ExperienceSkillSegment; edge: ExperienceOrchestrationEdge }> {
  const segmentById = new Map(skillSegments.map((segment) => [segment.id, segment]));
  return orchestrationEdges
    .filter((edge) =>
      edge.parentSkillSegmentId
      && edge.executorSkillSegmentId === primary.id
      && edge.parentSkillSegmentId !== primary.id
    )
    .map((edge) => {
      const segment = segmentById.get(edge.parentSkillSegmentId as string);
      return segment ? { segment, edge } : undefined;
    })
    .filter((value): value is { segment: ExperienceSkillSegment; edge: ExperienceOrchestrationEdge } => Boolean(value));
}

function isAsyncPromiseFeedbackText(text: string): boolean {
  return /有结论|进度|怎么样了|跑完|完成了吗|没返回|为什么.*(?:没|不).*?(?:通知|返回|同步)|通知|返回|同步|查看地址/i.test(text);
}

function shouldPromiseOwnerReceivePrimaryFeedback(text: string): boolean {
  return /为什么.*(?:没|不).*?(?:通知|返回|同步)|没返回|没有.*(?:通知|返回|同步)|有结论吗|怎么.*还没/i.test(text);
}

function isExplicitSkillTargetText(text: string, owner: ExperienceSkillSegment): boolean {
  const lower = text.toLowerCase();
  const name = owner.skillName.toLowerCase();
  const compact = compactObjectText(lower);
  const compactName = compactObjectText(name);
  return lower.includes(name) || (compactName.length >= 4 && compact.includes(compactName));
}

interface ExperiencePromiseOwner {
  messageIndex: number;
  segment: ExperienceSkillSegment;
  evidenceRef: ExperienceEvidenceRef;
}

function sessionStoryPromiseOwners(
  timeline: ExperienceTimelineEvent[],
  skillSegments: ExperienceSkillSegment[],
): ExperiencePromiseOwner[] {
  return timeline
    .filter((event) => event.kind === 'assistant_message')
    .map((event): ExperiencePromiseOwner | undefined => {
      const text = `${event.snippet ?? ''} ${event.fullText ?? ''}`;
      if (!/有结果.*同步|完成.*(?:通知|同步|回复|转回)|跑完.*(?:告诉|通知|同步)|我会等.*(?:分析完|完成)|我会.*(?:转回|同步|回复)|有结论.*(?:同步|回复)/i.test(text)) return undefined;
      const evidenceRef = evidenceRefFromTimeline(event);
      const segment = skillSegmentForEvidenceRef(evidenceRef, skillSegments);
      if (!segment || typeof evidenceRef.messageIndex !== 'number') return undefined;
      return { messageIndex: evidenceRef.messageIndex, segment, evidenceRef };
    })
    .filter((value): value is ExperiencePromiseOwner => Boolean(value));
}

function promiseOwnerForFeedback(
  evidenceRef: ExperienceEvidenceRef,
  text: string,
  promises: ExperiencePromiseOwner[],
): ExperienceSkillSegment | undefined {
  if (typeof evidenceRef.messageIndex !== 'number') return undefined;
  const feedbackMessageIndex = evidenceRef.messageIndex;
  if (!/有结论|进度|怎么样了|跑完|完成了吗|没返回|为什么.*(?:没|不).*?(?:通知|返回|同步)|通知|返回|同步/i.test(text)) return undefined;
  return promises
    .filter((promise) => evidenceRefsShareTraceScope(promise.evidenceRef, evidenceRef))
    .filter((promise) => promise.messageIndex <= feedbackMessageIndex)
    .sort((a, b) => b.messageIndex - a.messageIndex)[0]?.segment;
}

function targetObjectSkillOwner(text: string, skillSegments: ExperienceSkillSegment[]): ExperienceSkillSegment | undefined {
  const lower = text.toLowerCase();
  const compact = compactObjectText(lower);
  const explicitSkill = skillSegments.find((segment) => {
    const name = segment.skillName.toLowerCase();
    const compactName = compactObjectText(name);
    return lower.includes(name)
      || (compactName.length >= 4 && compact.includes(compactName));
  });
  if (explicitSkill) return explicitSkill;

  if (/runner|child|subagent|sub-agent|子\s*(?:claude|codex|agent|代理|智能体)|(?:claude|codex|agent)\s*session|ttyd|执行窗口/.test(lower)) {
    return skillSegments
      .filter((segment) =>
        segment.episodeRole === 'delegator'
        || segment.episodeRole === 'router'
        || segment.skillType === 'delegation'
        || segment.skillType === 'router'
        || segment.skillType === 'workflow_owner'
      )
      .sort((a, b) => upstreamPromiseOwnerScore(b) - upstreamPromiseOwnerScore(a) || a.order - b.order)[0];
  }
  if (/skill\s*extract|soft[-_\s]*standard|llm[-_\s]*enhanced|skill\.md|这个skill|执行流程|依赖.*脚本|删除.*脚本|review/.test(lower)) {
    return skillSegments
      .filter((segment) => segment.episodeRole === 'observer' || segment.skillType === 'advisory')
      .sort((a, b) => a.order - b.order)[0];
  }
  return undefined;
}

function compactObjectText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

function actionOwnerForFeedback(
  evidenceRef: ExperienceEvidenceRef,
  text: string,
  timeline: ExperienceTimelineEvent[],
  skillSegments: ExperienceSkillSegment[],
): { segment: ExperienceSkillSegment; reason: 'object_match' | 'action_match' } | undefined {
  const category = feedbackActionCategory(text);
  if (!category || typeof evidenceRef.messageIndex !== 'number') return undefined;
  const feedbackMessageIndex = evidenceRef.messageIndex;
  const commandEnvelopeText = timeline
    .filter((event) =>
      event.kind === 'runtime_context'
      && event.messageIndex === feedbackMessageIndex
      && evidenceRefsShareTraceScope(event, evidenceRef)
    )
    .map((event) => `${event.snippet ?? ''} ${event.fullText ?? ''}`)
    .join('\n')
    .toLowerCase();
  const commandOwner = skillSegments.find((segment) => {
    const name = segment.skillName.toLowerCase();
    const compactName = compactObjectText(name);
    return commandEnvelopeText.includes(name)
      || (compactName.length >= 4 && compactObjectText(commandEnvelopeText).includes(compactName));
  });
  if (commandOwner) return { segment: commandOwner, reason: 'object_match' };

  const nextRuntimeEvent = timeline.find((event) => {
    if (typeof event.messageIndex !== 'number') return false;
    if (!evidenceRefsShareTraceScope(event, evidenceRef)) return false;
    if (event.messageIndex <= feedbackMessageIndex || event.messageIndex > feedbackMessageIndex + 16) return false;
    if (event.kind !== 'tool_use' && event.kind !== 'assistant_message') return false;
    const eventText = `${event.toolName ?? ''} ${event.snippet ?? ''} ${event.fullText ?? ''}`;
    return actionCategoryMatchesRuntimeEvent(category, eventText);
  });
  const runtimeOwner = nextRuntimeEvent
    ? skillSegmentForEvidenceRef(evidenceRefFromTimeline(nextRuntimeEvent), skillSegments)
    : undefined;
  return runtimeOwner ? { segment: runtimeOwner, reason: 'action_match' } : undefined;
}

function feedbackActionCategory(text: string): 'delete' | 'pull' | 'preview' | 'review' | 'stop' | undefined {
  if (/删除|删掉|remove|delete|rm\s/.test(text)) return 'delete';
  if (/拉下|拉取|pull|fetch|checkout|分支/.test(text)) return 'pull';
  if (/预览|链接|端口|打开|url/.test(text)) return 'preview';
  if (/看下|review|检查|确认|否决|补充|更新|执行流程|skill/.test(text)) return 'review';
  if (/停止|暂停|中断|stop|cancel/.test(text)) return 'stop';
  return undefined;
}

function actionCategoryMatchesRuntimeEvent(category: ReturnType<typeof feedbackActionCategory>, eventText: string): boolean {
  if (!category) return false;
  const lower = eventText.toLowerCase();
  if (category === 'delete') return /\brm\b|delete|remove|unlink|删除/.test(lower);
  if (category === 'pull') return /git\s+(?:pull|fetch|checkout|switch)|拉取|拉下|分支/.test(lower);
  if (category === 'preview') return /preview|localhost|127\.0\.0\.1|端口|server|vite|python3.*server|npm.*dev/.test(lower);
  if (category === 'review') return /skill|review|grep|rg|read|sed|cat|检查|确认|否决|补充|更新/.test(lower);
  if (category === 'stop') return /kill|stop|cancel|interrupt|停止|中断/.test(lower);
  return false;
}

function shouldUseWindowFeedbackOwner(segment: ExperienceSkillSegment, text: string): boolean {
  if (segment.skillType !== 'delegation' && segment.episodeRole !== 'delegator') return true;
  return /子\s*(?:claude|codex|agent|代理|智能体)|subagent|sub-agent|child|runner|ttyd|session|thread|agent|有结论|进度|怎么样了|没返回|通知|同步|跑完|完成了吗/i.test(text);
}

function dedupeFeedbackAttributions(attributions: ExperienceFeedbackAttribution[]): ExperienceFeedbackAttribution[] {
  const seen = new Set<string>();
  const out: ExperienceFeedbackAttribution[] = [];
  for (const attribution of attributions) {
    const key = `${attribution.skillSegmentId ?? attribution.skillName ?? ''}:${attribution.attributionRole}:${attribution.reasonCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attribution);
  }
  return out;
}

function feedbackAttributionReasonForText(lowerText: string): ExperienceFeedbackAttributionReason {
  if (/pr|pull request|master|分支|组件|产物|文档|报告|demo|链接|地址|文件|项目|skill|agent|subagent|claude|codex/.test(lowerText)) {
    return 'object_match';
  }
  if (/有结论|进度|没返回|通知|返回|同步|发给|给我|怎么样了|还在线|完成了吗|跑完/.test(lowerText)) {
    return 'promise_match';
  }
  if (/停止|暂停|中断|别动|删除|补充|追加|继续|重跑|重新|修正|更新|拉下|看下|执行|检查|确认|否决|采用|弃用/.test(lowerText)) {
    return 'action_match';
  }
  return 'episode_context';
}

function skillSegmentForEvidenceRef(
  evidenceRef: ExperienceEvidenceRef,
  skillSegments: ExperienceSkillSegment[],
  preferredSkillName?: string,
): ExperienceSkillSegment | undefined {
  const messageIndex = evidenceRef.messageIndex;
  if (typeof messageIndex !== 'number') return undefined;
  const candidates = skillSegments
    .map((segment) => {
      const ranges = segment.messageRanges?.length
        ? segment.messageRanges
        : typeof segment.startMessageIndex === 'number' && typeof segment.endMessageIndex === 'number'
          ? [{ startMessageIndex: segment.startMessageIndex, endMessageIndex: segment.endMessageIndex }]
          : [];
      const matchedRange = ranges.find((range) =>
        messageRangeContainsEvidenceRef(range, evidenceRef)
      );
      return matchedRange ? {
        segment,
        rangeSize: matchedRange.endMessageIndex - matchedRange.startMessageIndex,
        traceSpecificity: messageRangeTraceSpecificity(matchedRange, evidenceRef),
        preferred: preferredSkillName ? segment.skillName === preferredSkillName : false,
        startsHere: messageIndex === matchedRange.startMessageIndex,
      } : undefined;
    })
    .filter((value): value is { segment: ExperienceSkillSegment; rangeSize: number; traceSpecificity: number; preferred: boolean; startsHere: boolean } => Boolean(value))
    .sort((a, b) =>
      Number(b.preferred) - Number(a.preferred)
      || b.traceSpecificity - a.traceSpecificity
      || Number(b.startsHere) - Number(a.startsHere)
      || a.rangeSize - b.rangeSize
      || a.segment.order - b.segment.order
    );
  return candidates[0]?.segment;
}

function messageRangeContainsEvidenceRef(
  range: ExperienceMessageRange,
  ref: Pick<ExperienceEvidenceRef, 'messageIndex' | 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (typeof ref.messageIndex !== 'number') return false;
  if (range.traceId && ref.traceId && range.traceId !== ref.traceId) return false;
  if (range.sourceTrace && ref.sourceTrace && range.sourceTrace !== ref.sourceTrace) return false;
  if (range.sessionId && ref.sessionId && range.sessionId !== ref.sessionId) return false;
  return ref.messageIndex >= range.startMessageIndex && ref.messageIndex <= range.endMessageIndex;
}

function messageRangeTraceSpecificity(
  range: ExperienceMessageRange,
  ref: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
): number {
  return (range.traceId && ref.traceId && range.traceId === ref.traceId ? 4 : 0)
    + (range.sourceTrace && ref.sourceTrace && range.sourceTrace === ref.sourceTrace ? 2 : 0)
    + (range.sessionId && ref.sessionId && range.sessionId === ref.sessionId ? 1 : 0);
}

function evidenceRefsShareTraceScope(
  a?: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
  b?: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (!a || !b) return true;
  if (a.traceId && b.traceId && a.traceId !== b.traceId) return false;
  if (a.sourceTrace && b.sourceTrace && a.sourceTrace !== b.sourceTrace) return false;
  if (a.sessionId && b.sessionId && a.sessionId !== b.sessionId) return false;
  return true;
}

function timelineEventSharesTraceScope(
  event: Pick<ExperienceTimelineEvent, 'traceId' | 'sourceTrace' | 'sessionId'>,
  anchor?: Pick<ExperienceTimelineEvent, 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  return evidenceRefsShareTraceScope(event, anchor);
}

function skillSegmentsSharePhysicalTrace(a: ExperienceSkillSegment, b: ExperienceSkillSegment): boolean {
  const aTraceIds = new Set((a.messageRanges ?? []).map((range) => range.traceId).filter((value): value is string => Boolean(value)));
  const bTraceIds = new Set((b.messageRanges ?? []).map((range) => range.traceId).filter((value): value is string => Boolean(value)));
  if (aTraceIds.size > 0 && bTraceIds.size > 0) {
    return Array.from(aTraceIds).some((traceId) => bTraceIds.has(traceId));
  }
  const aTraces = new Set((a.messageRanges ?? []).map((range) => range.sourceTrace).filter((value): value is string => Boolean(value)));
  const bTraces = new Set((b.messageRanges ?? []).map((range) => range.sourceTrace).filter((value): value is string => Boolean(value)));
  if (aTraces.size === 0 || bTraces.size === 0) return true;
  return Array.from(aTraces).some((trace) => bTraces.has(trace));
}

function sessionStoryArtifacts(invocations: ExperienceInvocation[]): ExperienceEpisodeArtifact[] {
  const timeline = uniqueTimelineEvents(invocations.flatMap((invocation) => invocation.timeline))
    .sort(compareTimelineEvents);
  return timeline
    .filter((event) => event.kind === 'assistant_message' && hasAssistantDeliverableArtifactText(event.fullText ?? event.snippet ?? ''))
    .slice(-5)
    .map((event) => {
      const text = event.snippet ?? event.fullText ?? '';
      const pathOrUrl = text.match(/https?:\/\/\S+/)?.[0]
        ?? text.match(/(?:outputs|reports|dist|docs|artifacts|\/tmp|\/Users)\/[^\s`，。)）]+/i)?.[0];
      return {
        kind: pathOrUrl?.startsWith('http') ? 'url' as const : pathOrUrl ? 'path' as const : 'unknown' as const,
        label: pathOrUrl ?? text.slice(0, 80),
        pathOrUrl,
        artifactGoalMatch: 'unknown' as const,
        evidenceRef: evidenceRefFromTimeline(event),
      };
    });
}

function sessionStoryOutcomeClosure(session: ExperienceSessionSummary, artifacts: ExperienceEpisodeArtifact[]): ExperienceOutcomeClosure {
  if (session.indicators.userInterruptionCount > 0) return 'abandoned';
  if (session.indicators.assistantDeliverySignalCount > 0 || artifacts.length > 0) return 'closed';
  if (session.indicators.userFollowUpCount > 0 || session.indicators.negativeFeedbackCount > 0 || session.indicators.userCorrectionCount > 0) return 'unresolved';
  return 'unknown';
}

function sessionStoryAcceptanceCriteria(
  session: ExperienceSessionSummary,
  feedbackSignals: ExperienceFeedbackSignal[],
  artifacts: ExperienceEpisodeArtifact[],
): string | undefined {
  if (feedbackSignals.some((signal) => signal.attributions.some((attribution) => attribution.attributionRole === 'primary_fault'))) {
    return '下次同类任务中，主要归因的用户反馈应消失，且对应 skill 段能看到明确闭环或阻塞原因。';
  }
  if (artifacts.length === 0 && session.indicators.assistantDeliverySignalCount === 0) {
    return '下次同类任务中，应看到明确最终答复、产物路径，或清晰的阻塞说明。';
  }
  return undefined;
}

function sessionStoryGoalSlices(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStoryGoalSlice[] {
  const byId = new Map<string, ExperienceInvocation[]>();
  for (const invocation of invocations) {
    const group = byId.get(invocation.goalSliceId) ?? [];
    group.push(invocation);
    byId.set(invocation.goalSliceId, group);
  }
  return Array.from(byId.entries()).map(([id, group], index) => {
    const timeline = uniqueTimelineEvents(group.flatMap((invocation) => invocation.timeline)).sort(compareTimelineEvents);
    const userEvents = timeline.filter((event) => event.kind === 'user_message');
    const timestampedInvocations = group.filter(invocationTimestampObserved);
    const startTimestamp = minString(
      timestampedInvocations.map((invocation) => invocation.startTimestamp),
    ) ?? session.startTimestamp;
    const endTimestamp = maxString(
      timestampedInvocations.map((invocation) => invocation.endTimestamp),
    ) ?? session.endTimestamp;
    const hasGoalShift = userEvents.some((event) => hasUserGoalShiftSignal(event.snippet ?? ''));
    const reasonCode: ExperienceGoalSliceReasonCode = hasGoalShift
      ? 'explicit_user_goal_shift'
      : group.length > 1 ? 'skill_segment_boundary' : 'default_session_slice';
    return {
      id,
      order: index + 1,
      skillNames: unique(group.map((invocation) => invocation.skillName)).sort(),
      startTimestamp,
      endTimestamp,
      reasonCode,
      inferredUserGoal: inferUserGoal(userEvents),
      evidenceRefs: userEvents.slice(0, 3).map(evidenceRefFromTimeline),
    };
  }).sort((a, b) => {
    const aObserved = a.startTimestamp !== UNOBSERVED_TRACE_TIMESTAMP;
    const bObserved = b.startTimestamp !== UNOBSERVED_TRACE_TIMESTAMP;
    return Number(bObserved) - Number(aObserved)
      || a.startTimestamp.localeCompare(b.startTimestamp);
  });
}

function sessionStorySubagentDispatches(session: ExperienceSessionSummary): ExperienceSessionStorySubagentDispatch[] {
  const branches = session.timelineTree?.branches ?? [];
  return branches.map((branch, index) => ({
    id: hashParts('session-story-dispatch', session.id, branch.id),
    order: index + 1,
    branchId: branch.id,
    childSessionId: branch.sessionId,
    traceId: branch.traceId ?? branch.sourceTrace,
    label: branch.label,
    sourceTrace: branch.sourceTrace,
    attachTo: branch.attachTo ? {
      messageIndex: branch.attachTo.messageIndex,
      callInstanceId: branch.attachTo.callInstanceId,
      toolUseId: branch.attachTo.toolUseId,
      label: branch.attachTo.label,
    } : undefined,
    eventCount: branch.events.length,
    evidenceRefs: branch.events.slice(0, 3).map(evidenceRefFromTimeline),
  }));
}

function sessionStorySkillLinks(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStorySkillLink[] {
  const bySkill = new Map<string, ExperienceInvocation[]>();
  for (const invocation of invocations) {
    const group = bySkill.get(invocation.skillName) ?? [];
    group.push(invocation);
    bySkill.set(invocation.skillName, group);
  }
  return Array.from(bySkill.entries()).map(([skillName, group], index) => {
    const role = inferSkillRole(group, invocations, session);
    return {
      id: hashParts('session-story-skill-link', session.id, skillName),
      order: index + 1,
      skillName,
      role,
      invocationIds: group.map((invocation) => invocation.id),
      goalSliceIds: unique(group.map((invocation) => invocation.goalSliceId)),
      evidenceRefs: uniqueEvidenceRefs(group.flatMap((invocation) => [
        invocation.evidenceChain.firstSkillContext,
        invocation.evidenceChain.firstToolUse,
        ...routingEvidenceEvents(invocation).map(evidenceRefFromTimeline),
      ].filter((ref): ref is ExperienceEvidenceRef => Boolean(ref)))).slice(0, 5),
    };
  }).sort((a, b) => a.order - b.order);
}

function inferSkillRole(group: ExperienceInvocation[], allInvocations: ExperienceInvocation[], session: ExperienceSessionSummary): ExperienceSessionStorySkillRole {
  const hasRoutingSignal = group.some((invocation) => routingEvidenceEvents(invocation).length > 0);
  const hasBranchDispatch = (session.timelineTree?.branches.length ?? 0) > 0 && group.some((invocation) =>
    invocation.timeline.some((event) =>
      isOrchestrationRuntimeEvent(event)
      || isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
  );
  const hasExecutionSignal = group.some((invocation) =>
    invocation.timeline.some((event) =>
      event.kind === 'tool_use'
      && !isOrchestrationRuntimeEvent(event)
      && !isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
  );
  if ((hasRoutingSignal || hasBranchDispatch) && allInvocations.length > group.length) return hasExecutionSignal ? 'mixed' : 'router';
  if (hasRoutingSignal || hasBranchDispatch) return 'router';
  if (hasExecutionSignal) return 'executor';
  return 'unknown';
}

function routingEvidenceEvents(invocation: ExperienceInvocation): ExperienceTimelineEvent[] {
  return invocation.timeline
    .filter((event) =>
      isOrchestrationRuntimeEvent(event)
      || isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
    .slice(0, 3);
}

function isDifferentSkillInvocationEvent(
  event: ExperienceTimelineEvent,
  currentSkillName: string,
): boolean {
  if (event.kind !== 'tool_use' || !/^Skill$/i.test(event.toolName ?? '')) return false;
  const text = event.fullText ?? event.snippet ?? '';
  let targetSkill: string | undefined;
  try {
    const input: unknown = JSON.parse(text);
    if (isObjectRecord(input)) {
      targetSkill = typeof input.skill === 'string'
        ? input.skill
        : typeof input.name === 'string'
          ? input.name
          : undefined;
    }
  } catch {
    targetSkill = text.match(
      /["']?(?:skill|name)["']?\s*[:=]\s*["']?([a-z0-9][\w.-]*)/i,
    )?.[1];
  }
  return Boolean(
    targetSkill
    && targetSkill.trim().toLowerCase() !== currentSkillName.trim().toLowerCase(),
  );
}

function skillRoleLabel(role: ExperienceSessionStorySkillRole): string {
  if (role === 'router') return '路由';
  if (role === 'executor') return '执行';
  if (role === 'mixed') return '路由 + 执行';
  return '未确认';
}

function sessionStoryGraph(
  nodes: ExperienceSessionStoryNode[],
  skillLinks: ExperienceSessionStorySkillLink[],
): ExperienceSessionStory['graph'] {
  const graphNodes: ExperienceSessionStoryGraphNode[] = nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    status: node.status,
    detailNodeId: node.id,
  }));
  for (const link of skillLinks) {
    graphNodes.push({
      id: link.id,
      label: `${link.skillName}（${skillRoleLabel(link.role)}）`,
      kind: 'skill_invocation',
      status: link.role === 'unknown' ? 'unknown' : 'ok',
      role: link.role,
    });
  }
  const edges: ExperienceSessionStoryGraphEdge[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    edges.push({ fromId: nodes[index - 1].id, toId: nodes[index].id, label: '下一步' });
  }
  const goalNode = nodes.find((node) => node.kind === 'user_goal');
  const executionNode = nodes.find((node) => node.kind === 'tool_execution');
  if (goalNode && executionNode) {
    for (const link of skillLinks) {
      edges.push({ fromId: goalNode.id, toId: link.id, label: '触发' });
      edges.push({ fromId: link.id, toId: executionNode.id, label: skillRoleLabel(link.role) });
    }
  }
  return { nodes: graphNodes, edges };
}

function sessionStoryAnswer(
  key: ExperienceSessionStoryAnswerKey,
  label: string,
  checklistItems: ExperienceChecklistItem[],
  evidenceRefs: Array<ExperienceEvidenceRef | undefined>,
): ExperienceSessionStoryAnswer {
  const folded = foldExperienceChecklistItems(checklistItems);
  return {
    key,
    label,
    status: folded.status,
    reason: folded.reason,
    sourceItemKeys: folded.sourceItemKeys,
    text: sessionStoryAnswerText(key, folded.reason),
    evidenceRefs: uniqueEvidenceRefs(evidenceRefs.filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))).slice(0, 5),
    checklistItems,
  };
}

function sessionStoryAnswerText(key: ExperienceSessionStoryAnswerKey, reason: ExperienceParentReason): string {
  const texts: Record<ExperienceSessionStoryAnswerKey, Record<ExperienceParentReason, string>> = {
    goal_satisfaction: {
      data_degraded: '这次没看到 skill 真的被加载，先确认数据，再判断目标是否满足。',
      blocking_failed: '用户出现了不满或叫停，目标没真的满足。',
      attention_accumulated: '有几条要看一眼，打开原文确认目标是否真的达成。',
      unknown_dominant: '现有证据不够，判断不了目标是否满足。',
      all_passed: '关键信号都没问题，看起来目标已满足。',
      not_applicable: '当前场景不适合回答这个问题。',
    },
    declared_behavior_fit: {
      data_degraded: '没看到 skill 真的被加载，先确认这次任务是不是真的命中了你的 skill。',
      blocking_failed: '关键执行项没过，skill 行为需要优先看一眼。',
      attention_accumulated: 'SKILL.md 声明的标准流程、硬性规则或核心工具有几条要看一眼。',
      unknown_dominant: 'SKILL.md 声明不全或执行证据不够，判不出行为是否符合用途。',
      all_passed: '执行情况看起来符合 skill 声明的用途。',
      not_applicable: '当前场景不适合回答这个问题。',
    },
    user_feeling: {
      data_degraded: '这次数据本身有问题，用户感受判断先放一放。',
      blocking_failed: '看到用户不满或主动叫停，可能觉得没用或绕路了。',
      attention_accumulated: '看到用户纠正或追问，结合原文判断用户感受。',
      unknown_dominant: '用户没给明确反馈，判断不了是否觉得有用。',
      all_passed: '没看到明显不满，用户体感看起来正常。',
      not_applicable: '当前场景不适合回答这个问题。',
    },
  };
  return texts[key][reason];
}

function checklistItemsForAnswer(
  session: ExperienceSessionSummary,
  key: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
  reviewState?: ObservationReviewState,
): ExperienceChecklistItem[] {
  if (key === 'goal_satisfaction') return goalSatisfactionChecklistItems(session, episodes, reviewState);
  if (key === 'declared_behavior_fit') return declaredBehaviorChecklistItems(session, episodes);
  return userFeelingChecklistItems(session, episodes, reviewState);
}

function attributionSourcesToLabel(sources: string[]): string {
  if (sources.length === 0) return '未识别（旧数据可能没记录来源）';
  const map: Record<string, string> = {
    'skill-tool': 'assistant 调用 Skill 工具',
    'command-name': '用户用 slash command',
    'business-action': '用户用业务动作块',
    [legacyBusinessActionSource()]: '用户用业务动作块',
    'skill-script': '跑了 skills/<name>/scripts 脚本',
    'read-skill-md': 'LLM 主动 Read SKILL.md',
    unknown: '未知',
  };
  return sources.map((s) => map[s] ?? s).join(' + ');
}

export function isExperienceTraceInProgress(session: ExperienceSessionSummary): boolean {
  if (session.indicators.assistantDeliverySignalCount > 0) return false;
  if (session.indicators.deliverableArtifactSignalCount > 0) return false;
  // 用户已经主动表达不满（纠正 / 负向 / 中断）属于「被打断」, 不是「在途中」, 仍需触发 final_delivery_absent。
  if (session.indicators.userCorrectionCount > 0) return false;
  if (session.indicators.negativeFeedbackCount > 0) return false;
  if (session.indicators.userInterruptionCount > 0) return false;
  const last = session.evidenceChain.lastAssistantMessage?.snippet ?? '';
  // 完全没有最后助手回复时不强判 in-progress, 走原 failed / unknown 路径。
  if (!last.trim()) return false;
  if (isAssistantProgressUpdateText(last)) return true;
  // 预备语（让我看 / 先看看 / 先读 / 接下来）也算 in-progress, 仍未给出最终回复。
  return /让我(?:先|来|看|读|检查|分析|确认|拉|获取|继续)|先(?:看(?:看|一?下)|读(?:取|一下)?|确认|检查|分析|拉取|获取)|接下来/i.test(last);
}

function checklistItem(input: Omit<ExperienceChecklistItem, 'source' | 'evidenceRefs'> & {
  evidenceRefs?: Array<ExperienceEvidenceRef | undefined>;
  source?: ExperienceReviewerReportFindingSource;
  statusCandidates?: ExperienceChecklistItemStatus[];
}): ExperienceChecklistItem {
  const { statusCandidates, ...item } = input;
  return {
    ...item,
    status: aggregateExperienceChecklistItemStatus([input.status, ...(statusCandidates ?? [])]),
    source: input.source ?? 'deterministic_rule',
    evidenceRefs: uniqueEvidenceRefs((input.evidenceRefs ?? []).filter((ref): ref is ExperienceEvidenceRef => Boolean(ref))).slice(0, 5),
  };
}

export function hasRecognizableUserGoalText(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  if (!text) return false;
  if (/^(嗯+|啊+|好的|好|继续|可以|收到|ok|OK|yes|no|不用|不需要)[。.!！?？\s]*$/.test(text)) return false;
  if (/(帮我|请|需要|想要|我要|给我|看下|看一下|基于|根据|重新|继续|先|把|将)/.test(text)
    && /(生成|创建|写|实现|修复|优化|调整|修改|新增|删除|分析|review|评价|检查|看|拉取|执行|运行|验证|整理|总结|回复|评论|设计|拆分|合并|标注|定位|排查|上传|导出|发布|查询|对齐|沉淀|补充|改|做)/i.test(text)) {
    return true;
  }
  if (/(生成|创建|写一个|实现|修复|优化|调整|修改|新增|分析|review|检查|排查|验证|总结|设计|标注|定位|查询|对齐|补充|改一下|做一个)/i.test(text)) return true;
  return text.length >= 12 && /[？?]/.test(text) && !/^(为什么|怎么|哪里)[？?]?$/.test(text);
}

function hasRecognizableUserGoal(ref?: ExperienceEvidenceRef): boolean {
  return hasRecognizableUserGoalText(ref?.snippet);
}

function goalSatisfactionChecklistItems(session: ExperienceSessionSummary, episodes?: ExperienceEpisode[], reviewState?: ObservationReviewState): ExperienceChecklistItem[] {
  const feedbackRefs = userFeedbackEvidenceRefs(session);
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  const goalIdentified = hasRecognizableUserGoal(session.evidenceChain.firstUserMessage);
  const inProgress = isExperienceTraceInProgress(session);
  const closure = userFacingClosureForSession(session, episodes);
  const hasDelivery = closure.deliveryCount > 0;
  const hasArtifact = closure.artifactCount > 0;
  return [
    checklistItem({
      key: 'goal_identified',
      label: goalIdentified ? '目标已识别' : '目标不明确',
      status: goalIdentified ? 'passed' : 'unknown',
      contribution: 'informational',
      reason: goalIdentified
        ? '真实用户原文里能识别出目标动作或明确请求。'
        : session.evidenceChain.firstUserMessage ? '看到真实用户原文，但目标动作不够明确。' : '没有看到真实用户目标原文。',
      evidenceRefs: [session.evidenceChain.firstUserMessage],
    }),
    checklistItem({
      key: 'completion_result_present',
      label: hasDelivery ? '给了用户最终答复' : inProgress ? '会话进行中' : '没给用户最终答复',
      status: hasDelivery ? 'passed' : inProgress ? 'not_applicable' : 'failed',
      contribution: hasDelivery ? 'attention' : inProgress ? 'neutral' : 'attention',
      reason: hasDelivery
        ? '看到 assistant 给出了明确的完成话术或结果反馈。'
        : inProgress
          ? '最后一句还是过程态（「先看看」「让我」），任务还没收尾，先不判定。'
          : '没看到 assistant 给用户明确的完成话术或结果反馈。'
,
      evidenceRefs: [session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasDelivery || inProgress ? undefined : 'final_delivery_absent',
    }),
    checklistItem({
      key: 'deliverable_artifact_present',
      label: hasArtifact ? '给了可点开的产物' : inProgress ? '会话进行中' : '没给可点开的产物',
      status: hasArtifact ? 'passed' : inProgress ? 'not_applicable' : 'unknown',
      contribution: hasArtifact ? 'informational' : inProgress ? 'neutral' : 'informational',
      reason: hasArtifact
        ? '看到 assistant 回复里附了链接、路径、代码块或文件。'
        : inProgress
          ? '任务还没收尾，先不判定产物。'
          : '没看到明确的链接、路径、代码块或文件；不一定失败，得按 skill 目标判断。',
      evidenceRefs: [session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasArtifact || inProgress ? undefined : 'artifact_absent',
    }),
    checklistItem({
      key: 'negative_feedback_seen',
      label: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向反馈' : '未见用户负向反馈',
      status: feedbackCounts.negativeFeedbackCount > 0 ? 'failed' : 'passed',
      contribution: 'blocking',
      reason: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向表达，不能直接认为目标已满足。' : '没有看到用户负向表达。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.negativeFeedbackCount > 0 ? 'negative_feedback_review' : undefined,
    }),
    checklistItem({
      key: 'user_correction_seen',
      label: feedbackCounts.userCorrectionCount > 0 ? '看到用户纠正' : '未见用户纠正',
      status: feedbackCounts.userCorrectionCount > 0 ? 'failed' : 'passed',
      contribution: 'attention',
      reason: feedbackCounts.userCorrectionCount > 0 ? '用户中途纠正了方向，目标是否满足要打开原文看。' : '没有看到用户纠正。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userCorrectionCount > 0 ? 'user_correction_review' : undefined,
    }),
    checklistItem({
      key: 'user_interruption_seen',
      label: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断' : '未见用户中断',
      status: feedbackCounts.userInterruptionCount > 0 ? 'failed' : 'passed',
      contribution: 'blocking',
      reason: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断或停止任务信号，不能认为执行链路自然完成。' : '没有看到用户中断信号。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userInterruptionCount > 0 ? 'user_interruption_review' : undefined,
    }),
    checklistItem({
      key: 'goal_shift_seen',
      label: session.indicators.userGoalShiftCount > 0 ? '看到目标切换' : '未见目标切换',
      status: session.indicators.userGoalShiftCount > 0 ? 'failed' : 'passed',
      contribution: 'attention',
      reason: session.indicators.userGoalShiftCount > 0 ? '用户中途切换了目标，后续诉求可能不属于这个 skill。' : '没有看到目标切换。',
      evidenceRefs: feedbackRefs,
      suggestionKey: session.indicators.userGoalShiftCount > 0 ? 'goal_shift_review' : undefined,
    }),
    ...skillTypeClosureChecklistItems(session, 'goal_satisfaction', episodes),
  ];
}

function declaredBehaviorChecklistItems(session: ExperienceSessionSummary, episodes?: ExperienceEpisode[]): ExperienceChecklistItem[] {
  const expectedToolCheck = expectedToolCheckForSession(session);
  const declarations = loadSkillDeclarationCheck(session.skillName, session.cwd);
  const hasSkillRead = session.evidenceChain.skillContextCount > 0;
  const attributionLabel = attributionSourcesToLabel(session.attributionSources ?? []);
  const items: ExperienceChecklistItem[] = [
    checklistItem({
      key: 'attribution_source',
      label: hasSkillRead
        ? 'LLM 读了 SKILL.md'
        : `skill 判定来源：${attributionLabel}`,
      status: 'passed',
      contribution: 'informational',
      reason: hasSkillRead
        ? `看到 ${session.evidenceChain.skillContextCount} 次 SKILL.md 加载事件，可作为能力归因证据。`
        : `日志里没看到 LLM 主动读取 SKILL.md。这次 skill 归因来自：${attributionLabel}。脚本、Skill 工具或命令触发时可能没有显式读取事件，不代表 skill 没用上。`,
      evidenceRefs: [session.evidenceChain.firstSkillContext, session.evidenceChain.firstToolUse],
    }),
    checklistItem({
      key: 'workflow_declared',
      label: declarations.workflows.declared ? '标准流程已声明' : '标准流程未声明',
      status: declarations.workflows.declared ? 'passed' : 'not_declared',
      contribution: declarations.workflows.declared ? 'informational' : 'attention',
      reason: declarations.workflows.declared ? `SKILL.md 里声明了 ${declarations.workflows.count} 个标准流程节点。` : 'SKILL.md 没声明标准流程，运行时只能猜流程是否完整。',
      suggestionKey: declarations.workflows.declared ? undefined : 'workflow_not_declared',
    }),
  ];
  if (declarations.workflows.declared) {
    const executed = session.indicators.toolCallCount > 0;
    items.push(checklistItem({
      key: 'workflow_executed',
      label: executed ? '标准流程已执行' : '标准流程未执行',
      status: executed ? 'unknown' : 'failed',
      contribution: 'attention',
      reason: executed ? '看到了工具调用，但是不是真的覆盖了完整流程，还要打开原文确认。' : '声明了标准流程，但没看到工具执行的证据。',
      evidenceRefs: [session.evidenceChain.firstToolUse],
      suggestionKey: 'workflow_execution_review',
    }));
  }
  items.push(checklistItem({
    key: 'hardrule_declared',
    label: declarations.hardRules.declared ? '硬性规则已声明' : '硬性规则未声明',
    status: declarations.hardRules.declared ? 'passed' : 'not_declared',
    contribution: declarations.hardRules.declared ? 'informational' : 'attention',
    reason: declarations.hardRules.declared ? `SKILL.md 里声明了 ${declarations.hardRules.count} 条硬性规则。` : 'SKILL.md 没声明硬性规则。',
    suggestionKey: declarations.hardRules.declared ? undefined : 'hardrule_not_declared',
  }));
  if (declarations.hardRules.declared) {
    items.push(checklistItem({
      key: 'hardrule_executed',
      label: '硬性规则执行情况需打开原文看',
      status: 'unknown',
      contribution: 'attention',
      reason: '声明了硬性规则，但当前规则没法完整证明每条都执行了，要打开原文看。',
      suggestionKey: 'hardrule_execution_review',
    }));
  }
  items.push(checklistItem({
    key: 'core_tools_declared',
    label: expectedToolCheck.declared ? '核心工具已声明' : '核心工具未声明',
    status: expectedToolCheck.declared ? 'passed' : 'not_declared',
    contribution: expectedToolCheck.declared ? 'informational' : 'attention',
    reason: expectedToolCheck.declared ? `SKILL.md 声明的核心工具：${expectedToolCheck.expectedTools.join('、')}。` : 'SKILL.md 没声明核心工具，分不出「真用上了 skill 工具」还是「只是随便调了个工具」。',
    suggestionKey: expectedToolCheck.declared ? undefined : 'expected_tools_not_declared',
  }));
  if (expectedToolCheck.declared) {
    const hit = expectedToolCheck.matchedTools.length > 0;
    items.push(checklistItem({
      key: 'core_tools_hit',
      label: hit ? '核心工具用上了' : '核心工具没用上',
      status: hit ? 'passed' : 'failed',
      contribution: 'blocking',
      reason: hit ? `用上了核心工具：${expectedToolCheck.matchedTools.join('、')}。` : '没用上 SKILL.md 声明的核心工具。',
      evidenceRefs: [session.evidenceChain.firstToolUse],
      suggestionKey: hit ? undefined : 'expected_tools_missed',
    }));
  }
  items.push(...skillTypeClosureChecklistItems(session, 'declared_behavior_fit', episodes));
  return items;
}

function userFeelingChecklistItems(session: ExperienceSessionSummary, episodes?: ExperienceEpisode[], reviewState?: ObservationReviewState): ExperienceChecklistItem[] {
  const feedbackRefs = userFeedbackEvidenceRefs(session);
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  const hasAnyFeedback = feedbackCounts.positiveFeedbackCount > 0
    || feedbackCounts.negativeFeedbackCount > 0
    || feedbackCounts.userCorrectionCount > 0
    || feedbackCounts.userInterruptionCount > 0
    || feedbackCounts.userFollowUpCount > 0
    || session.indicators.userGoalShiftCount > 0;
  return [
    checklistItem({
      key: 'user_feedback_signal_present',
      label: hasAnyFeedback ? '看到用户反馈信号' : '未见用户反馈信号',
      status: hasAnyFeedback ? 'passed' : 'unknown',
      contribution: 'informational',
      reason: hasAnyFeedback ? '看到至少一种用户反馈或后续行为信号。' : '没有看到明确用户反馈信号。',
      evidenceRefs: feedbackRefs,
    }),
    checklistItem({
      key: 'positive_feedback_seen',
      label: feedbackCounts.positiveFeedbackCount > 0 ? '看到用户正向反馈' : '未见用户正向反馈',
      status: feedbackCounts.positiveFeedbackCount > 0 ? 'passed' : 'unknown',
      contribution: feedbackCounts.positiveFeedbackCount > 0 ? 'positive' : 'neutral',
      reason: feedbackCounts.positiveFeedbackCount > 0 ? '看到用户认可或正向反馈。' : '没有看到明确正向反馈。',
      evidenceRefs: feedbackRefs,
    }),
    checklistItem({
      key: 'negative_feedback_seen',
      label: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向反馈' : '未见用户负向反馈',
      status: feedbackCounts.negativeFeedbackCount > 0 ? 'failed' : 'passed',
      contribution: feedbackCounts.negativeFeedbackCount > 0 ? 'blocking' : 'neutral',
      reason: feedbackCounts.negativeFeedbackCount > 0 ? '看到用户负向表达。' : '没有看到用户负向表达。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.negativeFeedbackCount > 0 ? 'negative_feedback_review' : undefined,
    }),
    checklistItem({
      key: 'user_correction_seen',
      label: feedbackCounts.userCorrectionCount > 0 ? '看到用户纠正' : '未见用户纠正',
      status: feedbackCounts.userCorrectionCount > 0 ? 'failed' : 'passed',
      contribution: feedbackCounts.userCorrectionCount > 0 ? 'attention' : 'neutral',
      reason: feedbackCounts.userCorrectionCount > 0 ? '看到用户重新解释或要求修正。' : '没有看到用户纠正信号。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userCorrectionCount > 0 ? 'user_correction_review' : undefined,
    }),
    checklistItem({
      key: 'user_follow_up_seen',
      label: feedbackCounts.userFollowUpCount > 0 ? '看到用户追问' : '未见用户追问',
      status: feedbackCounts.userFollowUpCount > 0 ? 'unknown' : 'passed',
      contribution: feedbackCounts.userFollowUpCount > 0 ? 'informational' : 'neutral',
      reason: feedbackCounts.userFollowUpCount > 0 ? '看到用户追问；需要结合上下文区分推进使用还是不满意。' : '没有看到用户追问。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userFollowUpCount > 0 ? 'follow_up_review' : undefined,
    }),
    checklistItem({
      key: 'user_interruption_seen',
      label: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断' : '未见用户中断',
      status: feedbackCounts.userInterruptionCount > 0 ? 'failed' : 'passed',
      contribution: feedbackCounts.userInterruptionCount > 0 ? 'blocking' : 'neutral',
      reason: feedbackCounts.userInterruptionCount > 0 ? '看到用户中断或停止任务信号。' : '没有看到用户中断信号。',
      evidenceRefs: feedbackRefs,
      suggestionKey: feedbackCounts.userInterruptionCount > 0 ? 'user_interruption_review' : undefined,
    }),
    ...skillTypeClosureChecklistItems(session, 'user_feeling', episodes),
  ];
}

function skillTypeClosureChecklistItems(
  session: ExperienceSessionSummary,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  const runtime = currentSkillRuntimeModel(session, episodes);
  if (!runtime) return [];
  if (runtime.skillType === 'workflow_owner') return workflowOwnerClosureChecklistItems(session, runtime, answerKey, episodes);
  if (runtime.skillType === 'router' || runtime.hasDownstreamEdges) return routerClosureChecklistItems(session, runtime, answerKey, episodes);
  if (runtime.skillType === 'delegation' || runtime.isDelegator) return delegationClosureChecklistItems(session, runtime, answerKey, episodes);
  if (runtime.skillType === 'executor') return executorClosureChecklistItems(session, runtime, answerKey);
  if (runtime.skillType === 'advisory') return advisoryClosureChecklistItems(session, runtime, answerKey);
  return [];
}

function workflowOwnerClosureChecklistItems(
  session: ExperienceSessionSummary,
  runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  if (answerKey === 'declared_behavior_fit') {
    const hasStages = runtime.segments.some((segment) =>
      (segment.typeSpecificChecklist ?? []).some((item) => /stage|阶段|workflow/i.test(`${item.key} ${item.label}`))
    );
    return [
      checklistItem({
        key: 'workflow_owner_stage_matrix_declared',
        label: hasStages ? '看到阶段矩阵线索' : '未看到阶段矩阵声明',
        status: hasStages ? 'passed' : 'unknown',
        contribution: 'attention',
        reason: hasStages
          ? '当前 workflow_owner skill 有阶段化检查线索。'
          : 'workflow_owner 需要声明标准阶段矩阵，才能复盘每个阶段是否闭环。',
        evidenceRefs: runtime.segments.flatMap((segment) => segment.evidenceRefs),
        suggestionKey: hasStages ? undefined : 'workflow_owner_stage_matrix_absent',
      }),
    ];
  }
  if (answerKey === 'goal_satisfaction') {
    const closure = userFacingClosureForSession(session, episodes);
    const hasClosure = closure.deliveryCount > 0 || closure.artifactCount > 0;
    return [
      checklistItem({
        key: 'workflow_owner_stage_closure',
        label: hasClosure ? '看到流程闭环线索' : '未看到流程闭环线索',
        status: hasClosure ? 'passed' : runtime.primarySignals.length > 0 || runtime.downstreamSignals.length > 0 ? 'failed' : 'unknown',
        contribution: 'attention',
        reason: hasClosure
          ? '看到最终答复或产物线索。'
          : 'workflow_owner 需要回收各阶段状态，说明哪些阶段完成、失败或跳过。',
        evidenceRefs: [session.evidenceChain.lastAssistantMessage, ...runtime.primarySignals.map((signal) => signal.evidenceRef), ...runtime.downstreamSignals.map((signal) => signal.evidenceRef)],
        suggestionKey: hasClosure ? undefined : 'workflow_owner_stage_closure_absent',
      }),
    ];
  }
  if (answerKey === 'user_feeling') {
    return downstreamFeedbackRiskChecklistItems(runtime, 'workflow_owner_stage_feedback_seen', '流程阶段里出现用户追问或纠正');
  }
  return [];
}

function routerClosureChecklistItems(
  session: ExperienceSessionSummary,
  runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  if (answerKey === 'declared_behavior_fit') {
    return [
      checklistItem({
        key: 'router_route_selected',
        label: runtime.hasDownstreamEdges ? '路由已派发下游' : '未看到下游派发',
        status: runtime.hasDownstreamEdges ? 'passed' : 'unknown',
        contribution: 'attention',
        reason: runtime.hasDownstreamEdges
          ? '看到当前 skill 和下游执行 skill / child session 的链路。'
          : '没有看到当前 router skill 把任务派发到下游执行链路。',
        evidenceRefs: runtime.downstreamEdges.flatMap((edge) => edge.evidenceRefs),
        suggestionKey: runtime.hasDownstreamEdges ? undefined : 'router_downstream_link_absent',
      }),
      checklistItem({
        key: 'router_goal_preserved',
        label: '用户目标保真需复核',
        status: 'unknown',
        contribution: 'informational',
        reason: '规则层只能确认发生了派发，child prompt 是否完整保留用户目标需要结合原文或模型识别。',
        evidenceRefs: [session.evidenceChain.firstUserMessage, ...runtime.downstreamEdges.flatMap((edge) => edge.evidenceRefs)],
        suggestionKey: 'router_goal_preservation_review',
      }),
    ];
  }
  if (answerKey === 'goal_satisfaction') {
    const hasDownstreamRisk = runtime.downstreamSignals.length > 0;
    const closure = userFacingClosureForSession(session, episodes);
    const hasClosure = closure.deliveryCount > 0 || closure.artifactCount > 0;
    return [
      checklistItem({
        key: 'router_downstream_completed',
        label: hasClosure ? '看到用户侧闭环线索' : '未看到用户侧闭环线索',
        status: hasClosure ? 'passed' : hasDownstreamRisk ? 'failed' : 'unknown',
        contribution: 'attention',
        reason: hasClosure
          ? '看到当前链路里有最终答复或产物线索。'
          : hasDownstreamRisk
            ? '下游调用链路出现用户追问 / 纠正 / 中断，但当前路由能力视角没看到清晰闭环。'
            : '已看到派发，但还不能确认下游是否完成并回传。',
        evidenceRefs: [
          session.evidenceChain.lastAssistantMessage,
          ...runtime.downstreamSignals.map((signal) => signal.evidenceRef),
        ],
        suggestionKey: hasClosure ? undefined : 'router_user_facing_closure_absent',
      }),
    ];
  }
  if (answerKey === 'user_feeling') {
    return downstreamFeedbackRiskChecklistItems(runtime, 'router_downstream_feedback_seen', '下游调用链路用户有追问');
  }
  return [];
}

function delegationClosureChecklistItems(
  session: ExperienceSessionSummary,
  runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
  episodes?: ExperienceEpisode[],
): ExperienceChecklistItem[] {
  if (answerKey === 'declared_behavior_fit') {
    const hasChild = runtime.hasDownstreamEdges || session.timelineTree?.branches.length;
    return [
      checklistItem({
        key: 'delegation_child_lifecycle_tracked',
        label: hasChild ? '看到 child / 下游生命周期' : '未看到 child 生命周期',
        status: hasChild ? 'passed' : 'unknown',
        contribution: 'attention',
        reason: hasChild ? '看到 child session、下游 skill 或分支执行线索。' : '没有看到明确 child session 或下游执行线索。',
        evidenceRefs: runtime.downstreamEdges.flatMap((edge) => edge.evidenceRefs),
        suggestionKey: hasChild ? undefined : 'delegation_child_lifecycle_absent',
      }),
    ];
  }
  if (answerKey === 'goal_satisfaction') {
    const closure = userFacingClosureForSession(session, episodes);
    const hasResult = closure.deliveryCount > 0 || closure.artifactCount > 0;
    return [
      checklistItem({
        key: 'delegation_result_recovered',
        label: hasResult ? '已回收结果给用户' : '未看到结果回收',
        status: hasResult ? 'passed' : runtime.primarySignals.length > 0 ? 'failed' : 'unknown',
        contribution: 'attention',
        reason: hasResult ? '看到最终答复或产物线索。' : 'delegation skill 需要把 child 结果回收并告知用户。',
        evidenceRefs: [session.evidenceChain.lastAssistantMessage, ...runtime.primarySignals.map((signal) => signal.evidenceRef)],
        suggestionKey: hasResult ? undefined : 'delegation_result_recovery_absent',
      }),
    ];
  }
  if (answerKey === 'user_feeling') {
    return downstreamFeedbackRiskChecklistItems(runtime, 'delegation_downstream_feedback_seen', 'child 调用链路用户有反馈');
  }
  return [];
}

function executorClosureChecklistItems(
  session: ExperienceSessionSummary,
  _runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
): ExperienceChecklistItem[] {
  if (answerKey !== 'goal_satisfaction') return [];
  const hasExecution = session.indicators.toolCallCount > 0;
  const hasResult = session.indicators.assistantDeliverySignalCount > 0 || session.indicators.deliverableArtifactSignalCount > 0;
  return [
    checklistItem({
      key: 'executor_execution_to_result',
      label: hasExecution && hasResult ? '执行后有结果' : hasExecution ? '执行后结果不明确' : '未看到执行证据',
      status: hasExecution && hasResult ? 'passed' : hasExecution ? 'unknown' : 'failed',
      contribution: 'attention',
      reason: hasExecution && hasResult
        ? '看到工具执行和最终答复 / 产物线索。'
        : hasExecution
          ? '看到工具执行，但结果或产物闭环不清晰。'
          : 'executor 类型 skill 应能看到执行证据。',
      evidenceRefs: [session.evidenceChain.firstToolUse, session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasExecution && hasResult ? undefined : 'executor_result_closure_review',
    }),
  ];
}

function advisoryClosureChecklistItems(
  session: ExperienceSessionSummary,
  _runtime: CurrentSkillRuntimeModel,
  answerKey: ExperienceSessionStoryAnswerKey,
): ExperienceChecklistItem[] {
  if (answerKey !== 'goal_satisfaction') return [];
  const hasAnswer = session.indicators.assistantDeliverySignalCount > 0;
  return [
    checklistItem({
      key: 'advisory_answer_present',
      label: hasAnswer ? '已给分析结论' : '未看到分析结论',
      status: hasAnswer ? 'passed' : 'failed',
      contribution: 'attention',
      reason: hasAnswer ? '看到面向用户的分析结论或收尾回复。' : 'advisory 类型 skill 应给出清晰分析结论或阻塞说明。',
      evidenceRefs: [session.evidenceChain.lastAssistantMessage],
      suggestionKey: hasAnswer ? undefined : 'advisory_answer_absent',
    }),
  ];
}

function downstreamFeedbackRiskChecklistItems(
  runtime: CurrentSkillRuntimeModel,
  key: string,
  presentLabel: string,
): ExperienceChecklistItem[] {
  const riskSignals = runtime.downstreamSignals.filter((signal) =>
    signal.type === 'follow_up'
    || signal.type === 'correction'
    || signal.type === 'frustration'
    || signal.type === 'interruption'
  );
  return [
    checklistItem({
      key,
      label: riskSignals.length > 0 ? presentLabel : '未见下游反馈风险',
      status: riskSignals.length > 0 ? 'failed' : 'passed',
      contribution: riskSignals.length > 0 ? 'attention' : 'neutral',
      reason: riskSignals.length > 0
        ? `看到 ${riskSignals.length} 条下游相关的用户追问、纠正或中断；这不是当前 skill 的硬失败，但需要 owner 看下闭环。`
        : '没有看到下游相关的用户反馈风险。',
      evidenceRefs: riskSignals.map((signal) => signal.evidenceRef),
      suggestionKey: riskSignals.length > 0 ? 'downstream_feedback_review' : undefined,
    }),
  ];
}

export function foldExperienceChecklistItems(items: ExperienceChecklistItem[]): { status: ExperienceReviewerReportStepStatus; reason: ExperienceParentReason; sourceItemKeys: string[] } {
  const relevant = items.filter((item) => item.contribution !== 'neutral');
  const active = relevant.length > 0 ? relevant : items;
  const degraded = active.filter((item) => item.status === 'degraded');
  if (degraded.length > 0) return { status: 'degraded', reason: 'data_degraded', sourceItemKeys: degraded.map((item) => item.key) };

  const blockingFailed = active.filter((item) => item.contribution === 'blocking' && item.status === 'failed');
  if (blockingFailed.length > 0) return { status: 'attention', reason: 'blocking_failed', sourceItemKeys: blockingFailed.map((item) => item.key) };

  const attentionFailed = active.filter((item) => item.contribution === 'attention' && item.status === 'failed');
  if (attentionFailed.length > 0) return { status: 'attention', reason: 'attention_accumulated', sourceItemKeys: attentionFailed.map((item) => item.key) };

  const unknown = active.filter((item) => item.status === 'unknown' || item.status === 'not_declared');
  const positivePassed = active.filter((item) => item.status === 'passed' && item.contribution === 'positive');
  const decisivePassed = active.filter((item) => item.status === 'passed' && (item.contribution === 'blocking' || item.contribution === 'attention' || item.contribution === 'positive'));
  const informationalPassed = active.filter((item) => item.status === 'passed' && item.contribution === 'informational');
  const passed = [...positivePassed, ...decisivePassed.filter((item) => item.contribution !== 'positive'), ...informationalPassed];
  if (unknown.length > 0 && (decisivePassed.length === 0 || unknown.length >= passed.length)) {
    return { status: 'unknown', reason: 'unknown_dominant', sourceItemKeys: unknown.map((item) => item.key) };
  }
  if (passed.length > 0) return { status: 'ok', reason: 'all_passed', sourceItemKeys: passed.map((item) => item.key) };
  return { status: 'not_applicable', reason: 'not_applicable', sourceItemKeys: active.map((item) => item.key) };
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

interface ExpectedToolCheck {
  expectedTools: string[];
  matchedTools: string[];
  declared: boolean;
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

function executionOutcomeText(indicators: ExperienceReviewIndicators): string {
  const details = [
    indicators.toolFailureCount > 0 ? `失败 ${indicators.toolFailureCount} 次` : '',
    (indicators.toolCancelledCount ?? 0) > 0 ? `取消 ${indicators.toolCancelledCount ?? 0} 次` : '',
    (indicators.toolUnknownCount ?? 0) > 0 ? `状态未知 ${indicators.toolUnknownCount ?? 0} 次` : '',
  ].filter(Boolean);
  return `执行中看到 ${indicators.toolCallCount} 次工具调用${details.length > 0 ? `，其中${details.join('，')}` : ''}。`;
}

function deliveryStepText(session: ExperienceSessionSummary): string {
  const closure = userFacingClosureForSession(session);
  if (closure.deliveryCount > 0) {
    const artifact = closure.artifactCount > 0
      ? `，其中 ${closure.artifactCount} 次包含具体产物线索`
      : '，但未看到明确产物线索';
    return `看到 ${closure.deliveryCount} 次完成态或结果反馈${artifact}。`;
  }
  return '没有发现最后结果反馈；当前不能把过程进展当成完成。';
}

function canonicalFeedbackCountsForSession(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): Pick<ExperienceReviewIndicators,
  'userFollowUpCount' | 'userCorrectionCount' | 'userInterruptionCount' | 'negativeFeedbackCount' | 'positiveFeedbackCount'
> {
  const signals = session.sessionStory?.episodes?.flatMap((episode) => episode.feedbackSignals ?? []) ?? [];
  if (signals.length === 0) {
    return {
      userFollowUpCount: session.indicators.userFollowUpCount,
      userCorrectionCount: session.indicators.userCorrectionCount,
      userInterruptionCount: session.indicators.userInterruptionCount,
      negativeFeedbackCount: session.indicators.negativeFeedbackCount,
      positiveFeedbackCount: session.indicators.positiveFeedbackCount,
    };
  }
  const includeDownstream = shouldIncludeDownstreamFeedbackForSession(session);
  const owned = signals.filter((signal) =>
    (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
      attribution.skillName === session.skillName
      && (attribution.attributionRole === 'primary_fault'
        || includeDownstream && attribution.attributionRole === 'downstream_related')
    )
    && feedbackSignalIsActiveForSession(signal, session, reviewState)
  );
  return {
    userFollowUpCount: owned.filter((signal) => signal.type === 'follow_up').length,
    userCorrectionCount: owned.filter((signal) => signal.type === 'correction').length,
    userInterruptionCount: owned.filter((signal) => signal.type === 'interruption').length,
    negativeFeedbackCount: owned.filter((signal) => signal.type === 'frustration').length,
    positiveFeedbackCount: owned.filter((signal) => signal.type === 'positive').length,
  };
}

function feedbackSignalIsActiveForSession(
  signal: ExperienceFeedbackSignal,
  session: ExperienceSessionSummary,
  reviewState?: ObservationReviewState,
): boolean {
  const metricKey = metricKeyForFeedbackSignal(signal);
  if (!metricKey) return true;
  const verdict = observationMetricAnnotationVerdict(reviewState, { ...signal.evidenceRef, metricScopeId: session.id }, metricKey);
  if (verdict === 'confirmed') return true;
  if (verdict === 'rejected') return false;
  return true;
}

function metricKeyForFeedbackSignal(signal: ExperienceFeedbackSignal): ObservationMetricKey | undefined {
  if (signal.type === 'follow_up') return 'user_follow_up';
  if (signal.type === 'correction') return 'user_correction';
  if (signal.type === 'interruption') return 'user_interruption';
  if (signal.type === 'frustration') return 'negative_feedback';
  if (signal.type === 'positive') return 'positive_feedback';
  return undefined;
}

function shouldIncludeDownstreamFeedbackForSession(session: ExperienceSessionSummary): boolean {
  const runtime = currentSkillRuntimeModel(session);
  return Boolean(runtime && (runtime.skillType === 'router' || runtime.skillType === 'delegation' || runtime.hasDownstreamEdges || runtime.isDelegator));
}

function userFeedbackStepText(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): string {
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  const parts = [
    feedbackCounts.userFollowUpCount > 0 ? `追问/补充 ${feedbackCounts.userFollowUpCount} 次` : '',
    feedbackCounts.userCorrectionCount > 0 ? `纠正 ${feedbackCounts.userCorrectionCount} 次` : '',
    feedbackCounts.negativeFeedbackCount > 0 ? `负向反馈 ${feedbackCounts.negativeFeedbackCount} 次` : '',
    feedbackCounts.positiveFeedbackCount > 0 ? `正向反馈 ${feedbackCounts.positiveFeedbackCount} 次` : '',
    session.indicators.userGoalShiftCount > 0 ? `目标切换 ${session.indicators.userGoalShiftCount} 次` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `用户反馈信号：${parts.join('，')}。` : '原始日志里没有看到人工追问、纠正、负向反馈或目标切换。';
}

function userFeedbackStepStatus(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): ExperienceReviewerReportStepStatus {
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  if (feedbackCounts.userCorrectionCount > 0 || feedbackCounts.negativeFeedbackCount > 0 || feedbackCounts.userInterruptionCount > 0) return 'attention';
  if (feedbackCounts.positiveFeedbackCount > 0) return 'ok';
  return 'unknown';
}

function userFeedbackEvidenceRefs(session: ExperienceSessionSummary): ExperienceEvidenceRef[] {
  const includeDownstream = shouldIncludeDownstreamFeedbackForSession(session);
  const refs = uniqueEvidenceRefs((session.sessionStory?.episodes ?? []).flatMap((episode) =>
    (episode.feedbackSignals ?? []).filter((signal) =>
      (signal.canonicalAttributions ?? signal.attributions ?? []).some((attribution) =>
        attribution.skillName === session.skillName
        && (attribution.attributionRole === 'primary_fault'
          || includeDownstream && attribution.attributionRole === 'downstream_related')
      )
    ).map((signal) => signal.evidenceRef)
  ));
  if (refs.length > 0) return refs.slice(0, 5);
  return uniqueEvidenceRefs(session.ruleFindings
    .filter((finding) => finding.code === 'user_correction_seen' || finding.code === 'negative_feedback_seen' || finding.code === 'positive_feedback_seen' || finding.code === 'user_goal_shift_seen' || finding.code === 'user_interruption_seen')
    .flatMap((finding) => finding.evidenceRefs)).slice(0, 5);
}

function expectedToolCheckForSession(session: ExperienceSessionSummary): ExpectedToolCheck {
  const expectedTools = loadExpectedToolsForSkill(session.skillName, session.cwd);
  if (expectedTools.length === 0) return { expectedTools: [], matchedTools: [], declared: false };
  const events = session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview;
  const matchedTools = expectedTools.filter((tool) => events.some((event) => eventMatchesExpectedTool(event, tool)));
  return {
    expectedTools,
    matchedTools,
    declared: true,
  };
}

function eventMatchesExpectedTool(event: ExperienceTimelineEvent, expectedTool: string): boolean {
  if (event.kind !== 'tool_use') return false;
  const text = `${event.toolName ?? ''}\n${event.label ?? ''}\n${event.snippet ?? ''}\n${event.fullText ?? ''}`.toLowerCase();
  const normalized = expectedTool.toLowerCase().trim();
  const aliases = unique([
    normalized,
    normalized.replace(/[-_]?cli$/, ''),
  ].filter(Boolean));
  return aliases.some((alias) => new RegExp(`(^|[^a-z0-9_-])${escapeRegExp(alias)}([^a-z0-9_-]|$)`, 'i').test(text));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function legacyBusinessActionSource(): string {
  return ['ai', 'ma-cmd'].join('');
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

function minDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.min(...filtered) : undefined;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

function inferUserGoal(userRefs: ExperienceTimelineEvent[]): string | undefined {
  const first = userRefs.find((ref) => ref.snippet && !ref.snippet.includes('tool_result'));
  return snippet(first?.snippet, 180);
}
