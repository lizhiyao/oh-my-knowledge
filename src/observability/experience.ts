import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isTraceSourceKind as isObservationSourceKind } from '../shared/trace-source-kind.js';
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
  ExperienceTraceRecordRange,
  ExperienceTraceTimeline,
  ExperienceTimelineTree,
  ExperienceTurnSummary,
  ObservationExperienceReport,
  ObservationInboxItem,
  ObservationMetricKey,
  ObservationReviewState,
  TraceSourceMetadata,
} from '../types/index.js';
import {
  buildExperienceProblemPatterns,
  mergeExperienceProblemPatterns,
} from './problem-patterns.js';
import { observationMetricAnnotationVerdict, observationReviewStateKey } from './review-state.js';
import {
  correlateTraceToolEvents,
  normalizeTraceTimestamp,
  type TraceEvent,
  type TraceMessageEvent,
  type TraceSession,
} from './trace-ir.js';
import {
  skillSegmentTimestampObserved,
  UNOBSERVED_TRACE_TIMESTAMP,
  type SkillSegment,
} from './trace-segmenter.js';
import { createTraceSessionIndex, traceSessionRefIdentity } from './trace-session-index.js';
import { reconstructExperienceTurns } from './turn-index.js';
import { extractCommandEnvelopeText, stripCommandEnvelopeText } from './trace-attribution.js';
import { hasAssistantDeliverableArtifactText, hasAssistantDeliverySignalText, hasUserHardRuleText, isAssistantProgressUpdateText, isAssistantProtocolReplyText, isSyntheticUserMessageText, isToolResultFailureText, isUserInteractionMetricText } from './text-signals.js';
import { durationMsBetween } from '../shared/time.js';
import {
  incrementRecordCount,
  ownRecordValue,
  sumRecordCounts as sumSafeCounts,
} from '../shared/record-count.js';
import { checkedSumTokenCounts } from '../shared/token-usage.js';
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

export const OBSERVATION_EXPERIENCE_SCHEMA_VERSION = 3;
const LEGACY_OBSERVATION_EXPERIENCE_SCHEMA_VERSION = 2;

export type PersistedExperienceInvocation = Omit<
  ExperienceInvocation,
  'timeline' | 'timelineRef' | 'timelineEventIds'
> & {
  timelineRef: string;
  timelineEventIds: string[];
};

export type PersistedExperienceSessionStory = Omit<
  ExperienceSessionStory,
  'contextRef' | 'goalSlices' | 'subagentDispatches' | 'episodes'
> & {
  contextRef: string;
};

export type PersistedExperienceReviewerReport = Omit<
  ExperienceReviewerReport,
  'sessionStory' | 'sessionStoryRef'
> & {
  sessionStoryRef: 'session';
};

export type PersistedExperienceSession = Omit<
  ExperienceSessionSummary,
  | 'timelineRef'
  | 'timelinePreviewEventIds'
  | 'attributedEventIds'
  | 'timelinePreview'
  | 'fullSessionTimeline'
  | 'timelineTree'
  | 'sessionStory'
  | 'reviewerReport'
> & {
  timelineRef: string;
  timelinePreviewEventIds: string[];
  sessionStory?: PersistedExperienceSessionStory;
  reviewerReport?: PersistedExperienceReviewerReport;
};

export type PersistedObservationExperienceReport = Omit<
  ObservationExperienceReport,
  'invocations' | 'sessions'
> & {
  invocations: PersistedExperienceInvocation[];
  sessions: PersistedExperienceSession[];
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
const TIMELINE_PREVIEW_EVENT_LIMIT = 240;

interface BuildExperienceInput {
  sessions: TraceSession[];
  segments: SkillSegment[];
  items: ObservationInboxItem[];
  generatedAt: string;
  reviewState?: ObservationReviewState;
}

const ZERO_INDICATORS: ExperienceReviewIndicators = {
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

export function normalizeObservationExperienceReport(value: unknown): ObservationExperienceReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  const kind = report.kind === 'observe-experience' ? report.kind : null;
  if (!kind) return null;
  if (
    report.schemaVersion !== OBSERVATION_EXPERIENCE_SCHEMA_VERSION
    && report.schemaVersion !== LEGACY_OBSERVATION_EXPERIENCE_SCHEMA_VERSION
  ) return null;
  const isLegacyReport = report.schemaVersion === LEGACY_OBSERVATION_EXPERIENCE_SCHEMA_VERSION;
  if (report.scope !== 'evidence-only') return null;
  if (
    !isTimestamp(report.generatedAt)
    || !report.meta
    || typeof report.meta !== 'object'
    || !isExperienceMeta(report.meta)
  ) return null;
  if (!Array.isArray(report.goalSlices) || !Array.isArray(report.invocations) || !Array.isArray(report.sessions) || !Array.isArray(report.skills)) {
    return null;
  }
  const invocations = normalizeExperienceInvocationShells(report.invocations, !isLegacyReport);
  const sessions = normalizeExperienceSessionShells(report.sessions, !isLegacyReport);
  if (!invocations || !sessions) return null;
  if (
    !isLegacyReport
    && (!Array.isArray(report.traceTimelines) || !Array.isArray(report.storyContexts))
  ) return null;
  const traceTimelines = Array.isArray(report.traceTimelines)
    ? normalizeTraceTimelines(report.traceTimelines)
    : traceTimelinesFromSessions(sessions, invocations);
  const storyContexts = Array.isArray(report.storyContexts)
    ? normalizeStoryContexts(report.storyContexts)
    : storyContextsFromSessions(sessions, invocations);
  if (!traceTimelines || !storyContexts) return null;
  const normalized: ObservationExperienceReport = {
    kind: 'observe-experience',
    schemaVersion: OBSERVATION_EXPERIENCE_SCHEMA_VERSION,
    scope: 'evidence-only',
    generatedAt: report.generatedAt,
    meta: report.meta as ObservationExperienceReport['meta'],
    goalSlices: report.goalSlices as ObservationExperienceReport['goalSlices'],
    traceTimelines,
    storyContexts,
    invocations,
    sessions,
    skills: report.skills as ObservationExperienceReport['skills'],
  };
  const hydrated = hydrateExperienceTimelines(normalized);
  try {
    if (!validateExperienceReferences(hydrated, !isLegacyReport)) return null;
  } catch {
    return null;
  }
  return hydrated;
}

function normalizeExperienceInvocationShells(
  values: unknown[],
  strict: boolean,
): ExperienceInvocation[] | null {
  const records = values.filter(isObjectRecord);
  if (records.length !== values.length) return null;
  if (records.some((value) =>
    typeof value.id !== 'string'
    || typeof value.skillName !== 'string'
    || typeof value.sessionId !== 'string'
    || typeof value.sessionGroupKey !== 'string'
    || (strict ? typeof value.traceId !== 'string' : !isOptionalString(value.traceId))
    || typeof value.sourceTrace !== 'string'
    || !isObservationSourceKind(value.sourceKind)
    || !isOptionalString(value.entrypoint)
    || !isOptionalTraceSourceMetadata(value.sourceMetadata)
    || !isOptionalString(value.cwd)
    || !isNonNegativeInteger(value.segmentIndex)
    || typeof value.goalSliceId !== 'string'
    || !isTimestampRange(value.startTimestamp, value.endTimestamp)
    || (value.timestampObserved !== undefined && typeof value.timestampObserved !== 'boolean')
    || (strict && typeof value.timestampObserved !== 'boolean')
    || !isExperienceAttribution(value.attribution)
    || !isExperienceInvocationMetrics(value.metrics, strict)
    || !isCountRecord(value.toolCounts)
    || !isExperienceIndicators(value.indicators, strict)
    || !isExperienceEvidenceChain(value.evidenceChain)
    || !isExperienceRuleFindingArray(value.ruleFindings)
    || !isExperienceAssistiveInference(value.assistiveInference)
    || !isExperienceProblemPatternArray(value.problemPatterns)
    || !isStringArray(value.relatedObservationIds)
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
    || (
      strict
        ? typeof value.timelineRef !== 'string'
          || !isStringArray(value.timelineEventIds)
          || (value.timeline !== undefined && !isTimelineEventArray(value.timeline))
        : !isOptionalString(value.timelineRef)
          || (value.timelineEventIds !== undefined && !isStringArray(value.timelineEventIds))
          || !isTimelineEventArray(value.timeline)
    )
  )) return null;
  return records.map((value) => ({
    ...value,
    metrics: {
      ...(value.metrics as Record<string, unknown>),
      tokenUsageObserved: strict
        ? (value.metrics as Record<string, unknown>).tokenUsageObserved
        : false,
    },
    timeline: isTimelineEventArray(value.timeline)
      ? value.timeline as ExperienceTimelineEvent[]
      : [],
  } as ExperienceInvocation));
}

function normalizeExperienceSessionShells(
  values: unknown[],
  strict: boolean,
): ExperienceSessionSummary[] | null {
  const records = values.filter(isObjectRecord);
  if (records.length !== values.length) return null;
  if (records.some((value) =>
    typeof value.id !== 'string'
    || typeof value.skillName !== 'string'
    || !isOptionalString(value.threadId)
    || !isOptionalString(value.sourceThreadId)
    || typeof value.sessionId !== 'string'
    || typeof value.sourceTrace !== 'string'
    || !isObservationSourceKind(value.sourceKind)
    || !isOptionalString(value.entrypoint)
    || !isOptionalTraceSourceMetadata(value.sourceMetadata)
    || !isOptionalString(value.cwd)
    || !isConsistentSourceSessionTime(value)
    || !isTimestampRange(value.startTimestamp, value.endTimestamp)
    || !isStringArray(value.invocationIds)
    || !isOptionalTimestampCoverage(
      value.timestampedInvocationCount,
      value.timestampCoverage,
      Array.isArray(value.invocationIds) ? value.invocationIds.length : -1,
    )
    || (
      strict
      && (
        !isNonNegativeInteger(value.timestampedInvocationCount)
        || !isRate(value.timestampCoverage)
      )
    )
    || !isStringArray(value.goalSliceIds)
    || !isExperienceReviewPriority(value.reviewPriority)
    || typeof value.reviewPriorityScore !== 'number'
    || !Number.isFinite(value.reviewPriorityScore)
    || value.reviewPriorityScore < 0
    || !isEnumArray(value.reviewBasisCodes, [
      'has_high_observation',
      'has_medium_observation',
      'user_correction',
      'user_interruption',
      'session_interrupted',
      'negative_feedback',
      'hard_rule_text_hit',
      'tool_failure',
      'hedging_signal',
      'explicit_marker',
    ])
    || !isExperienceIndicators(value.indicators, strict)
    || !isExperienceEvidenceChain(value.evidenceChain)
    || !isExperienceRuleFindingArray(value.ruleFindings)
    || !isExperienceAssistiveInference(value.assistiveInference)
    || !isExperienceProblemPatternArray(value.problemPatterns)
    || !isStringArray(value.relatedObservationIds)
    || (value.turns !== undefined && !isExperienceTurnSummaryArray(value.turns))
    || !(strict
      ? isExperienceTimelineScope(value.timelineScope)
      : isLegacyExperienceTimelineScope(value.timelineScope))
    || !isStringArray(value.attributionSources)
    || !isStringArray(value.pluginNames)
    || !isStringArray(value.rawSkillRefs)
    || !isStringArray(value.commandNames)
    || (
      strict
        ? typeof value.timelineRef !== 'string'
          || !isStringArray(value.timelinePreviewEventIds)
          || (value.timelinePreview !== undefined && !isTimelineEventArray(value.timelinePreview))
          || (value.fullSessionTimeline !== undefined && !isTimelineEventArray(value.fullSessionTimeline))
        : !isOptionalString(value.timelineRef)
          || (
            value.timelinePreviewEventIds !== undefined
            && !isStringArray(value.timelinePreviewEventIds)
          )
          || !isTimelineEventArray(value.timelinePreview)
          || !isTimelineEventArray(value.fullSessionTimeline)
    )
    || (value.timelineTree !== undefined && !isTimelineTree(value.timelineTree))
    || (
      value.sessionStory !== undefined
      && !isExperienceSessionStory(value.sessionStory, strict)
    )
    || (
      value.reviewerReport !== undefined
      && !isExperienceReviewerReport(value.reviewerReport, strict)
    )
  )) return null;
  return records.map((value) => {
    const sourceThreadId = typeof value.sourceThreadId === 'string'
      ? value.sourceThreadId
      : typeof value.threadId === 'string'
        ? value.threadId
        : value.sessionId as string;
    const threadId = typeof value.threadId === 'string'
      ? value.threadId
      : hashParts('thread', sourceThreadId);
    const sessionStory = isObjectRecord(value.sessionStory)
      ? {
          ...value.sessionStory,
          goalSlices: Array.isArray(value.sessionStory.goalSlices) ? value.sessionStory.goalSlices : [],
          subagentDispatches: Array.isArray(value.sessionStory.subagentDispatches)
            ? value.sessionStory.subagentDispatches
            : [],
          episodes: Array.isArray(value.sessionStory.episodes) ? value.sessionStory.episodes : [],
        }
      : undefined;
    return {
      ...value,
      threadId,
      sourceThreadId,
      invocationIds: Array.isArray(value.invocationIds) ? value.invocationIds : [],
      turns: isExperienceTurnSummaryArray(value.turns) ? value.turns : [],
      timelinePreview: Array.isArray(value.timelinePreview) ? value.timelinePreview : [],
      fullSessionTimeline: Array.isArray(value.fullSessionTimeline) ? value.fullSessionTimeline : [],
      sessionStory,
    } as ExperienceSessionSummary;
  });
}

function normalizeTraceTimelines(values: unknown[]): ExperienceTraceTimeline[] | null {
  if (values.some((value) => {
    if (
      !isObjectRecord(value)
      || typeof value.id !== 'string'
      || typeof value.sessionGroupKey !== 'string'
      || typeof value.sessionId !== 'string'
      || !isNonNegativeInteger(value.eventCount)
    ) return true;
    return !isTimelineTree(value.tree);
  })) return null;
  return values as ExperienceTraceTimeline[];
}

function normalizeStoryContexts(values: unknown[]): ExperienceStoryContext[] | null {
  if (values.some((value) => !isExperienceStoryContext(value))) return null;
  return values as ExperienceStoryContext[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isOptionalTimestampCoverage(
  count: unknown,
  coverage: unknown,
  total: number,
): boolean {
  if (count === undefined && coverage === undefined) return true;
  if (
    total < 0
    || !isNonNegativeInteger(count)
    || count > total
    || !isRate(coverage)
  ) return false;
  return coverage === (total > 0 ? count / total : 0);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && normalizeTraceTimestamp(value) !== undefined;
}

function isOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isTimestamp(value);
}

function isTimestampRange(start: unknown, end: unknown): boolean {
  if (!isTimestamp(start) || !isTimestamp(end)) return false;
  return Date.parse(start) <= Date.parse(end);
}

function invocationTimestampObserved(invocation: ExperienceInvocation): boolean {
  return invocation.timestampObserved
    ?? invocation.startTimestamp !== UNOBSERVED_TRACE_TIMESTAMP;
}

function sessionTimestampedInvocationCount(session: ExperienceSessionSummary): number {
  return session.timestampedInvocationCount
    ?? (session.startTimestamp === UNOBSERVED_TRACE_TIMESTAMP
      ? 0
      : session.invocationIds.length);
}

function isConsistentSourceSessionTime(value: Record<string, unknown>): boolean {
  const start = value.sourceSessionStartTimestamp;
  const end = value.sourceSessionEndTimestamp;
  const duration = value.sourceSessionDurationMs;
  if (!isOptionalTimestamp(start) || !isOptionalTimestamp(end)) return false;
  if (duration !== undefined && !isNonNegativeInteger(duration)) return false;
  if (start === undefined || end === undefined) return duration === undefined;
  return typeof start === 'string'
    && typeof end === 'string'
    && isTimestampRange(start, end)
    && duration === durationMsBetween(start, end);
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isEnumValue(value: unknown, values: readonly string[]): boolean {
  return typeof value === 'string' && values.includes(value);
}

function isEnumArray(value: unknown, values: readonly string[]): boolean {
  return Array.isArray(value) && value.every((item) => isEnumValue(item, values));
}

function isExperienceMeta(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || !isNonNegativeInteger(value.sessionCount)
    || !isNonNegativeInteger(value.skillCount)
    || !isNonNegativeInteger(value.invocationCount)
    || !isNonNegativeInteger(value.goalSliceCount)
  ) return false;
  return isEnumArray(value.noteCodes, [
    'no_llm_judge',
    'no_auto_verdict',
    'default_goal_slice_is_allowed',
    'deterministic_assistive_inference',
  ]);
}

function isOptionalTraceSourceMetadata(value: unknown): boolean {
  if (value === undefined) return true;
  return isObjectRecord(value)
    && isOptionalString(value.channel)
    && isOptionalString(value.sender)
    && isOptionalString(value.senderId)
    && isOptionalString(value.provider)
    && isOptionalString(value.model)
    && isOptionalString(value.modelApi)
    && (value.businessActions === undefined || isStringArray(value.businessActions));
}

function isExperienceReviewPriority(value: unknown): boolean {
  return value === 'review_first' || value === 'sample_review' || value === 'routine_sample';
}

function isExperienceEvidenceKind(value: unknown): boolean {
  return isEnumValue(value, [
    'user_message',
    'synthetic_user_event',
    'assistant_message',
    'model_activity',
    'agent_activity',
    'tool_use',
    'tool_result',
    'skill_context',
    'runtime_context',
    'lifecycle',
    'observation',
  ]);
}

function isExperienceEvidenceRef(value: unknown): value is ExperienceEvidenceRef {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || !isExperienceEvidenceKind(value.kind)
    || typeof value.sourceTrace !== 'string'
    || typeof value.sessionId !== 'string'
    || !isOptionalNonNegativeInteger(value.messageIndex)
    || !isOptionalNonNegativeInteger(value.logicalMessageIndex)
    || !isOptionalNonNegativeInteger(value.sourceLineIndex)
  ) return false;
  if (
    value.traceRole !== undefined
    && !isEnumValue(value.traceRole, ['standalone', 'main', 'subagent'])
  ) return false;
  if (value.modelActivityKind !== undefined && value.modelActivityKind !== 'reasoning') return false;
  if (
    value.contentVisibility !== undefined
    && !isEnumValue(value.contentVisibility, ['plaintext', 'opaque'])
  ) return false;
  if (
    value.contentSource !== undefined
    && !isEnumValue(value.contentSource, ['summary', 'content', 'text'])
  ) return false;
  if (
    value.runtimeKind !== undefined
    && !isEnumValue(value.runtimeKind, ['session_context', 'execution_context', 'settings', 'goal', 'context_compaction', 'usage'])
  ) return false;
  if (
    value.role !== undefined
    && !isEnumValue(value.role, ['user', 'assistant', 'tool', 'other'])
  ) return false;
  return [
    value.traceLabel,
    value.traceId,
    value.turnId,
    value.messageUuid,
    value.sourceType,
    value.callInstanceId,
    value.toolUseId,
    value.label,
    value.snippet,
  ].every(isOptionalString)
    && isOptionalTimestamp(value.timestamp);
}

function isExperienceEvidenceRefArray(value: unknown): value is ExperienceEvidenceRef[] {
  return Array.isArray(value) && value.every(isExperienceEvidenceRef);
}

function isExperienceGoalSlice(value: unknown): value is ExperienceGoalSlice {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.skillName === 'string'
    && typeof value.sessionId === 'string'
    && isOptionalString(value.traceId)
    && typeof value.sourceTrace === 'string'
    && isOptionalString(value.cwd)
    && isTimestampRange(value.startTimestamp, value.endTimestamp)
    && (value.timestampObserved === undefined || typeof value.timestampObserved === 'boolean')
    && isEnumValue(value.sliceReasonCode, [
      'skill_segment_boundary',
      'explicit_user_goal_shift',
      'default_session_slice',
    ])
    && isEnumValue(value.sliceConfidence, ['low', 'medium', 'high'])
    && isOptionalString(value.inferredUserGoal)
    && isExperienceEvidenceRefArray(value.userMessageRefs);
}

function isExperienceEvidenceChain(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  const countKeys = [
    'userMessageCount',
    'runtimeContextCount',
    'skillContextCount',
    'assistantMessageCount',
    'toolUseCount',
    'toolResultCount',
    'toolFailureResultCount',
    'observationCount',
  ];
  if (!countKeys.every((key) => isNonNegativeInteger(value[key]))) return false;
  const optionalRefs = [
    value.firstUserMessage,
    value.firstRuntimeContext,
    value.firstSkillContext,
    value.firstToolUse,
    value.firstToolFailure,
    value.lastAssistantMessage,
  ];
  return optionalRefs.every((ref) => ref === undefined || isExperienceEvidenceRef(ref));
}

function isExperienceRuleFinding(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.code, [
      'high_observation_seen',
      'medium_observation_seen',
      'user_correction_seen',
      'user_interruption_seen',
      'session_interrupted_seen',
      'negative_feedback_seen',
      'positive_feedback_seen',
      'user_goal_shift_seen',
      'hard_rule_seen',
      'tool_failure_seen',
      'hedging_seen',
      'explicit_marker_seen',
      'runtime_context_excluded',
      'skill_context_excluded',
      'no_priority_signal',
    ])
    && isEnumValue(value.level, ['attention', 'sample', 'normal'])
    && isNonNegativeInteger(value.count)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceRuleFindingArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isExperienceRuleFinding);
}

