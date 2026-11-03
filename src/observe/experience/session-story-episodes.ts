/**
 * 会话故事的片段切分：按主线与分支证据把会话切成 episode，并判定片段边界与反馈归属。
 */
import type {
  ExperienceEpisode,
  ExperienceEpisodeArtifact,
  ExperienceEpisodeBoundaryReason,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceFeedbackSignal,
  ExperienceInvocation,
  ExperienceMessageRange,
  ExperienceOrchestrationEdge,
  ExperienceOutcomeClosure,
  ExperienceSessionStoryGoalSlice,
  ExperienceSessionStorySkillLink,
  ExperienceSessionStorySubagentDispatch,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import {
  hasUserGoalShiftSignal,
} from '../inbox/feedback-matchers.js';
import {
  compareTimelineEvents,
  hashParts,
  maxDefined,
  maxString,
  minDefined,
  minString,
  unique,
  uniqueTimelineEvents,
} from './primitives.js';
import {
  evidenceRefFromTimeline,
  primarySourceTraceForSession,
} from './report-derivations.js';
import {
  sessionStoryFeedbackSignals,
} from './session-story-feedback.js';
import {
  sessionStoryOrchestrationEdges,
} from './session-story-orchestration.js';
import {
  sessionStorySkillSegments,
} from './session-story-segments.js';
import {
  hasAssistantDeliverableArtifactText,
} from './text-signals.js';

export interface ExperienceEpisodeRange {
  startMessageIndex: number;
  endMessageIndex: number;
  traceId?: string;
  sourceTrace?: string;
  sessionId?: string;
  boundaryReason?: ExperienceEpisodeBoundaryReason;
}

export function sessionStoryEpisodes(
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

export function episodeFeedbackAttributionBelongsToEpisode(
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
    ?? 0;
  const sessionEnd = maxDefined(indexes)
    ?? persistedRange?.endRecordIndex
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

export function episodeRangeContainsRef(
  range: ExperienceEpisodeRange,
  ref?: Pick<ExperienceEvidenceRef, 'messageIndex' | 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (!ref || typeof ref.messageIndex !== 'number') return false;
  if (range.traceId && ref.traceId && range.traceId !== ref.traceId) return false;
  if (range.sourceTrace && ref.sourceTrace && range.sourceTrace !== ref.sourceTrace) return false;
  if (range.sessionId && ref.sessionId && range.sessionId !== ref.sessionId) return false;
  return ref.messageIndex >= range.startMessageIndex && ref.messageIndex <= range.endMessageIndex;
}

export function messageRangeOverlapsEpisodeRange(messageRange: ExperienceMessageRange, range: ExperienceEpisodeRange): boolean {
  if (range.traceId && messageRange.traceId && range.traceId !== messageRange.traceId) return false;
  if (range.sourceTrace && messageRange.sourceTrace && range.sourceTrace !== messageRange.sourceTrace) return false;
  if (range.sessionId && messageRange.sessionId && range.sessionId !== messageRange.sessionId) return false;
  return messageRange.endMessageIndex >= range.startMessageIndex
    && messageRange.startMessageIndex <= range.endMessageIndex;
}

export function sessionStoryEpisodeBoundaryReason(
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