function isExperienceAssistiveInference(value: unknown): boolean {
  return isObjectRecord(value)
    && value.mode === 'deterministic_rules_only'
    && isEnumValue(value.code, [
      'review_recommended',
      'sample_recommended',
      'positive_signal_observed',
      'user_switched_topic_neutral',
      'no_obvious_issue_from_rules',
      'insufficient_human_context',
    ])
    && isEnumValue(value.confidence, ['low', 'medium', 'high'])
    && isEnumArray(value.basisRuleCodes, [
      'high_observation_seen',
      'medium_observation_seen',
      'user_correction_seen',
      'user_interruption_seen',
      'session_interrupted_seen',
      'negative_feedback_seen',
      'positive_feedback_seen',
      'user_goal_shift_seen',
      'hard_rule_seen',
      'tool_failure_seen',
      'hedging_seen',
      'explicit_marker_seen',
      'runtime_context_excluded',
      'skill_context_excluded',
      'no_priority_signal',
    ])
    && isEnumArray(value.cautionCodes, [
      'no_llm_judge',
      'rule_only',
      'runtime_context_excluded',
      'skill_context_excluded',
      'no_human_user_message',
      'limited_timeline_window',
    ])
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceProblemEvidenceRef(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || typeof value.kind !== 'string'
    || typeof value.sourceTrace !== 'string'
    || typeof value.sessionId !== 'string'
    || !isOptionalNonNegativeInteger(value.messageIndex)
    || !isOptionalNonNegativeInteger(value.logicalMessageIndex)
    || !isOptionalNonNegativeInteger(value.sourceLineIndex)
  ) return false;
  if (
    value.role !== undefined
    && !isEnumValue(value.role, ['user', 'assistant', 'tool', 'other'])
  ) return false;
  return [
    value.messageUuid,
    value.traceId,
    value.callInstanceId,
    value.toolUseId,
    value.label,
    value.snippet,
  ].every(isOptionalString)
    && isOptionalTimestamp(value.timestamp);
}

function isExperienceProblemPattern(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isEnumValue(value.bucket, [
      'output_format',
      'content_accuracy',
      'missing_context',
      'rule_violation',
      'workflow_mismatch',
      'tool_runtime',
      'goal_shift',
      'unclear',
    ])
    && typeof value.patternKey === 'string'
    && isNonNegativeInteger(value.count)
    && isNonNegativeInteger(value.sessionCount)
    && isStringArray(value.recentSessionIds)
    && isEnumArray(value.signalTypes, [
      'user_correction',
      'negative_feedback',
      'user_interruption',
      'hard_rule',
      'user_goal_shift',
      'tool_failure',
      'workflow_mismatch',
      'artifact_missing',
      'observer_lifecycle_failed',
      'orchestration_boundary_violation',
    ])
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every(isExperienceProblemEvidenceRef)
    && isOptionalTimestamp(value.lastSeen);
}

function isExperienceProblemPatternArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isExperienceProblemPattern);
}

function isExperienceAttribution(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.source === 'string'
    && isRate(value.confidence)
    && isOptionalString(value.rawSkillRef)
    && isOptionalString(value.pluginName)
    && isOptionalString(value.commandName);
}

function isExperienceInvocationMetrics(value: unknown, requireSourceNeutralOutcomes = false): boolean {
  if (!isObjectRecord(value)) return false;
  const fields = [
    value.durationMs,
    value.inputTokens,
    value.outputTokens,
    value.cacheReadTokens,
    value.cacheCreationTokens,
    value.numTurns,
    value.numToolCalls,
    value.numToolFailures,
  ];
  if (!fields.every(isNonNegativeInteger)) return false;
  if (
    requireSourceNeutralOutcomes
    && (
      typeof value.tokenUsageObserved !== 'boolean'
      ||
      !isNonNegativeInteger(value.numToolCancelled)
      || !isNonNegativeInteger(value.numToolUnknown)
    )
  ) return false;
  if (
    value.tokenUsageObserved !== undefined
    && typeof value.tokenUsageObserved !== 'boolean'
  ) return false;
  if (value.numToolCancelled !== undefined && !isNonNegativeInteger(value.numToolCancelled)) return false;
  if (value.numToolUnknown !== undefined && !isNonNegativeInteger(value.numToolUnknown)) return false;
  const cancelled = typeof value.numToolCancelled === 'number' ? value.numToolCancelled : 0;
  const unknown = typeof value.numToolUnknown === 'number' ? value.numToolUnknown : 0;
  return (value.numToolFailures as number) + cancelled + unknown <= (value.numToolCalls as number);
}

const EXPERIENCE_INDICATOR_KEYS = [
  'userMessageCount',
  'userFollowUpCount',
  'userCorrectionCount',
  'userInterruptionCount',
  'sessionInterruptedCount',
  'negativeFeedbackCount',
  'positiveFeedbackCount',
  'userGoalShiftCount',
  'hardRuleTextHitCount',
  'assistantDeliverySignalCount',
  'deliverableArtifactSignalCount',
  'routerDownstreamCompleted',
  'routerDownstreamFailed',
  'selfCorrectionCount',
  'repeatedExecutionCount',
  'toolCallCount',
  'toolFailureCount',
  'highObservationCount',
  'mediumObservationCount',
  'hedgingCount',
  'explicitMarkerCount',
] as const;

function isExperienceIndicators(value: unknown, requireSourceNeutralOutcomes = false): boolean {
  return isObjectRecord(value)
    && EXPERIENCE_INDICATOR_KEYS.every((key) => isNonNegativeInteger(value[key]))
    && (
      !requireSourceNeutralOutcomes
      || (
        isNonNegativeInteger(value.toolCancelledCount)
        && isNonNegativeInteger(value.toolUnknownCount)
      )
    )
    && (value.toolCancelledCount === undefined || isNonNegativeInteger(value.toolCancelledCount))
    && (value.toolUnknownCount === undefined || isNonNegativeInteger(value.toolUnknownCount))
    && (value.toolFailureCount as number)
      + (typeof value.toolCancelledCount === 'number' ? value.toolCancelledCount : 0)
      + (typeof value.toolUnknownCount === 'number' ? value.toolUnknownCount : 0)
      <= (value.toolCallCount as number);
}

function isCountRecord(value: unknown): boolean {
  return isObjectRecord(value)
    && Object.values(value).every(isNonNegativeInteger);
}

function isExperienceTimelineScope(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || value.mode !== 'skill_segment_window'
    || !isNonNegativeInteger(value.segmentEventCount)
    || !isNonNegativeInteger(value.previewEventCount)
    || !isNonNegativeInteger(value.fullSessionEventCount)
    || !isExperienceTraceRecordRangeArray(value.segmentRecordRanges)
    || !isExperienceTraceRecordRangeArray(value.previewRecordRanges)
    || !isExperienceTraceRecordRangeArray(value.sessionRecordRanges)
    || typeof value.truncated !== 'boolean'
    || !isNonNegativeInteger(value.omittedBeforeCount)
    || !isNonNegativeInteger(value.omittedAfterCount)
  ) return false;
  return value.previewEventCount <= value.segmentEventCount
    && value.segmentEventCount <= value.fullSessionEventCount
    && value.omittedBeforeCount + value.omittedAfterCount <= value.fullSessionEventCount;
}

function isLegacyExperienceTimelineScope(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || value.mode !== 'skill_segment_window'
    || !isOptionalNonNegativeInteger(value.segmentStartRecordIndex)
    || !isOptionalNonNegativeInteger(value.segmentEndRecordIndex)
    || !isOptionalNonNegativeInteger(value.previewStartRecordIndex)
    || !isOptionalNonNegativeInteger(value.previewEndRecordIndex)
    || !isNonNegativeInteger(value.sessionStartRecordIndex)
    || !isNonNegativeInteger(value.sessionEndRecordIndex)
    || !isNonNegativeInteger(value.previewEventCount)
    || !isNonNegativeInteger(value.fullSessionEventCount)
    || typeof value.truncated !== 'boolean'
    || !isNonNegativeInteger(value.omittedBeforeCount)
    || !isNonNegativeInteger(value.omittedAfterCount)
  ) return false;
  const optionalRanges: Array<[unknown, unknown]> = [
    [value.segmentStartRecordIndex, value.segmentEndRecordIndex],
    [value.previewStartRecordIndex, value.previewEndRecordIndex],
  ];
  if (optionalRanges.some(([start, end]) =>
    (start === undefined) !== (end === undefined)
    || (
      typeof start === 'number'
      && typeof end === 'number'
      && start > end
    )
  )) return false;
  return value.sessionStartRecordIndex <= value.sessionEndRecordIndex
    && value.previewEventCount <= value.fullSessionEventCount
    && value.omittedBeforeCount + value.omittedAfterCount <= value.fullSessionEventCount;
}

function isExperienceTraceRecordRangeArray(value: unknown): value is ExperienceTraceRecordRange[] {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  for (const range of value) {
    if (
      !isObjectRecord(range)
      || typeof range.traceId !== 'string'
      || typeof range.sourceTrace !== 'string'
      || !isNonNegativeInteger(range.startRecordIndex)
      || !isNonNegativeInteger(range.endRecordIndex)
      || range.startRecordIndex > range.endRecordIndex
      || !isNonNegativeInteger(range.eventCount)
      || range.eventCount === 0
      || identities.has(range.traceId)
    ) return false;
    identities.add(range.traceId);
  }
  return true;
}

function isExperienceSkillSummary(value: unknown, requireToolUnknown = false): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.skillName !== 'string'
    || !isNonNegativeInteger(value.invocationCount)
    || !isNonNegativeInteger(value.sessionCount)
    || !Array.isArray(value.sourceKinds)
    || !value.sourceKinds.every(isObservationSourceKind)
    || !isStringArray(value.entrypoints)
    || !isCountRecord(value.entrypointCounts)
    || !isCountRecord(value.attributionCounts)
    || !isStringArray(value.pluginNames)
    || !isStringArray(value.rawSkillRefs)
    || !isStringArray(value.commandNames)
    || !isCountRecord(value.toolCounts)
    || !isTimestampRange(value.firstSeen, value.lastSeen)
    || !isOptionalTimestampCoverage(
      value.timestampedInvocationCount,
      value.timestampCoverage,
      value.invocationCount,
    )
    || (
      requireToolUnknown
      && (
        !isNonNegativeInteger(value.timestampedInvocationCount)
        || !isRate(value.timestampCoverage)
      )
    )
    || !isNonNegativeInteger(value.reviewFirstSessionCount)
    || !isNonNegativeInteger(value.sampleReviewSessionCount)
    || !isExperienceIndicators(value.indicators, requireToolUnknown)
    || !isExperienceEvidenceChain(value.evidenceChain)
    || !isExperienceRuleFindingArray(value.ruleFindings)
    || !isExperienceAssistiveInference(value.assistiveInference)
    || !isExperienceProblemPatternArray(value.problemPatterns)
    || !isStringArray(value.relatedObservationIds)
    || !isObjectRecord(value.sourceMetadataCounts)
  ) return false;
  const metadataCounts = value.sourceMetadataCounts;
  return ['channels', 'senders', 'businessActions', 'providers', 'models']
    .every((key) => isCountRecord(metadataCounts[key]));
}

function isTimelineEvent(value: unknown): value is ExperienceTimelineEvent {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || ![
      'user_message',
      'synthetic_user_event',
      'assistant_message',
      'model_activity',
      'agent_activity',
      'tool_use',
      'tool_result',
      'skill_context',
      'runtime_context',
      'lifecycle',
      'observation',
    ].includes(String(value.kind))
    || typeof value.sourceTrace !== 'string'
    || typeof value.sessionId !== 'string'
    || !isNonNegativeInteger(value.order)
  ) return false;
  const optionalIndexes = [
    value.messageIndex,
    value.logicalMessageIndex,
    value.sourceLineIndex,
  ];
  if (!optionalIndexes.every((index) => index === undefined || isNonNegativeInteger(index))) return false;
  if (
    value.traceRole !== undefined
    && value.traceRole !== 'standalone'
    && value.traceRole !== 'main'
    && value.traceRole !== 'subagent'
  ) return false;
  if (
    value.role !== undefined
    && value.role !== 'user'
    && value.role !== 'assistant'
    && value.role !== 'tool'
    && value.role !== 'other'
  ) return false;
  if (
    value.toolStatus !== undefined
    && value.toolStatus !== 'success'
    && value.toolStatus !== 'failure'
    && value.toolStatus !== 'cancelled'
    && value.toolStatus !== 'unknown'
  ) return false;
  if (value.modelActivityKind !== undefined && value.modelActivityKind !== 'reasoning') return false;
  if (
    value.contentVisibility !== undefined
    && value.contentVisibility !== 'plaintext'
    && value.contentVisibility !== 'opaque'
  ) return false;
  if (
    value.contentSource !== undefined
    && value.contentSource !== 'summary'
    && value.contentSource !== 'content'
    && value.contentSource !== 'text'
  ) return false;
  if (
    value.runtimeKind !== undefined
    && value.runtimeKind !== 'session_context'
    && value.runtimeKind !== 'execution_context'
    && value.runtimeKind !== 'settings'
    && value.runtimeKind !== 'goal'
    && value.runtimeKind !== 'context_compaction'
    && value.runtimeKind !== 'usage'
  ) return false;
  const optionalStrings = [
    value.traceId,
    value.traceLabel,
    value.turnId,
    value.messageUuid,
    value.sourceType,
    value.model,
    value.callInstanceId,
    value.toolUseId,
    value.label,
    value.snippet,
    value.toolName,
    value.fullText,
  ];
  if (
    !optionalStrings.every((field) => field === undefined || typeof field === 'string')
    || !isOptionalTimestamp(value.timestamp)
    || (value.isError !== undefined && typeof value.isError !== 'boolean')
    || (value.attachments !== undefined && !isTimelineAttachmentArray(value.attachments))
  ) return false;
  return value.kind !== 'tool_result'
    || value.toolStatus === undefined
    || value.isError === undefined
    || value.isError === (value.toolStatus === 'failure');
}

function isTimelineAttachmentArray(value: unknown): value is NonNullable<ExperienceTimelineEvent['attachments']> {
  return Array.isArray(value) && value.every((attachment) => (
    isObjectRecord(attachment)
    && (attachment.attachmentKind === 'image' || attachment.attachmentKind === 'file')
    && typeof attachment.name === 'string'
    && attachment.name.length > 0
  ));
}

function isTimelineEventArray(value: unknown): value is ExperienceTimelineEvent[] {
  return Array.isArray(value) && value.every(isTimelineEvent);
}

function isExperienceTurnSummaryArray(value: unknown): value is ExperienceTurnSummary[] {
  return Array.isArray(value) && value.every((turn) => (
    isObjectRecord(turn)
    && typeof turn.turnId === 'string'
    && isOptionalString(turn.sourceTurnId)
    && (
      turn.boundaryBasis === 'turn_id'
      || turn.boundaryBasis === 'turn_lifecycle'
      || turn.boundaryBasis === 'user_message'
    )
    && isOptionalString(turn.traceId)
    && typeof turn.sourceTrace === 'string'
    && isOptionalTimestamp(turn.startTimestamp)
    && isOptionalTimestamp(turn.endTimestamp)
    && (
      turn.status === 'completed'
      || turn.status === 'failed'
      || turn.status === 'aborted'
      || turn.status === 'interrupted'
      || turn.status === 'open'
      || turn.status === 'unknown'
    )
    && typeof turn.title === 'string'
    && isStringArray(turn.eventIds)
    && isNonNegativeInteger(turn.userMessageCount)
    && isNonNegativeInteger(turn.assistantMessageCount)
    && isNonNegativeInteger(turn.toolCallCount)
    && isNonNegativeInteger(turn.toolFailureCount)
  ));
}

function isTimelineTree(value: unknown): value is ExperienceTimelineTree {
  if (
    !isObjectRecord(value)
    || typeof value.sessionId !== 'string'
    || !isTimelineEventArray(value.main)
    || !Array.isArray(value.branches)
  ) return false;
  return value.branches.every((branch) => {
    if (
      !isObjectRecord(branch)
      || typeof branch.id !== 'string'
      || typeof branch.label !== 'string'
      || typeof branch.sessionId !== 'string'
      || !isOptionalString(branch.traceId)
      || typeof branch.sourceTrace !== 'string'
      || (
        branch.traceRole !== 'main'
        && branch.traceRole !== 'subagent'
        && branch.traceRole !== 'standalone'
      )
      || !isTimelineEventArray(branch.events)
    ) return false;
    if (branch.attachTo === undefined) return true;
    if (
      !isObjectRecord(branch.attachTo)
      || !isOptionalString(branch.attachTo.traceId)
      || typeof branch.attachTo.sourceTrace !== 'string'
    ) return false;
    return (branch.attachTo.messageIndex === undefined || isNonNegativeInteger(branch.attachTo.messageIndex))
      && (branch.attachTo.callInstanceId === undefined || typeof branch.attachTo.callInstanceId === 'string')
      && (branch.attachTo.toolUseId === undefined || typeof branch.attachTo.toolUseId === 'string')
      && (branch.attachTo.label === undefined || typeof branch.attachTo.label === 'string');
  });
}

function isExperienceChecklistItem(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.key === 'string'
    && typeof value.label === 'string'
    && isEnumValue(value.status, [
      'passed',
      'failed',
      'unknown',
      'not_declared',
      'not_applicable',
      'degraded',
    ])
    && isEnumValue(value.contribution, [
      'blocking',
      'attention',
      'informational',
      'positive',
      'neutral',
    ])
    && typeof value.reason === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs)
    && isEnumValue(value.source, ['deterministic_rule', 'llm_soft', 'manual'])
    && isOptionalString(value.suggestionKey);
}

function isExperienceSessionStoryGoalSlice(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && isStringArray(value.skillNames)
    && isTimestampRange(value.startTimestamp, value.endTimestamp)
    && isEnumValue(value.reasonCode, [
      'skill_segment_boundary',
      'explicit_user_goal_shift',
      'default_session_slice',
    ])
    && isOptionalString(value.inferredUserGoal)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceSessionStorySubagentDispatch(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || !isNonNegativeInteger(value.order)
    || typeof value.branchId !== 'string'
    || typeof value.childSessionId !== 'string'
    || typeof value.traceId !== 'string'
    || typeof value.label !== 'string'
    || typeof value.sourceTrace !== 'string'
    || !isNonNegativeInteger(value.eventCount)
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
  ) return false;
  if (value.attachTo === undefined) return true;
  return isObjectRecord(value.attachTo)
    && isOptionalNonNegativeInteger(value.attachTo.messageIndex)
    && isOptionalString(value.attachTo.callInstanceId)
    && isOptionalString(value.attachTo.toolUseId)
    && isOptionalString(value.attachTo.label);
}

function isExperienceSessionStorySkillLink(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && typeof value.skillName === 'string'
    && isEnumValue(value.role, ['router', 'executor', 'mixed', 'unknown'])
    && isStringArray(value.invocationIds)
    && isStringArray(value.goalSliceIds)
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceSessionStoryGraphNode(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && isEnumValue(value.kind, [
      'user_goal',
      'skill_invocation',
      'subagent_branch',
      'tool_execution',
      'delivery',
      'user_feedback',
      'goal_shift',
    ])
    && isEnumValue(value.status, ['ok', 'attention', 'unknown', 'degraded', 'not_applicable'])
    && (value.role === undefined || isEnumValue(value.role, ['router', 'executor', 'mixed', 'unknown']))
    && isOptionalString(value.detailNodeId);
}

function isExperienceSessionStoryGraphEdge(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.fromId === 'string'
    && typeof value.toId === 'string'
    && typeof value.label === 'string';
}

function isExperienceSessionStoryNode(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && isEnumValue(value.kind, [
      'user_goal',
      'skill_invocation',
      'subagent_branch',
      'tool_execution',
      'delivery',
      'user_feedback',
      'goal_shift',
    ])
    && typeof value.label === 'string'
    && isEnumValue(value.status, ['ok', 'attention', 'unknown', 'degraded', 'not_applicable'])
    && typeof value.text === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceSessionStoryAnswer(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.key, ['goal_satisfaction', 'declared_behavior_fit', 'user_feeling'])
    && typeof value.label === 'string'
    && isEnumValue(value.status, ['ok', 'attention', 'unknown', 'degraded', 'not_applicable'])
    && isEnumValue(value.reason, [
      'data_degraded',
      'blocking_failed',
      'attention_accumulated',
      'unknown_dominant',
      'all_passed',
      'not_applicable',
    ])
    && isStringArray(value.sourceItemKeys)
    && typeof value.text === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs)
    && Array.isArray(value.checklistItems)
    && value.checklistItems.every(isExperienceChecklistItem);
}

function isExperienceGoalEvidenceRef(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.kind, ['user_message', 'goal_slice', 'llm_goal'])
    && isOptionalString(value.goalSliceId)
    && (value.evidenceRef === undefined || isExperienceEvidenceRef(value.evidenceRef))
    && isOptionalString(value.label);
}

function isExperienceSkillSegment(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || !isNonNegativeInteger(value.order)
    || typeof value.skillName !== 'string'
    || !isEnumValue(value.skillType, [
      'router',
      'delegation',
      'executor',
      'advisory',
      'workflow_owner',
      'unknown',
    ])
    || (
      value.skillTypeSource !== undefined
      && !isEnumValue(value.skillTypeSource, ['frontmatter', 'trace', 'unknown'])
    )
    || (
      value.declaredSkillType !== undefined
      && !isEnumValue(value.declaredSkillType, [
        'router',
        'delegation',
        'executor',
        'advisory',
        'workflow_owner',
        'unknown',
      ])
    )
    || (
      value.traceInferredSkillType !== undefined
      && !isEnumValue(value.traceInferredSkillType, [
        'router',
        'delegation',
        'executor',
        'advisory',
        'workflow_owner',
        'unknown',
      ])
    )
    || !isEnumValue(value.episodeRole, [
      'main_executor',
      'router',
      'delegator',
      'supporting',
      'observer',
    ])
    || !isStringArray(value.skillInvocationIds)
    || !isOptionalNonNegativeInteger(value.startMessageIndex)
    || !isOptionalNonNegativeInteger(value.endMessageIndex)
    || !isTimestampRange(value.startTimestamp, value.endTimestamp)
    || !Array.isArray(value.typeSpecificChecklist)
    || !value.typeSpecificChecklist.every(isExperienceChecklistItem)
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
  ) return false;
  if (
    value.messageRanges !== undefined
    && (
      !Array.isArray(value.messageRanges)
      || value.messageRanges.some((range) =>
        !isObjectRecord(range)
        || !isNonNegativeInteger(range.startMessageIndex)
        || !isNonNegativeInteger(range.endMessageIndex)
        || range.startMessageIndex > range.endMessageIndex
        || !isOptionalString(range.traceId)
        || !isOptionalString(range.sourceTrace)
        || !isOptionalString(range.sessionId)
      )
    )
  ) return false;
  if (
    typeof value.startMessageIndex === 'number'
    && typeof value.endMessageIndex === 'number'
    && value.startMessageIndex > value.endMessageIndex
  ) return false;
  if (value.runtimeAssessment === undefined) return true;
  return isObjectRecord(value.runtimeAssessment)
    && isOptionalString(value.runtimeAssessment.goalSatisfaction)
    && isOptionalString(value.runtimeAssessment.declaredBehaviorFit)
    && isOptionalString(value.runtimeAssessment.artifactGoalMatch)
    && isOptionalString(value.runtimeAssessment.userFeeling);
}

function isExperienceOrchestrationEdge(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.episodeId === 'string'
    && isEnumValue(value.edgeKind, ['internal_skill', 'external_child_session'])
    && isOptionalString(value.parentSkillSegmentId)
    && isOptionalString(value.executorSkillSegmentId)
    && isOptionalString(value.childSessionId)
    && (value.runnerStartedRef === undefined || isExperienceEvidenceRef(value.runnerStartedRef))
    && (value.runnerCompletedRef === undefined || isExperienceEvidenceRef(value.runnerCompletedRef))
    && (value.notificationRef === undefined || isExperienceEvidenceRef(value.notificationRef))
    && isEnumValue(value.status, ['started', 'completed', 'failed', 'unknown'])
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceFeedbackAttribution(value: unknown): boolean {
  return isObjectRecord(value)
    && isOptionalString(value.skillName)
    && isOptionalString(value.skillSegmentId)
    && isEnumValue(value.attributionRole, ['primary_fault', 'downstream_related', 'context_only'])
    && isEnumValue(value.reasonCode, [
      'object_match',
      'promise_match',
      'action_match',
      'orchestration_edge',
      'episode_context',
    ])
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceFeedbackSignal(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && isEnumValue(value.type, [
      'correction',
      'follow_up',
      'frustration',
      'interruption',
      'positive',
      'unknown',
    ])
    && typeof value.text === 'string'
    && isOptionalString(value.targetObject)
    && isEnumValue(value.sourceWindow, [
      'session',
      'episode',
      'skill_invocation',
      'downstream_child',
    ])
    && isExperienceEvidenceRef(value.evidenceRef)
    && (
      value.canonicalAttributions === undefined
      || (
        Array.isArray(value.canonicalAttributions)
        && value.canonicalAttributions.every(isExperienceFeedbackAttribution)
      )
    )
    && Array.isArray(value.attributions)
    && value.attributions.every(isExperienceFeedbackAttribution);
}

function isExperienceEpisodeArtifact(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.kind, [
      'path',
      'url',
      'document',
      'code',
      'execution_window',
      'unknown',
    ])
    && typeof value.label === 'string'
    && isOptionalString(value.pathOrUrl)
    && isEnumValue(value.artifactGoalMatch, ['passed', 'failed', 'unknown'])
    && isExperienceEvidenceRef(value.evidenceRef);
}

function isExperienceEpisodeOutcome(value: unknown): boolean {
  return isObjectRecord(value)
    && isEnumValue(value.closure, ['closed', 'unresolved', 'abandoned', 'unknown'])
    && Array.isArray(value.artifacts)
    && value.artifacts.every(isExperienceEpisodeArtifact)
    && isExperienceReviewPriority(value.verdict)
    && isOptionalString(value.acceptanceCriteria);
}

function isExperienceEpisode(value: unknown): boolean {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && isNonNegativeInteger(value.order)
    && typeof value.sessionId === 'string'
    && isOptionalString(value.primaryGoal)
    && Array.isArray(value.goalEvidenceRefs)
    && value.goalEvidenceRefs.every(isExperienceGoalEvidenceRef)
    && isTimestampRange(value.startTimestamp, value.endTimestamp)
    && (value.startRef === undefined || isExperienceEvidenceRef(value.startRef))
    && (value.endRef === undefined || isExperienceEvidenceRef(value.endRef))
    && isEnumValue(value.boundaryReason, [
      'goal_shift',
      'checkpoint_or_subagent',
      'downstream_closed',
      'session_end',
    ])
    && Array.isArray(value.skillSegments)
    && value.skillSegments.every(isExperienceSkillSegment)
    && Array.isArray(value.orchestrationEdges)
    && value.orchestrationEdges.every(isExperienceOrchestrationEdge)
    && Array.isArray(value.feedbackSignals)
    && value.feedbackSignals.every(isExperienceFeedbackSignal)
    && isExperienceEpisodeOutcome(value.outcome);
}

function isExperienceStoryContext(value: unknown): value is ExperienceStoryContext {
  return isObjectRecord(value)
    && typeof value.id === 'string'
    && typeof value.sessionGroupKey === 'string'
    && Array.isArray(value.goalSlices)
    && value.goalSlices.every(isExperienceSessionStoryGoalSlice)
    && Array.isArray(value.subagentDispatches)
    && value.subagentDispatches.every(isExperienceSessionStorySubagentDispatch)
    && Array.isArray(value.episodes)
    && value.episodes.every(isExperienceEpisode);
}

function isExperienceSessionStory(value: unknown, compact: boolean): boolean {
  if (
    !isObjectRecord(value)
    || value.schemaVersion !== 1
    || (compact ? typeof value.contextRef !== 'string' : !isOptionalString(value.contextRef))
    || typeof value.summary !== 'string'
    || !isNonNegativeInteger(value.invocationCount)
    || !isNonNegativeInteger(value.goalSliceCount)
    || !isNonNegativeInteger(value.branchCount)
    || !isNonNegativeInteger(value.progressUpdateCount)
    || !isNonNegativeInteger(value.finalDeliverySignalCount)
    || !isStringArray(value.mainlineNodeIds)
    || !Array.isArray(value.skillLinks)
    || !value.skillLinks.every(isExperienceSessionStorySkillLink)
    || !isObjectRecord(value.graph)
    || !Array.isArray(value.graph.nodes)
    || !value.graph.nodes.every(isExperienceSessionStoryGraphNode)
    || !Array.isArray(value.graph.edges)
    || !value.graph.edges.every(isExperienceSessionStoryGraphEdge)
    || !Array.isArray(value.nodes)
    || !value.nodes.every(isExperienceSessionStoryNode)
    || !Array.isArray(value.answers)
    || !value.answers.every(isExperienceSessionStoryAnswer)
  ) return false;
  if (compact) {
    return value.goalSlices === undefined
      && value.subagentDispatches === undefined
      && value.episodes === undefined;
  }
  return Array.isArray(value.goalSlices)
    && value.goalSlices.every(isExperienceSessionStoryGoalSlice)
    && Array.isArray(value.subagentDispatches)
    && value.subagentDispatches.every(isExperienceSessionStorySubagentDispatch)
    && (
      value.episodes === undefined
      || (Array.isArray(value.episodes) && value.episodes.every(isExperienceEpisode))
    );
}

function isExperienceReviewerReportStep(value: unknown): boolean {
  return isObjectRecord(value)
    && isNonNegativeInteger(value.order)
    && typeof value.label === 'string'
    && isEnumValue(value.status, ['ok', 'attention', 'unknown', 'degraded', 'not_applicable'])
    && typeof value.text === 'string'
    && isExperienceEvidenceRefArray(value.evidenceRefs);
}

function isExperienceReviewerReportFinding(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.id !== 'string'
    || typeof value.judgmentId !== 'string'
    || !isEnumValue(value.source, ['deterministic_rule', 'llm_soft', 'manual'])
    || !isEnumValue(value.level, ['attention', 'possible_false_positive', 'note'])
    || typeof value.title !== 'string'
    || typeof value.body !== 'string'
    || typeof value.ruleSource !== 'string'
    || typeof value.ruleVersion !== 'string'
    || !isExperienceEvidenceRefArray(value.evidenceRefs)
    || !isObjectRecord(value.reviewStateRef)
    || value.reviewStateRef.targetType !== 'reviewer_judgment'
    || typeof value.reviewStateRef.targetId !== 'string'
  ) return false;
  return [
    value.reviewStateRef.verdict,
    value.reviewStateRef.reason,
    value.reviewStateRef.note,
  ].every(isOptionalString)
    && isOptionalTimestamp(value.reviewStateRef.reviewedAt);
}

function isExperienceReviewerMetrics(value: unknown, requireSourceNeutralOutcomes: boolean): boolean {
  if (!isObjectRecord(value)) return false;
  const countKeys = [
    'toolCallCount',
    'toolFailureCount',
    'userMessageCount',
    'userFollowUpCount',
    'assistantDeliverySignalCount',
    'deliverableArtifactSignalCount',
    'routerDownstreamCompleted',
    'routerDownstreamFailed',
    'assistantProgressUpdateCount',
    'selfCorrectionCount',
    'repeatedExecutionCount',
    'finalDeliverySignalCount',
    'traceEventCount',
  ];
  if (
    !countKeys.every((key) => isNonNegativeInteger(value[key]))
    || (
      requireSourceNeutralOutcomes
      && (
        !isNonNegativeInteger(value.toolCancelledCount)
        || !isNonNegativeInteger(value.toolUnknownCount)
      )
    )
    || (
      value.toolCancelledCount !== undefined
      && !isNonNegativeInteger(value.toolCancelledCount)
    )
    || (
      value.toolUnknownCount !== undefined
      && !isNonNegativeInteger(value.toolUnknownCount)
    )
    || !isObjectRecord(value.tokenUsage)
  ) return false;
  const tokenKeys = [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ];
  const tokenUsage = value.tokenUsage as Record<string, unknown>;
  const observedInvocationCount = tokenUsage.observedInvocationCount;
  const invocationCount = tokenUsage.invocationCount;
  const coverage = tokenUsage.coverage;
  const hasCoverage = observedInvocationCount !== undefined
    || invocationCount !== undefined
    || coverage !== undefined;
  return tokenKeys.every((key) => isNonNegativeInteger(tokenUsage[key]))
    && tokenUsage.attribution === 'skill_segment'
    && (
      !hasCoverage
      || (
        isNonNegativeInteger(observedInvocationCount)
        && isNonNegativeInteger(invocationCount)
        && isRate(coverage)
        && (observedInvocationCount as number) <= (invocationCount as number)
        && Math.abs(
          (coverage as number)
          - (
            (invocationCount as number) > 0
              ? (observedInvocationCount as number) / (invocationCount as number)
              : 1
          ),
        ) <= 0.0001
      )
    )
    && (!requireSourceNeutralOutcomes || hasCoverage)
    && (value.toolFailureCount as number)
      + (typeof value.toolCancelledCount === 'number' ? value.toolCancelledCount : 0)
      + (typeof value.toolUnknownCount === 'number' ? value.toolUnknownCount : 0)
      <= (value.toolCallCount as number);
}

function isExperienceReviewerReport(value: unknown, compact: boolean): boolean {
  if (
    !isObjectRecord(value)
    || value.schemaVersion !== 1
    || !isEnumValue(value.mode, ['deterministic_milestone_1', 'deterministic_session_story'])
    || !isTimestamp(value.generatedAt)
    || typeof value.title !== 'string'
    || typeof value.summary !== 'string'
    || !isObjectRecord(value.scope)
    || !isEnumValue(value.scope.kind, ['single_skill_single_goal', 'degraded_complex'])
    || !isStringArray(value.scope.reasonCodes)
    || !Array.isArray(value.chainSteps)
    || !value.chainSteps.every(isExperienceReviewerReportStep)
    || !Array.isArray(value.findings)
    || !value.findings.every(isExperienceReviewerReportFinding)
    || !isExperienceReviewerMetrics(value.oneLookMetrics, compact)
    || !isStringArray(value.authorSuggestions)
    || !isExperienceEvidenceRefArray(value.traceLinks)
  ) return false;
  if (compact) {
    return value.sessionStory === undefined && value.sessionStoryRef === 'session';
  }
  return isExperienceSessionStory(value.sessionStory, false)
    && (value.sessionStoryRef === undefined || value.sessionStoryRef === 'session');
}

/**
 * Converts a hydrated report into the wire format used by inbox JSON.
 * Timeline evidence is stored once per logical trace; consumers hydrate the
 * invocation/session views through normalizeObservationExperienceReport().
 */
export function compactObservationExperienceReport(
  report: ObservationExperienceReport,
): PersistedObservationExperienceReport {
  const hydrated = hydrateExperienceTimelines(report);
  return {
    ...hydrated,
    invocations: hydrated.invocations.map((invocation) => {
      const { timeline, ...persisted } = invocation;
      return {
        ...persisted,
        timelineRef: invocation.timelineRef
          ?? timelineRefForSessionGroup(invocation.sessionGroupKey),
        timelineEventIds: invocation.timelineEventIds
          ?? timeline.map((event) => event.id),
      };
    }),
    sessions: hydrated.sessions.map((session) => {
      const { timelinePreview, sessionStory, reviewerReport } = session;
      const persisted = omitProperties(session, [
        'attributedEventIds',
        'timelinePreview',
        'fullSessionTimeline',
        'timelineTree',
        'sessionStory',
        'reviewerReport',
      ]);
      const contextRef = sessionStory?.contextRef;
      return {
        ...persisted,
        timelineRef: session.timelineRef
          ?? timelineRefForSessionGroup(session.sessionId),
        timelinePreviewEventIds: session.timelinePreviewEventIds
          ?? timelinePreview.map((event) => event.id),
        sessionStory: sessionStory && contextRef
          ? compactSessionStory(sessionStory, contextRef)
          : undefined,
        reviewerReport: reviewerReport && sessionStory && contextRef
          ? {
              ...omitSessionStory(reviewerReport),
              sessionStoryRef: 'session',
            }
          : undefined,
      };
    }),
  };
}

function hydrateExperienceTimelines(
  report: ObservationExperienceReport,
): ObservationExperienceReport {
  const timelineById = new Map(report.traceTimelines.map((timeline) => [timeline.id, timeline]));
  const storyContextById = new Map(report.storyContexts.map((context) => [context.id, context]));
  const flattenedById = new Map<string, ExperienceTimelineEvent[]>();
  const eventByTimelineId = new Map<string, Map<string, ExperienceTimelineEvent>>();
  const flattenedTimeline = (ref: string): ExperienceTimelineEvent[] => {
    const cached = flattenedById.get(ref);
    if (cached) return cached;
    const timeline = timelineById.get(ref);
    if (!timeline) return [];
    const flattened = flattenTimelineTree(timeline.tree);
    flattenedById.set(ref, flattened);
    eventByTimelineId.set(ref, new Map(flattened.map((event) => [event.id, event])));
    return flattened;
  };
  const selectEvents = (
    ref: string,
    ids: string[] | undefined,
    fallback: ExperienceTimelineEvent[],
  ): ExperienceTimelineEvent[] => {
    if (!timelineById.has(ref)) return fallback;
    if (!ids) return fallback.length > 0 ? fallback : flattenedTimeline(ref);
    const byId = eventByTimelineId.get(ref)
      ?? new Map(flattenedTimeline(ref).map((event) => [event.id, event]));
    return ids.flatMap((id) => {
      const event = byId.get(id);
      return event ? [event] : [];
    });
  };

  const invocations = report.invocations.map((invocation): ExperienceInvocation => {
    const timelineRef = invocation.timelineRef ?? timelineRefForSessionGroup(invocation.sessionGroupKey);
    const timelineEventIds = invocation.timelineEventIds
      ?? invocation.timeline.map((event) => event.id);
    return {
      ...invocation,
      timelineRef,
      timelineEventIds,
      timeline: selectEvents(timelineRef, timelineEventIds, invocation.timeline),
    };
  });
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  const sessions = report.sessions.map((session): ExperienceSessionSummary => {
    const firstInvocation = session.invocationIds
      .map((id) => invocationById.get(id))
      .find((invocation): invocation is ExperienceInvocation => Boolean(invocation));
    const timelineRef = session.timelineRef
      ?? firstInvocation?.timelineRef
      ?? timelineRefForSessionGroup(firstInvocation?.sessionGroupKey ?? session.sessionId);
    const storedTimeline = timelineById.get(timelineRef);
    const fullSessionTimeline = storedTimeline
      ? flattenedTimeline(timelineRef)
      : session.fullSessionTimeline;
    const turns = session.turns.length > 0
      ? session.turns
      : reconstructExperienceTurns(fullSessionTimeline);
    const timelinePreviewEventIds = session.timelinePreviewEventIds
      ?? session.timelinePreview.map((event) => event.id);
    const timelinePreview = timelinePreviewEventIds.length > 0
      ? selectEvents(timelineRef, timelinePreviewEventIds, session.timelinePreview)
      : fullSessionTimeline.slice(0, TIMELINE_PREVIEW_EVENT_LIMIT);
    const attributedEventIds = unique(session.invocationIds.flatMap((id) => {
      const invocation = invocationById.get(id);
      return invocation?.timelineEventIds ?? invocation?.timeline.map((event) => event.id) ?? [];
    }));
    const contextRef = session.sessionStory?.contextRef
      ?? storyContextRefForSessionGroup(firstInvocation?.sessionGroupKey ?? session.sessionId);
    const storyContext = storyContextById.get(contextRef);
    const sessionStory = session.sessionStory
      ? {
          ...session.sessionStory,
          contextRef,
          goalSlices: storyContext?.goalSlices ?? session.sessionStory.goalSlices,
          subagentDispatches: storyContext?.subagentDispatches
            ?? session.sessionStory.subagentDispatches,
          episodes: storyContext?.episodes ?? session.sessionStory.episodes ?? [],
        }
      : undefined;
    return {
      ...session,
      timelineRef,
      attributedEventIds,
      timelinePreviewEventIds: timelinePreview.map((event) => event.id),
      timelinePreview,
      fullSessionTimeline,
      turns,
      timelineTree: storedTimeline?.tree ?? session.timelineTree,
      sessionStory,
      reviewerReport: session.reviewerReport && sessionStory
        ? {
            ...session.reviewerReport,
            sessionStory: session.reviewerReport.sessionStoryRef === 'session'
              ? sessionStory
              : session.reviewerReport.sessionStory,
          }
        : session.reviewerReport,
    };
  });

  return {
    ...report,
    schemaVersion: OBSERVATION_EXPERIENCE_SCHEMA_VERSION,
    invocations,
    sessions,
  };
}

function traceTimelinesFromSessions(
  sessions: ExperienceSessionSummary[],
  invocations: ExperienceInvocation[],
): ExperienceTraceTimeline[] {
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  const timelines = new Map<string, ExperienceTraceTimeline>();
  for (const session of sessions) {
    const invocation = session.invocationIds
      .map((id) => invocationById.get(id))
      .find((value): value is ExperienceInvocation => Boolean(value));
    const sessionGroupKey = invocation?.sessionGroupKey ?? session.sessionId;
    const id = session.timelineRef
      ?? invocation?.timelineRef
      ?? timelineRefForSessionGroup(sessionGroupKey);
    if (timelines.has(id)) continue;
    const fallbackEvents = session.fullSessionTimeline.length > 0
      ? session.fullSessionTimeline
      : session.timelinePreview;
    const tree = session.timelineTree ?? {
      sessionId: session.sessionId,
      main: fallbackEvents,
      branches: [],
    };
    timelines.set(id, {
      id,
      sessionGroupKey,
      sessionId: session.sessionId,
      eventCount: flattenTimelineTree(tree).length,
      tree,
    });
  }
  return Array.from(timelines.values());
}

function validateExperienceReferences(
  report: ObservationExperienceReport,
  strict: boolean,
): boolean {
  if (
    !isObjectRecord(report.meta)
    || report.meta.sessionCount !== report.sessions.length
    || report.meta.skillCount !== report.skills.length
    || report.meta.invocationCount !== report.invocations.length
    || report.meta.goalSliceCount !== report.goalSlices.length
  ) return false;

  const timelineEventsByRef = new Map<string, Set<string>>();
  const timelineByRef = new Map<string, ExperienceTraceTimeline>();
  const timelineSessionGroupKeys = new Set<string>();
  for (const timeline of report.traceTimelines) {
    if (
      timelineEventsByRef.has(timeline.id)
      || timelineSessionGroupKeys.has(timeline.sessionGroupKey)
    ) return false;
    if (
      timeline.tree.sessionId !== timeline.sessionId
      || (strict && !traceTimelineStructureIsConsistent(timeline))
    ) return false;
    const rawEvents = [
      ...timeline.tree.main,
      ...timeline.tree.branches.flatMap((branch) => branch.events),
    ];
    if (
      strict
      && (
        rawEvents.some((event) => typeof event.traceId !== 'string')
        || rawEvents.some((event) =>
          (event.kind === 'tool_use' || event.kind === 'tool_result')
          && typeof event.callInstanceId !== 'string'
        )
        || timeline.tree.branches.some((branch) =>
          typeof branch.traceId !== 'string'
          || (branch.attachTo !== undefined && typeof branch.attachTo.traceId !== 'string')
        )
      )
    ) return false;
    if (new Set(rawEvents.map((event) => event.id)).size !== rawEvents.length) return false;
    const events = flattenTimelineTree(timeline.tree);
    if (timeline.eventCount !== events.length) return false;
    timelineEventsByRef.set(timeline.id, new Set(events.map((event) => event.id)));
    timelineByRef.set(timeline.id, timeline);
    timelineSessionGroupKeys.add(timeline.sessionGroupKey);
  }

  const goalSliceIds = new Set<string>();
  const goalSliceById = new Map<string, ExperienceGoalSlice>();
  for (const goalSlice of report.goalSlices) {
    if (
      !isExperienceGoalSlice(goalSlice)
      || (
        strict
        && (
          typeof goalSlice.traceId !== 'string'
          || typeof goalSlice.timestampObserved !== 'boolean'
        )
      )
      || goalSliceIds.has(goalSlice.id)
    ) return false;
    goalSliceIds.add(goalSlice.id);
    goalSliceById.set(goalSlice.id, goalSlice as unknown as ExperienceGoalSlice);
  }

  const invocationById = new Map<string, ExperienceInvocation>();
  const referencedGoalSliceIds = new Set<string>();
  for (const invocation of report.invocations) {
    if (invocationById.has(invocation.id)) return false;
    invocationById.set(invocation.id, invocation);
    if (
      strict
      && (
        countRecordTotal(invocation.toolCounts) !== invocation.metrics.numToolCalls
        || !toolOutcomeCountsMatch(
          invocation.metrics,
          invocation.indicators,
        )
      )
    ) return false;
    if (!goalSliceIds.has(invocation.goalSliceId)) return false;
    const goalSlice = goalSliceById.get(invocation.goalSliceId);
    if (
      goalSlice
      && (
        goalSlice.skillName !== invocation.skillName
        || goalSlice.sessionId !== invocation.sessionId
        || goalSlice.sourceTrace !== invocation.sourceTrace
        || goalSlice.startTimestamp !== invocation.startTimestamp
        || goalSlice.endTimestamp !== invocation.endTimestamp
        || (
          strict
          && (
            goalSlice.traceId !== invocation.traceId
            || goalSlice.timestampObserved !== invocation.timestampObserved
          )
        )
      )
    ) return false;
    referencedGoalSliceIds.add(invocation.goalSliceId);
    if (strict && (!invocation.timelineRef || !invocation.timelineEventIds)) return false;
    if (!invocation.timelineRef) {
      if (invocation.timeline.length === 0 && (invocation.timelineEventIds?.length ?? 0) > 0) return false;
      continue;
    }
    const eventIds = timelineEventsByRef.get(invocation.timelineRef);
    if (!eventIds) return false;
    if (timelineByRef.get(invocation.timelineRef)?.sessionGroupKey !== invocation.sessionGroupKey) return false;
    if (
      invocation.timelineEventIds
      && new Set(invocation.timelineEventIds).size !== invocation.timelineEventIds.length
    ) return false;
    if (invocation.timelineEventIds?.some((id) => !eventIds.has(id))) return false;
  }
  if (referencedGoalSliceIds.size !== goalSliceIds.size) return false;

  const sessionIds = new Set<string>();
  const invocationReferenceCounts = new Map(
    report.invocations.map((invocation) => [invocation.id, 0]),
  );
  const referencedTimelineIds = new Set<string>();
  const referencedStoryContextIds = new Set<string>();
  for (const session of report.sessions) {
    if (sessionIds.has(session.id)) return false;
    sessionIds.add(session.id);
    if (
      session.invocationIds.length === 0
      || new Set(session.invocationIds).size !== session.invocationIds.length
      || session.invocationIds.some((id) => !invocationById.has(id))
    ) return false;
    if (session.goalSliceIds.some((id) => !goalSliceIds.has(id))) return false;
    const sessionInvocations = session.invocationIds
      .map((id) => invocationById.get(id))
      .filter((value): value is ExperienceInvocation => Boolean(value));
    const sessionGroupKeys = new Set(sessionInvocations.map((invocation) => invocation.sessionGroupKey));
    const invocationGoalSliceIds = new Set(sessionInvocations.map((invocation) => invocation.goalSliceId));
    if (
      sessionInvocations.some((invocation) => invocation.skillName !== session.skillName)
      || sessionGroupKeys.size !== 1
      || session.goalSliceIds.length !== invocationGoalSliceIds.size
      || session.goalSliceIds.some((id) => !invocationGoalSliceIds.has(id))
    ) return false;
    for (const invocation of sessionInvocations) {
      invocationReferenceCounts.set(
        invocation.id,
        (invocationReferenceCounts.get(invocation.id) ?? 0) + 1,
      );
    }
    if (strict) {
      const timestampedInvocations = sessionInvocations.filter(invocationTimestampObserved);
      const expectedStartTimestamp = minString(
        timestampedInvocations.map((invocation) => invocation.startTimestamp),
      ) ?? sessionInvocations[0]?.startTimestamp;
      const expectedEndTimestamp = maxString(
        timestampedInvocations.map((invocation) => invocation.endTimestamp),
      ) ?? sessionInvocations[0]?.endTimestamp;
      if (
        sessionInvocations.some((invocation) => invocation.timelineRef !== session.timelineRef)
      ) return false;
      const invocationIndicators = sumIndicators(
        sessionInvocations.map((invocation) => invocation.indicators),
      );
      const expectedIndicators = enrichRouterDownstreamIndicators({
        ...session,
        indicators: invocationIndicators,
      });
      const expectedReviewPriorityScore = scoreForIndicators(expectedIndicators);
      const expectedReviewPriority = session.reviewerReport
        ? priorityForReviewerFindings({
            ...session,
            indicators: expectedIndicators,
            reviewPriorityScore: expectedReviewPriorityScore,
          }, session.reviewerReport.findings)
        : priorityForScore(expectedReviewPriorityScore);
      if (
        !indicatorRecordsEqual(session.indicators, expectedIndicators)
        || session.reviewPriorityScore !== expectedReviewPriorityScore
        || session.reviewPriority !== expectedReviewPriority
        || !sameStringArray(
          session.reviewBasisCodes,
          basisCodesForIndicators(expectedIndicators),
        )
        || session.startTimestamp !== expectedStartTimestamp
        || session.endTimestamp !== expectedEndTimestamp
        || session.timestampedInvocationCount !== timestampedInvocations.length
        || session.timestampCoverage !== timestampedInvocations.length / sessionInvocations.length
      ) return false;
      const sessionGroupKey = sessionInvocations[0]?.sessionGroupKey;
      if (
        sessionGroupKey
        && timelineByRef.get(session.timelineRef ?? '')?.sessionGroupKey !== sessionGroupKey
      ) return false;
    }
    if (strict && (!session.timelineRef || !session.timelinePreviewEventIds)) return false;
    if (session.timelineRef) {
      referencedTimelineIds.add(session.timelineRef);
      const eventIds = timelineEventsByRef.get(session.timelineRef);
      const timeline = timelineByRef.get(session.timelineRef);
      if (!eventIds) return false;
      if (
        session.timelinePreviewEventIds
        && new Set(session.timelinePreviewEventIds).size !== session.timelinePreviewEventIds.length
      ) return false;
      if (session.timelinePreviewEventIds?.some((id) => !eventIds.has(id))) return false;
      if (
        strict
        && (
          timeline?.sessionId !== session.sessionId
          || !timelineScopeMatches(
            session,
            sessionInvocations,
            timeline,
          )
        )
      ) return false;
    } else if (
      session.fullSessionTimeline.length === 0
      && session.timelinePreview.length === 0
      && (session.timelinePreviewEventIds?.length ?? 0) > 0
    ) {
      return false;
    }
    if (session.sessionStory?.contextRef) {
      referencedStoryContextIds.add(session.sessionStory.contextRef);
    }
    if (
      strict
      && session.reviewerReport
      && !reviewerMetricsMatch(
        session.reviewerReport,
        session,
        sessionInvocations,
        timelineByRef.get(session.timelineRef ?? ''),
      )
    ) return false;
  }
  if (
    Array.from(invocationReferenceCounts.values()).some((count) => count !== 1)
    || (strict && referencedTimelineIds.size !== timelineEventsByRef.size)
  ) return false;

  const storyContextIds = new Set<string>();
  const storyContextById = new Map<string, ExperienceStoryContext>();
  const storyContextSessionGroupKeys = new Set<string>();
  for (const context of report.storyContexts) {
    if (
      storyContextIds.has(context.id)
      || storyContextSessionGroupKeys.has(context.sessionGroupKey)
    ) return false;
    storyContextIds.add(context.id);
    storyContextById.set(context.id, context);
    storyContextSessionGroupKeys.add(context.sessionGroupKey);
  }
  const skillNames = new Set<string>();
  for (const skill of report.skills) {
    if (
      !isExperienceSkillSummary(skill, strict)
      || skillNames.has(skill.skillName)
    ) return false;
    if (strict) {
      const skillInvocations = report.invocations.filter(
        (invocation) => invocation.skillName === skill.skillName,
      );
      const skillSessions = report.sessions.filter(
        (session) => session.skillName === skill.skillName,
      );
      const timestampedInvocations = skillInvocations.filter(invocationTimestampObserved);
      const expectedFirstSeen = minString(
        timestampedInvocations.map((invocation) => invocation.startTimestamp),
      ) ?? skillSessions[0]?.startTimestamp;
      const expectedLastSeen = maxString(
        timestampedInvocations.map((invocation) => invocation.endTimestamp),
      ) ?? skillSessions[0]?.endTimestamp;
      if (
        skill.invocationCount !== skillInvocations.length
        || skill.sessionCount !== skillSessions.length
        || !indicatorRecordsEqual(
          skill.indicators,
          sumIndicators(skillSessions.map((session) => session.indicators)),
        )
        || !countRecordsEqual(
          skill.toolCounts,
          sumRecordCounts(skillInvocations.map((invocation) => invocation.toolCounts)),
        )
        || skill.firstSeen !== expectedFirstSeen
        || skill.lastSeen !== expectedLastSeen
        || skill.timestampedInvocationCount !== timestampedInvocations.length
        || skill.timestampCoverage !== (
          skillInvocations.length > 0
            ? timestampedInvocations.length / skillInvocations.length
            : 0
        )
        || skill.reviewFirstSessionCount !== skillSessions.filter(
          (session) => session.reviewPriority === 'review_first',
        ).length
        || skill.sampleReviewSessionCount !== skillSessions.filter(
          (session) => session.reviewPriority === 'sample_review',
        ).length
      ) return false;
    }
    skillNames.add(skill.skillName);
  }
  if (
    report.sessions.some((session) => !skillNames.has(session.skillName))
    || report.invocations.some((invocation) => !skillNames.has(invocation.skillName))
    || (strict && referencedStoryContextIds.size !== storyContextIds.size)
  ) return false;
  return report.sessions.every((session) => {
    const contextRef = session.sessionStory?.contextRef;
    if (strict && session.sessionStory && !contextRef) return false;
    if (contextRef && !storyContextIds.has(contextRef)) return false;
    if (strict && contextRef) {
      const firstInvocation = session.invocationIds
        .map((id) => invocationById.get(id))
        .find((value): value is ExperienceInvocation => Boolean(value));
      const storyInvocations = firstInvocation
        ? report.invocations.filter(
            (invocation) => invocation.sessionGroupKey === firstInvocation.sessionGroupKey,
          )
        : [];
      const context = storyContextById.get(contextRef);
      const timeline = timelineByRef.get(session.timelineRef ?? '');
      if (
        firstInvocation
        && context?.sessionGroupKey !== firstInvocation.sessionGroupKey
      ) return false;
      if (
        session.sessionStory
        && context
        && timeline
        && !sessionStoryStructureIsConsistent(
          session.sessionStory,
          context,
          storyInvocations,
          timeline,
        )
      ) return false;
    }
    if (
      strict
      && session.reviewerReport
      && session.reviewerReport.sessionStoryRef !== 'session'
      && !isObjectRecord((session.reviewerReport as unknown as Record<string, unknown>).sessionStory)
    ) return false;
    return session.reviewerReport?.sessionStoryRef !== 'session' || Boolean(session.sessionStory);
  });
}

function sessionStoryStructureIsConsistent(
  story: ExperienceSessionStory,
  context: ExperienceStoryContext,
  invocations: ExperienceInvocation[],
  timeline: ExperienceTraceTimeline,
): boolean {
  const timelineEvents = flattenTimelineTree(timeline.tree);
  const expectedGoalSliceIds = new Set(invocations.map((invocation) => invocation.goalSliceId));
  const contextGoalSliceIds = context.goalSlices.map((goalSlice) => goalSlice.id);
  if (
    story.invocationCount !== invocations.length
    || story.goalSliceCount !== expectedGoalSliceIds.size
    || contextGoalSliceIds.length !== expectedGoalSliceIds.size
    || new Set(contextGoalSliceIds).size !== contextGoalSliceIds.length
    || contextGoalSliceIds.some((id) => !expectedGoalSliceIds.has(id))
    || story.branchCount !== timeline.tree.branches.length
    || story.progressUpdateCount !== timelineEvents.filter(isAssistantProgressUpdateEvent).length
    || story.finalDeliverySignalCount !== timelineEvents.filter(isAssistantDeliveryEvent).length
  ) return false;
  if (!storyContextEpisodesAreConsistent(context, invocations, timeline.sessionId)) return false;

  const branchById = new Map(timeline.tree.branches.map((branch) => [branch.id, branch]));
  if (
    context.subagentDispatches.length !== branchById.size
    || new Set(context.subagentDispatches.map((dispatch) => dispatch.id)).size
      !== context.subagentDispatches.length
    || new Set(context.subagentDispatches.map((dispatch) => dispatch.branchId)).size
      !== context.subagentDispatches.length
    || context.subagentDispatches.some((dispatch) => {
      const branch = branchById.get(dispatch.branchId);
      return !branch
        || dispatch.childSessionId !== branch.sessionId
        || dispatch.traceId !== (branch.traceId ?? branch.sourceTrace)
        || dispatch.sourceTrace !== branch.sourceTrace
        || dispatch.eventCount !== branch.events.length;
    })
  ) return false;

  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  const invocationReferenceCounts = new Map(
    invocations.map((invocation) => [invocation.id, 0]),
  );
  const skillLinkIds = new Set<string>();
  for (const link of story.skillLinks) {
    if (
      skillLinkIds.has(link.id)
      || new Set(link.invocationIds).size !== link.invocationIds.length
      || link.invocationIds.some((id) => !invocationById.has(id))
    ) return false;
    skillLinkIds.add(link.id);
    const linkedInvocations = link.invocationIds
      .map((id) => invocationById.get(id))
      .filter((value): value is ExperienceInvocation => Boolean(value));
    const linkedGoalSliceIds = new Set(
      linkedInvocations.map((invocation) => invocation.goalSliceId),
    );
    if (
      linkedInvocations.some((invocation) => invocation.skillName !== link.skillName)
      || link.goalSliceIds.length !== linkedGoalSliceIds.size
      || link.goalSliceIds.some((id) => !linkedGoalSliceIds.has(id))
    ) return false;
    for (const invocation of linkedInvocations) {
      invocationReferenceCounts.set(
        invocation.id,
        (invocationReferenceCounts.get(invocation.id) ?? 0) + 1,
      );
    }
  }
  if ([...invocationReferenceCounts.values()].some((count) => count !== 1)) return false;

  const nodeIds = story.nodes.map((node) => node.id);
  const nodeIdSet = new Set(nodeIds);
  const graphNodeIds = story.graph.nodes.map((node) => node.id);
  const expectedGraphNodeIds = new Set([...nodeIds, ...skillLinkIds]);
  if (
    nodeIdSet.size !== nodeIds.length
    || new Set(story.mainlineNodeIds).size !== story.mainlineNodeIds.length
    || story.mainlineNodeIds.some((id) => !nodeIdSet.has(id))
    || new Set(graphNodeIds).size !== graphNodeIds.length
    || graphNodeIds.length !== expectedGraphNodeIds.size
    || graphNodeIds.some((id) => !expectedGraphNodeIds.has(id))
    || story.graph.nodes.some((node) =>
      node.detailNodeId !== undefined && !nodeIdSet.has(node.detailNodeId)
    )
    || story.graph.edges.some((edge) =>
      !expectedGraphNodeIds.has(edge.fromId) || !expectedGraphNodeIds.has(edge.toId)
    )
  ) return false;

  return true;
}

function timelineScopeMatches(
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  timeline: ExperienceTraceTimeline | undefined,
): boolean {
  if (!timeline) return false;
  const events = flattenTimelineTree(timeline.tree);
  const eventById = new Map(events.map((event) => [event.id, event]));
  const invocationEventIds = new Set(
    invocations.flatMap((invocation) => invocation.timelineEventIds ?? []),
  );
  const previewEventIds = session.timelinePreviewEventIds ?? [];
  if (previewEventIds.some((id) => !invocationEventIds.has(id))) return false;
  const invocationEvents = [...invocationEventIds]
    .map((id) => eventById.get(id))
    .filter((event): event is ExperienceTimelineEvent => Boolean(event));
  if (invocationEvents.length !== invocationEventIds.size) return false;
  const previewEvents = previewEventIds
    .map((id) => eventById.get(id))
    .filter((event): event is ExperienceTimelineEvent => Boolean(event));
  const eventPositionById = new Map(events.map((event, index) => [event.id, index]));
  const previewPositions = previewEventIds
    .map((id) => eventPositionById.get(id))
    .filter((index): index is number => typeof index === 'number');
  const omittedBeforeCount = previewPositions.length > 0 ? Math.min(...previewPositions) : 0;
  const omittedAfterCount = previewPositions.length > 0
    ? events.length - 1 - Math.max(...previewPositions)
    : 0;
  const scope = session.timelineScope;
  return sameStringSet(session.attributedEventIds, invocationEventIds)
    && scope.segmentEventCount === invocationEventIds.size
    && scope.previewEventCount === previewEventIds.length
    && scope.fullSessionEventCount === events.length
    && traceRecordRangesEqual(scope.segmentRecordRanges, traceRecordRanges(invocationEvents))
    && traceRecordRangesEqual(scope.previewRecordRanges, traceRecordRanges(previewEvents))
    && traceRecordRangesEqual(scope.sessionRecordRanges, traceRecordRanges(events))
    && scope.omittedBeforeCount === omittedBeforeCount
    && scope.omittedAfterCount === omittedAfterCount
    && scope.truncated === (
      invocationEventIds.size > previewEventIds.length
      || omittedBeforeCount > 0
      || omittedAfterCount > 0
    );
}

function traceRecordRangesEqual(
  left: ExperienceTraceRecordRange[],
  right: ExperienceTraceRecordRange[],
): boolean {
  return left.length === right.length
    && left.every((range, index) =>
      range.traceId === right[index].traceId
      && range.sourceTrace === right[index].sourceTrace
      && range.startRecordIndex === right[index].startRecordIndex
      && range.endRecordIndex === right[index].endRecordIndex
      && range.eventCount === right[index].eventCount
    );
}

function storyContextEpisodesAreConsistent(
  context: ExperienceStoryContext,
  invocations: ExperienceInvocation[],
  sessionId: string,
): boolean {
  const goalSliceIds = new Set(context.goalSlices.map((goalSlice) => goalSlice.id));
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  const episodeIds = new Set<string>();
  for (const episode of context.episodes) {
    if (episodeIds.has(episode.id) || episode.sessionId !== sessionId) return false;
    episodeIds.add(episode.id);

    const skillSegmentById = new Map<string, ExperienceSkillSegment>();
    for (const segment of episode.skillSegments) {
      if (
        skillSegmentById.has(segment.id)
        || new Set(segment.skillInvocationIds).size !== segment.skillInvocationIds.length
        || segment.skillInvocationIds.some((id) => invocationById.get(id)?.skillName !== segment.skillName)
        || Date.parse(segment.startTimestamp) < Date.parse(episode.startTimestamp)
        || Date.parse(segment.endTimestamp) > Date.parse(episode.endTimestamp)
      ) return false;
      skillSegmentById.set(segment.id, segment);
    }

    const edgeIds = new Set<string>();
    for (const edge of episode.orchestrationEdges) {
      const parent = edge.parentSkillSegmentId
        ? skillSegmentById.get(edge.parentSkillSegmentId)
        : undefined;
      const executor = edge.executorSkillSegmentId
        ? skillSegmentById.get(edge.executorSkillSegmentId)
        : undefined;
      if (
        edgeIds.has(edge.id)
        || edge.episodeId !== episode.id
        || (edge.parentSkillSegmentId !== undefined && !parent)
        || (edge.executorSkillSegmentId !== undefined && !executor)
        || (
          edge.edgeKind === 'internal_skill'
          && (!parent || !executor || parent.id === executor.id)
        )
      ) return false;
      edgeIds.add(edge.id);
    }

    const signalIds = new Set<string>();
    for (const signal of episode.feedbackSignals) {
      if (signalIds.has(signal.id)) return false;
      signalIds.add(signal.id);
      const attributionGroups = [
        signal.attributions,
        signal.canonicalAttributions ?? [],
      ];
      for (const attribution of attributionGroups.flat()) {
        if (!attribution.skillSegmentId) continue;
        const segment = skillSegmentById.get(attribution.skillSegmentId);
        if (!segment || (attribution.skillName && attribution.skillName !== segment.skillName)) {
          return false;
        }
      }
    }

    if (episode.goalEvidenceRefs.some((ref) =>
      ref.kind === 'goal_slice'
        ? !ref.goalSliceId || !goalSliceIds.has(ref.goalSliceId)
        : ref.goalSliceId !== undefined && !goalSliceIds.has(ref.goalSliceId)
    )) return false;
  }
  return true;
}

function traceTimelineStructureIsConsistent(timeline: ExperienceTraceTimeline): boolean {
  const branches = timeline.tree.branches;
  if (new Set(branches.map((branch) => branch.id)).size !== branches.length) return false;
  if (timeline.tree.main.some((event) => event.sessionId !== timeline.sessionId)) return false;
  const mainTraceIds = new Set(
    timeline.tree.main
      .map((event) => event.traceId)
      .filter((value): value is string => Boolean(value)),
  );
  const mainSourceTraces = new Set(timeline.tree.main.map((event) => event.sourceTrace));
  if (mainTraceIds.size > 1 || mainSourceTraces.size > 1) return false;

  for (const branch of branches) {
    if (branch.events.some((event) =>
      event.sessionId !== timeline.sessionId
      || (branch.traceId !== undefined && event.traceId !== branch.traceId)
      || event.sourceTrace !== branch.sourceTrace
      || event.traceRole !== branch.traceRole
    )) return false;
    if (
      branch.attachTo
      && !timeline.tree.main.some((event) =>
        (
          branch.attachTo?.traceId !== undefined
            ? event.traceId === branch.attachTo.traceId
            : event.sourceTrace === branch.attachTo?.sourceTrace
        )
        && event.sourceTrace === branch.attachTo?.sourceTrace
        && (
          branch.attachTo.messageIndex === undefined
          || event.messageIndex === branch.attachTo.messageIndex
        )
        && (
          branch.attachTo.callInstanceId === undefined
          || event.callInstanceId === branch.attachTo.callInstanceId
        )
        && (
          branch.attachTo.toolUseId === undefined
          || event.toolUseId === branch.attachTo.toolUseId
        )
        && (
          branch.attachTo.label === undefined
          || event.label === branch.attachTo.label
          || event.toolName === branch.attachTo.label
        )
      )
    ) return false;
  }
  return true;
}

type ToolOutcomeSummary = Pick<
  ExperienceReviewIndicators,
  'toolCallCount' | 'toolFailureCount' | 'toolCancelledCount' | 'toolUnknownCount'
>;

type InvocationToolOutcomeSummary = Pick<
  ExperienceInvocation['metrics'],
  'numToolCalls' | 'numToolFailures' | 'numToolCancelled' | 'numToolUnknown'
>;

function toolOutcomeCountsMatch(
  left: ToolOutcomeSummary | InvocationToolOutcomeSummary,
  right: ToolOutcomeSummary,
): boolean {
  const normalized = 'numToolCalls' in left
    ? {
        toolCallCount: left.numToolCalls,
        toolFailureCount: left.numToolFailures,
        toolCancelledCount: left.numToolCancelled,
        toolUnknownCount: left.numToolUnknown,
      }
    : left;
  return normalized.toolCallCount === right.toolCallCount
    && normalized.toolFailureCount === right.toolFailureCount
    && (normalized.toolCancelledCount ?? 0) === (right.toolCancelledCount ?? 0)
    && (normalized.toolUnknownCount ?? 0) === (right.toolUnknownCount ?? 0);
}

function indicatorRecordsEqual(
  left: ExperienceReviewIndicators,
  right: ExperienceReviewIndicators,
): boolean {
  const keys = [
    ...EXPERIENCE_INDICATOR_KEYS,
    'toolCancelledCount',
    'toolUnknownCount',
  ] as const;
  return keys.every((key) => (left[key] ?? 0) === (right[key] ?? 0));
}

function reviewerMetricsMatch(
  reviewer: ExperienceReviewerReport,
  session: ExperienceSessionSummary,
  invocations: ExperienceInvocation[],
  timeline: ExperienceTraceTimeline | undefined,
): boolean {
  const metrics = reviewer.oneLookMetrics;
  const expectedUsage = sumTokenUsage(invocations);
  const timelineEvents = timeline ? flattenTimelineTree(timeline.tree) : [];
  const hydratedSession = {
    ...session,
    fullSessionTimeline: timelineEvents,
    timelineTree: timeline?.tree,
  };
  return toolOutcomeCountsMatch(
    metrics,
    session.indicators,
  )
    && metrics.userMessageCount === session.indicators.userMessageCount
    && metrics.assistantDeliverySignalCount === session.indicators.assistantDeliverySignalCount
    && metrics.deliverableArtifactSignalCount === session.indicators.deliverableArtifactSignalCount
    && metrics.routerDownstreamCompleted === session.indicators.routerDownstreamCompleted
    && metrics.routerDownstreamFailed === session.indicators.routerDownstreamFailed
    && metrics.assistantProgressUpdateCount === assistantProgressUpdateEvents(hydratedSession).length
    && metrics.selfCorrectionCount === session.indicators.selfCorrectionCount
    && metrics.repeatedExecutionCount === session.indicators.repeatedExecutionCount
    && metrics.finalDeliverySignalCount === assistantFinalDeliveryEvents(hydratedSession).length
    && metrics.traceEventCount === timelineEvents.length
    && metrics.tokenUsage.inputTokens === expectedUsage.inputTokens
    && metrics.tokenUsage.outputTokens === expectedUsage.outputTokens
    && metrics.tokenUsage.cacheReadTokens === expectedUsage.cacheReadTokens
    && metrics.tokenUsage.cacheCreationTokens === expectedUsage.cacheCreationTokens
    && metrics.tokenUsage.observedInvocationCount === expectedUsage.observedInvocationCount
    && metrics.tokenUsage.invocationCount === expectedUsage.invocationCount
    && metrics.tokenUsage.coverage === expectedUsage.coverage;
}

function countRecordTotal(value: Record<string, number>): number {
  return sumSafeCounts(...Object.values(value));
}

function countRecordsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => (left[key] ?? 0) === (right[key] ?? 0));
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSet(left: string[], right: Set<string>): boolean {
  return left.length === right.size
    && new Set(left).size === left.length
    && left.every((value) => right.has(value));
}

function storyContextsFromSessions(
  sessions: ExperienceSessionSummary[],
  invocations: ExperienceInvocation[],
): ExperienceStoryContext[] {
  const invocationById = new Map(invocations.map((invocation) => [invocation.id, invocation]));
  const contexts = new Map<string, ExperienceStoryContext>();
  for (const session of sessions) {
    const story = session.sessionStory;
    if (!story) continue;
    const invocation = session.invocationIds
      .map((id) => invocationById.get(id))
      .find((value): value is ExperienceInvocation => Boolean(value));
    const sessionGroupKey = invocation?.sessionGroupKey ?? session.sessionId;
    const id = story.contextRef ?? storyContextRefForSessionGroup(sessionGroupKey);
    if (contexts.has(id)) continue;
    contexts.set(id, {
      id,
      sessionGroupKey,
      goalSlices: story.goalSlices,
      subagentDispatches: story.subagentDispatches,
      episodes: story.episodes ?? [],
    });
  }
  return Array.from(contexts.values());
}

function timelineRefForSessionGroup(sessionGroupKey: string): string {
  return hashParts('trace-timeline', sessionGroupKey);
}

function storyContextRefForSessionGroup(sessionGroupKey: string): string {
  return hashParts('story-context', sessionGroupKey);
}

function flattenTimelineTree(tree: ExperienceTimelineTree): ExperienceTimelineEvent[] {
  return uniqueTimelineEvents([
    ...tree.main,
    ...tree.branches.flatMap((branch) => branch.events),
  ]).sort(compareTimelineEvents);
}

function compactSessionStory(
  story: ExperienceSessionStory,
  contextRef: string,
): PersistedExperienceSessionStory {
  const persisted = omitProperties(story, [
    'goalSlices',
    'subagentDispatches',
    'episodes',
  ]);
  return { ...persisted, contextRef };
}

function omitSessionStory(
  report: ExperienceReviewerReport,
): Omit<ExperienceReviewerReport, 'sessionStory' | 'sessionStoryRef'> {
  return omitProperties(report, ['sessionStory', 'sessionStoryRef']);
}

function omitProperties<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
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

function logicalSessionId(session: TraceSession): string {
  return session.rootRunId;
}

function experienceSessionGroupKey(session: TraceSession): string {
  const logicalId = logicalSessionId(session);
  if (session.role !== 'standalone' && session.groupPath) {
    return `group:${session.groupPath}\u0000${logicalId}`;
  }
  return `trace:${session.traceId}`;
}

function groupSessionsByExperienceKey(sessions: TraceSession[]): Map<string, TraceSession[]> {
  const groups = new Map<string, TraceSession[]>();
  for (const session of sessions) {
    const key = experienceSessionGroupKey(session);
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  for (const [key, group] of groups.entries()) {
    groups.set(key, group.sort(compareSessionsForTimeline));
  }
  return groups;
}

function compareSessionsForTimeline(a: TraceSession, b: TraceSession): number {
  const roleRank = (session: TraceSession): number => session.role === 'main' ? 0 : session.role === 'standalone' ? 1 : 2;
  const rank = roleRank(a) - roleRank(b);
  if (rank !== 0) return rank;
  const time = (a.startTimestamp ?? '').localeCompare(b.startTimestamp ?? '');
  if (time !== 0) return time;
  return a.sourcePath.localeCompare(b.sourcePath)
    || a.traceId.localeCompare(b.traceId);
}

function timestampsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return true;
  return aStart <= bEnd && bStart <= aEnd;
}

function segmentRecordBounds(session: TraceSession, segment: SkillSegment): { start: number; end: number } {
  if (typeof segment.startRecordIndex === 'number' && typeof segment.endRecordIndex === 'number') {
    const rawStart = eventIndexForSourceIndex(session, segment.startRecordIndex, 'first');
    const rawEnd = eventIndexForSourceIndex(
      session,
      Math.max(segment.startRecordIndex, segment.endRecordIndex),
      'last',
    );
    const humanStart = Math.min(rawStart, previousHumanUserRecordIndex(session, rawStart) ?? rawStart);
    return {
      start: includeLeadingRuntimeContext(session, humanStart),
      end: includeTrailingDeliveryContext(session, Math.min(session.events.length, rawEnd + 1)),
    };
  }
  const indexes = segment.toolCalls
    .map((toolCall) => toolCall.messageIndex)
    .filter((index): index is number => typeof index === 'number' && index >= 0);
  if (indexes.length > 0) {
    const firstEventIndex = eventIndexForSourceIndex(session, Math.min(...indexes), 'first');
    const lastEventIndex = eventIndexForSourceIndex(session, Math.max(...indexes), 'last');
    const start = Math.max(0, firstEventIndex - 3);
    return {
      start: Math.min(start, previousHumanUserRecordIndex(session, start) ?? start),
      end: includeTrailingDeliveryContext(session, Math.min(session.events.length, lastEventIndex + 5)),
    };
  }
  const timestampIndexes: number[] = [];
  session.events.forEach((event, index) => {
    const ts = event.timestamp;
    if (ts && ts >= segment.startTimestamp && ts <= segment.endTimestamp) timestampIndexes.push(index);
  });
  if (timestampIndexes.length === 0) return { start: 0, end: Math.min(session.events.length, 12) };
  const start = Math.max(0, Math.min(...timestampIndexes) - 2);
  return {
    start: Math.min(start, previousHumanUserRecordIndex(session, start) ?? start),
    end: includeTrailingDeliveryContext(session, Math.min(session.events.length, Math.max(...timestampIndexes) + 3)),
  };
}

function clampRecordIndex(session: TraceSession, index: number): number {
  return Math.max(0, Math.min(session.events.length - 1, index));
}

function eventIndexForSourceIndex(
  session: TraceSession,
  sourceIndex: number,
  edge: 'first' | 'last',
): number {
  if (edge === 'first') {
    const index = session.events.findIndex((event) => event.sourceIndex >= sourceIndex);
    return index < 0 ? clampRecordIndex(session, sourceIndex) : index;
  }
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    if (session.events[index].sourceIndex <= sourceIndex) return index;
  }
  return 0;
}

function includeLeadingRuntimeContext(session: TraceSession, start: number): number {
  let nextStart = start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const events = timelineEventsFromTraceEvent(session, session.events[index], index);
    if (events.length === 0) continue;
    if (events.some((event) => event.kind === 'runtime_context')) {
      nextStart = index;
      continue;
    }
    break;
  }
  return nextStart;
}

function includeTrailingDeliveryContext(session: TraceSession, end: number): number {
  const safeEnd = Math.min(session.events.length, Math.max(0, end));
  const lookaheadEnd = Math.min(session.events.length, safeEnd + 8);
  for (let index = safeEnd; index < lookaheadEnd; index += 1) {
    const events = timelineEventsFromTraceEvent(session, session.events[index], index);
    if (events.some((event) => event.kind === 'user_message')) break;
    if (events.some(isAssistantDeliveryEvent)) return index + 1;
  }
  return safeEnd;
}

function previousHumanUserRecordIndex(session: TraceSession, start: number): number | undefined {
  for (let index = Math.min(start, session.events.length - 1); index >= 0; index -= 1) {
    const events = timelineEventsFromTraceEvent(session, session.events[index], index);
    if (events.some((event) => event.kind === 'user_message')) return index;
  }
  return undefined;
}

function isAssistantDeliveryEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return hasAssistantDeliverySignalText(text);
}

function isAssistantDeliverableArtifactEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return hasAssistantDeliverableArtifactText(text);
}

function isAssistantProgressUpdateEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return isAssistantProgressUpdateText(text);
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

function buildInvocationTimeline(
  session: TraceSession,
  start: number,
  end: number,
  segment: SkillSegment,
): ExperienceTimelineEvent[] {
  const window = buildTimelineWindow(session, start, end);
  const callInstanceIds = new Set(
    segment.toolCalls.flatMap((toolCall) =>
      toolCall.callInstanceId ? [toolCall.callInstanceId] : []
    ),
  );
  const legacyCallIds = new Set(
    segment.toolCalls.flatMap((toolCall) =>
      !toolCall.callInstanceId && toolCall.toolUseId ? [toolCall.toolUseId] : []
    ),
  );
  if (callInstanceIds.size === 0 && legacyCallIds.size === 0) return window;
  const linkedResults = session.events.flatMap((event, eventIndex) =>
    event.eventKind === 'tool_result'
    && (
      event.callInstanceId
        ? callInstanceIds.has(event.callInstanceId)
        : legacyCallIds.has(event.callId)
    )
    && (eventIndex < start || eventIndex >= end)
      ? timelineEventsFromTraceEvent(session, event, eventIndex)
      : [],
  );
  return uniqueTimelineEvents([...window, ...linkedResults]).sort(compareTimelineEvents);
}

function buildTimelineWindow(session: TraceSession, start: number, end: number): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const safeEnd = Math.min(session.events.length, Math.max(start, end));
  for (let index = start; index < safeEnd; index += 1) {
    events.push(...timelineEventsFromTraceEvent(session, session.events[index], index));
  }
  return events.sort((a, b) => a.order - b.order);
}

/** Project one source-neutral Trace IR session into Studio's semantic timeline. */
export function projectTraceSessionTimeline(session: TraceSession): ExperienceTimelineEvent[] {
  return buildTimelineWindow(session, 0, session.events.length);
}

function timelineEventsFromTraceEvent(
  session: TraceSession,
  event: TraceEvent,
  eventIndex: number,
): ExperienceTimelineEvent[] {
  const messageIndex = event.sourceIndex;
  const base = {
    traceId: session.traceId,
    sourceTrace: session.sourcePath,
    sessionId: logicalSessionId(session),
    traceRole: session.role,
    traceLabel: session.label,
    messageIndex,
    logicalMessageIndex: messageIndex,
    sourceLineIndex: messageIndex,
    messageUuid: event.sourceEventId ?? event.eventId,
    sourceType: event.sourceType,
    turnId: event.turnId,
    timestamp: event.timestamp,
  };
  const order = eventIndex * 10;

  if (event.eventKind === 'message' && event.role === 'user') {
    return userTimelineEvents(event, base, order);
  }
  if (event.eventKind === 'message' && event.role === 'system') {
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'tool',
      order,
      snippet: snippet(event.text, 700),
      fullText: fullText(event.text),
      label: 'system context',
    })];
  }
  if (event.eventKind === 'message' && event.role === 'assistant') {
    const protocolReply = isAssistantProtocolReplyText(event.text);
    return [timelineEvent({
      ...base,
      kind: protocolReply ? 'runtime_context' : 'assistant_message',
      role: 'assistant',
      order,
      model: event.model,
      snippet: snippet(event.text, 700),
      fullText: fullText(event.text),
      label: protocolReply ? 'assistant protocol reply' : 'assistant message',
    })];
  }
  if (event.eventKind === 'model_activity') {
    return [timelineEvent({
      ...base,
      kind: 'model_activity',
      role: 'assistant',
      order,
      model: event.model,
      modelActivityKind: event.activityKind,
      contentVisibility: event.contentVisibility,
      contentSource: event.contentSource,
      snippet: snippet(event.text, 700),
      fullText: fullText(event.text),
      label: 'model reasoning',
    })];
  }
  if (event.eventKind === 'tool_call') {
    const inputText = JSON.stringify(event.input);
    return [timelineEvent({
      ...base,
      kind: 'tool_use',
      role: 'assistant',
      order,
      callInstanceId: event.callInstanceId,
      toolUseId: event.callId,
      toolName: event.tool.displayName ?? event.tool.name,
      snippet: snippet(inputText, 900),
      fullText: fullText(inputText),
      label: `tool_use ${event.tool.displayName ?? event.tool.name}`,
    })];
  }
  if (event.eventKind === 'tool_result') {
    const failed = event.status === 'failure';
    return [timelineEvent({
      ...base,
      kind: 'tool_result',
      role: 'tool',
      order,
      callInstanceId: event.callInstanceId,
      toolUseId: event.callId,
      toolStatus: event.status,
      isError: failed,
      snippet: snippet(event.output, 900),
      fullText: fullText(event.output),
      label: failed
        ? 'tool result error'
        : event.status === 'cancelled' ? 'tool result cancelled'
        : event.status === 'unknown' ? 'tool result status unknown' : 'tool result',
    })];
  }
  if (event.eventKind === 'lifecycle') {
    return [timelineEvent({
      ...base,
      kind: 'lifecycle',
      role: 'other',
      order,
      snippet: snippet(`${event.phase}${event.reason ? `: ${event.reason}` : ''}`, 700),
      fullText: fullText(JSON.stringify(event)),
      label: event.phase,
    })];
  }
  if (event.eventKind === 'runtime_context') {
    const details = JSON.stringify({
      runtimeName: event.runtimeName,
      runtimeVersion: event.runtimeVersion,
      cwd: event.cwd,
      workspaceRoots: event.workspaceRoots,
      currentDate: event.currentDate,
      timezone: event.timezone,
      model: event.model,
      modelProvider: event.modelProvider,
      serviceTier: event.serviceTier,
      reasoningEffort: event.reasoningEffort,
      reasoningSummary: event.reasoningSummary,
      personality: event.personality,
      approvalPolicy: event.approvalPolicy,
      approvalReviewer: event.approvalReviewer,
      permissionProfile: event.permissionProfile,
      sandboxMode: event.sandboxMode,
      collaborationMode: event.collaborationMode,
      realtimeActive: event.realtimeActive,
      multiAgentMode: event.multiAgentMode,
      multiAgentVersion: event.multiAgentVersion,
      memoryMode: event.memoryMode,
      historyMode: event.historyMode,
      contextWindowId: event.contextWindowId,
      parentRunId: event.parentRunId,
      delegationDepth: event.delegationDepth,
      sourceOrigin: event.sourceOrigin,
      availableTools: event.availableTools,
      instructions: event.instructions,
      goal: event.goal,
      goalStatus: event.goalStatus,
      summary: event.summary,
    });
    const visible = event.summary
      ?? event.goal
      ?? event.instructions
      ?? [event.runtimeName, event.runtimeVersion, event.cwd, event.model, event.reasoningEffort, event.collaborationMode]
        .filter(Boolean)
        .join(' · ');
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      model: event.model,
      runtimeKind: event.runtimeKind,
      snippet: snippet(visible, 700),
      fullText: fullText(details),
      label: event.runtimeKind,
    })];
  }
  if (event.eventKind === 'context_compaction') {
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      runtimeKind: 'context_compaction',
      snippet: snippet(event.summary ?? 'context compacted', 700),
      fullText: fullText(JSON.stringify(event)),
      label: 'context compacted',
    })];
  }
  if (event.eventKind === 'agent_activity') {
    const visible = event.text
      ?? [event.activity, event.author, event.recipient, event.agentPath, event.agentId]
        .filter(Boolean)
        .join(' · ');
    return [timelineEvent({
      ...base,
      kind: 'agent_activity',
      role: 'other',
      order,
      snippet: snippet(visible, 700),
      fullText: fullText(JSON.stringify({
        activityKind: event.activityKind,
        activity: event.activity,
        author: event.author,
        recipient: event.recipient,
        agentId: event.agentId,
        agentPath: event.agentPath,
        text: event.text,
      })),
      label: event.activityKind === 'communication' ? 'agent communication' : 'agent status',
    })];
  }
  if (event.eventKind === 'usage') {
    const usageText = JSON.stringify({
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      reasoningTokens: event.reasoningTokens,
    });
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      model: event.model,
      runtimeKind: 'usage',
      snippet: snippet(usageText, 700),
      fullText: fullText(usageText),
      label: 'token usage',
    })];
  }
  if (event.eventKind === 'unknown') {
    const rawText = safeRecordText(event.raw);
    if (!hasAssistantTurnFailedText(rawText)) return [];
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      snippet: snippet(rawText, 700),
      fullText: fullText(rawText),
      label: event.sourceType,
    })];
  }
  return [];
}

function userTimelineEvents(
  event: TraceMessageEvent,
  base: Omit<ExperienceTimelineEvent, 'id' | 'kind' | 'order'>,
  order: number,
): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const commandEnvelope = extractCommandEnvelopeText(event.text);
  if (commandEnvelope) {
    events.push(timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'tool',
      order,
      snippet: snippet(commandEnvelope, 700),
      fullText: fullText(commandEnvelope),
      label: 'command envelope',
    }));
  }
  const text = commandEnvelope ? stripCommandEnvelopeText(event.text) : event.text;
  const displayedSourceText = event.displayText?.trim() || event.text;
  const displayText = commandEnvelope
    ? stripCommandEnvelopeText(displayedSourceText)
    : displayedSourceText;
  const semanticText = event.origin === 'human' ? displayText : text;
  if (!semanticText.trim()) return events;
  const kind = event.origin === 'human'
    ? 'user_message'
    : event.origin === 'skill-context'
      ? 'skill_context'
      : event.origin === 'synthetic'
        ? 'synthetic_user_event'
        : 'runtime_context';
  events.push(timelineEvent({
    ...base,
    kind,
    role: kind === 'user_message' ? 'user' : kind === 'synthetic_user_event' ? 'other' : 'tool',
    order: order + (commandEnvelope ? 1 : 0),
    snippet: snippet(semanticText, 700),
    fullText: fullText(semanticText),
    attachments: event.attachments,
    label: userTextEventLabel(kind),
  }));
  return events;
}

function safeRecordText(record: unknown): string {
  try {
    return JSON.stringify(record);
  } catch {
    return String(record ?? '');
  }
}

function hasAssistantTurnFailedText(value: string): boolean {
  return /\[assistant turn failed\]|assistant turn failed|assistant_turn_failed|turn failed/i.test(value);
}

function timelineEvent(input: Omit<ExperienceTimelineEvent, 'id'>): ExperienceTimelineEvent {
  return {
    ...input,
    id: hashParts(
      input.traceId ?? '',
      input.sourceTrace,
      input.sessionId,
      input.messageUuid ?? '',
      String(input.messageIndex ?? ''),
      input.kind,
      input.callInstanceId ?? '',
      input.toolUseId ?? '',
      input.snippet ?? '',
    ),
  };
}

function userTextEventLabel(kind: 'user_message' | 'synthetic_user_event' | 'skill_context' | 'runtime_context'): string {
  if (kind === 'skill_context') return 'skill context';
  if (kind === 'runtime_context') return 'runtime context';
  if (kind === 'synthetic_user_event') return 'synthetic user event';
  return 'user message';
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
    snippet: snippet(item.evidence.query || item.evidence.path || item.evidence.assistantSnippet || item.evidence.outputSnippet || item.evidence.markerToken, 700),
  };
}

function evidenceRefFromTimeline(event: ExperienceTimelineEvent): ExperienceEvidenceRef {
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

function primarySourceTraceForSession(session: ExperienceSessionSummary): string | undefined {
  return session.sourceTrace
    ?? session.evidenceChain.firstUserMessage?.sourceTrace
    ?? session.fullSessionTimeline.find((event) => event.traceRole === 'main')?.sourceTrace
    ?? session.fullSessionTimeline[0]?.sourceTrace
    ?? session.timelinePreview[0]?.sourceTrace;
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

function uniqueBy<T>(values: T[], keyOf: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
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

function assistantFinalDeliveryEvents(session: ExperienceSessionSummary): ExperienceTimelineEvent[] {
  return (session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview)
    .filter(isAssistantDeliveryEvent);
}

function assistantProgressUpdateEvents(session: ExperienceSessionSummary): ExperienceTimelineEvent[] {
  return (session.fullSessionTimeline.length > 0 ? session.fullSessionTimeline : session.timelinePreview)
    .filter(isAssistantProgressUpdateEvent);
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

interface CurrentSkillRuntimeModel {
  skillType: ExperienceRuntimeSkillType;
  isDelegator: boolean;
  hasDownstreamEdges: boolean;
  segments: ExperienceSkillSegment[];
  downstreamEdges: ExperienceOrchestrationEdge[];
  downstreamSignals: ExperienceFeedbackSignal[];
  primarySignals: ExperienceFeedbackSignal[];
  contextSignals: ExperienceFeedbackSignal[];
}

function currentSkillRuntimeModel(session: ExperienceSessionSummary, episodesOverride?: ExperienceEpisode[]): CurrentSkillRuntimeModel | undefined {
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

function userFacingClosureForSession(
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

function isMainlineEvidenceRef(ref: Pick<ExperienceEvidenceRef, 'sourceTrace'> | undefined, primarySourceTrace?: string): boolean {
  if (!ref || !primarySourceTrace || !ref.sourceTrace) return true;
  return ref.sourceTrace === primarySourceTrace;
}

function enrichRouterDownstreamIndicators(session: ExperienceSessionSummary): ExperienceReviewIndicators {
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

function sumTokenUsage(invocations: ExperienceInvocation[]): Omit<ExperienceReviewerReport['oneLookMetrics']['tokenUsage'], 'attribution'> {
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

function scoreForIndicators(indicators: ExperienceReviewIndicators): number {
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

function weightedCount(count: number, weight: number): number {
  const weighted = count * weight;
  if (!Number.isSafeInteger(weighted) || weighted < 0) {
    throw new RangeError('Weighted observation count exceeds Number.MAX_SAFE_INTEGER');
  }
  return weighted;
}

function priorityForScore(score: number): ExperienceReviewPriority {
  if (score >= 3) return 'review_first';
  if (score > 0) return 'sample_review';
  return 'routine_sample';
}

function priorityForReviewerFindings(
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

function basisCodesForIndicators(indicators: ExperienceReviewIndicators): ExperienceReviewBasisCode[] {
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

function sumRecordCounts(values: Array<Record<string, number>>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    for (const [key, count] of Object.entries(value)) {
      incrementRecordCount(counts, key, count);
    }
  }
  return counts;
}

function sumIndicators(values: ExperienceReviewIndicators[]): ExperienceReviewIndicators {
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

function uniqueTimelineEvents(events: ExperienceTimelineEvent[]): ExperienceTimelineEvent[] {
  const byId = new Map<string, ExperienceTimelineEvent>();
  for (const event of events) {
    byId.set(event.id, event);
  }
  return Array.from(byId.values());
}

function compareTimelineEvents(a: ExperienceTimelineEvent, b: ExperienceTimelineEvent): number {
  const ta = a.timestamp;
  const tb = b.timestamp;
  // 双方都有非空 timestamp 且不同 → 按时间穿插（主线 + subagent 真实交互序）
  if (ta && tb && ta !== tb) {
    return ta.localeCompare(tb);
  }
  // 同一条物理 trace 内 → 按 messageIndex 派生的 order（跨 trace 比 order 没意义）。
  const samePhysicalTrace = a.traceId && b.traceId
    ? a.traceId === b.traceId
    : a.sourceTrace === b.sourceTrace;
  if (samePhysicalTrace) {
    return a.order - b.order;
  }
  // 跨 trace 且 timestamp 不可比 → 主线优先（避免缺 timestamp 时 subagent 顶到最前）
  const roleRank = (event: ExperienceTimelineEvent): number =>
    event.traceRole === 'main' || event.traceRole === 'standalone' ? 0 : 1;
  const rankDiff = roleRank(a) - roleRank(b);
  if (rankDiff !== 0) return rankDiff;
  // 同 traceRole 且 timestamp 缺失时，用物理 trace 身份提供稳定顺序。
  return (a.traceId ?? a.sourceTrace).localeCompare(b.traceId ?? b.sourceTrace)
    || a.sourceTrace.localeCompare(b.sourceTrace)
    || a.order - b.order;
}

function traceRecordRanges(events: ExperienceTimelineEvent[]): ExperienceTraceRecordRange[] {
  const byTrace = new Map<string, ExperienceTimelineEvent[]>();
  for (const event of events) {
    if (typeof event.messageIndex !== 'number') continue;
    const traceId = event.traceId ?? event.sourceTrace;
    const group = byTrace.get(traceId) ?? [];
    group.push(event);
    byTrace.set(traceId, group);
  }
  return Array.from(byTrace.entries())
    .map(([traceId, group]): ExperienceTraceRecordRange => {
      const indexes = group.map((event) => event.messageIndex as number);
      return {
        traceId,
        sourceTrace: group[0].sourceTrace,
        startRecordIndex: Math.min(...indexes),
        endRecordIndex: Math.max(...indexes),
        eventCount: group.length,
      };
    })
    .sort((a, b) => a.traceId.localeCompare(b.traceId));
}

function buildSessionTimelineTree(sessionId: string, sessions: TraceSession[]): ExperienceTimelineTree {
  const mainSession = sessions.find((session) => session.role === 'main')
    ?? sessions.find((session) => session.role === 'standalone');
  const main = mainSession ? buildTimelineWindow(mainSession, 0, mainSession.events.length) : [];
  const branches = sessions
    .filter((session) => !mainSession || session !== mainSession)
    .map((session): ExperienceTimelineBranch => {
      const events = buildTimelineWindow(session, 0, session.events.length);
      const attachTo = inferSubagentAttachment(main, session);
      return {
        id: hashParts('timeline-branch', session.traceId),
        label: (session.label ?? basename(session.sourcePath)) || 'subagent',
        sessionId: session.runId,
        traceId: session.traceId,
        sourceTrace: session.sourcePath,
        traceRole: session.role,
        attachTo,
        events,
      };
    });
  return {
    sessionId,
    main,
    branches,
  };
}

function inferSubagentAttachment(
  mainEvents: ExperienceTimelineEvent[],
  branchSession: TraceSession,
): ExperienceTimelineBranch['attachTo'] | undefined {
  const startedAt = branchSession.startTimestamp;
  const taskUses = mainEvents.filter((event) => event.kind === 'tool_use' && /^(Task|Agent|Skill)$/i.test(event.toolName ?? ''));
  const candidates = startedAt
    ? taskUses.filter((event) => !event.timestamp || event.timestamp <= startedAt)
    : taskUses;
  const event = candidates.at(-1) ?? taskUses.at(-1);
  if (!event) return undefined;
  return {
    traceId: event.traceId,
    sourceTrace: event.sourceTrace,
    messageIndex: event.messageIndex,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    label: event.toolName,
  };
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.min(...filtered) : undefined;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

function minString(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value));
  return filtered.length > 0
    ? filtered.reduce(
        (min, value) => Date.parse(value) < Date.parse(min) ? value : min,
        filtered[0],
      )
    : undefined;
}

function maxString(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value));
  return filtered.length > 0
    ? filtered.reduce(
        (max, value) => Date.parse(value) > Date.parse(max) ? value : max,
        filtered[0],
      )
    : undefined;
}

function uniqueEvidenceRefs(refs: ExperienceEvidenceRef[]): ExperienceEvidenceRef[] {
  const byId = new Map<string, ExperienceEvidenceRef>();
  for (const ref of refs) {
    byId.set(ref.id, ref);
  }
  return Array.from(byId.values());
}

function inferUserGoal(userRefs: ExperienceTimelineEvent[]): string | undefined {
  const first = userRefs.find((ref) => ref.snippet && !ref.snippet.includes('tool_result'));
  return snippet(first?.snippet, 180);
}

function snippet(value: unknown, max = 240): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function fullText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const normalized = text.trim();
  return normalized || undefined;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function hashParts(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}
