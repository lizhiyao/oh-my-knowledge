import {
  isTraceSourceKind,
} from '../../executors/core/trace-source-kind.js';
import type {
  ExperienceGoalSlice,
  ExperienceInvocation,
  ExperienceReviewIndicators,
  ExperienceReviewerReport,
  ExperienceSessionStory,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceStoryContext,
  ExperienceTimelineEvent,
  ExperienceTraceRecordRange,
  ExperienceTraceTimeline,
  ObservationExperienceReport,
} from '../contracts/experience.js';
import {
  isObjectRecord,
  maxString,
  minString,
} from './primitives.js';
import {
  isAssistantDeliveryEvent,
} from './timeline.js';
import {
  traceRecordRanges,
  flattenTimelineTree,
} from './report-structure.js';
import {
  assistantFinalDeliveryEvents,
  assistantProgressUpdateEvents,
  basisCodesForIndicators,
  enrichRouterDownstreamIndicators,
  invocationTimestampObserved,
  isAssistantProgressUpdateEvent,
  priorityForReviewerFindings,
  priorityForScore,
  scoreForIndicators,
  sumIndicators,
  sumRecordCounts,
  sumTokenUsage,
} from './report-derivations.js';
import {
  sumRecordCounts as sumSafeCounts,
} from '../../shared/record-count.js';
import {
  EXPERIENCE_INDICATOR_KEYS,
  isCountRecord,
  isEnumValue,
  isExperienceAssistiveInference,
  isExperienceEvidenceChain,
  isExperienceEvidenceRefArray,
  isExperienceIndicators,
  isExperienceProblemPatternArray,
  isExperienceRuleFindingArray,
  isNonNegativeInteger,
  isOptionalString,
  isOptionalTimestampCoverage,
  isRate,
  isStringArray,
  isTimestampRange,
} from './report-value-guards.js';

export function isExperienceGoalSlice(value: unknown): value is ExperienceGoalSlice {
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

export function isExperienceSkillSummary(value: unknown): boolean {
  if (
    !isObjectRecord(value)
    || typeof value.skillName !== 'string'
    || !isNonNegativeInteger(value.invocationCount)
    || !isNonNegativeInteger(value.sessionCount)
    || !Array.isArray(value.sourceKinds)
    || !value.sourceKinds.every(isTraceSourceKind)
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
      !isNonNegativeInteger(value.timestampedInvocationCount)
      || !isRate(value.timestampCoverage)
    )
    || !isNonNegativeInteger(value.reviewFirstSessionCount)
    || !isNonNegativeInteger(value.sampleReviewSessionCount)
    || !isExperienceIndicators(value.indicators)
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

export function validateExperienceReferences(
  report: ObservationExperienceReport,
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
      || !traceTimelineStructureIsConsistent(timeline)
    ) return false;
    const rawEvents = [
      ...timeline.tree.main,
      ...timeline.tree.branches.flatMap((branch) => branch.events),
    ];
    if (
      (
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
        typeof goalSlice.traceId !== 'string'
        || typeof goalSlice.timestampObserved !== 'boolean'
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
      (
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
          goalSlice.traceId !== invocation.traceId
          || goalSlice.timestampObserved !== invocation.timestampObserved
        )
      )
    ) return false;
    referencedGoalSliceIds.add(invocation.goalSliceId);
    if (!invocation.timelineRef || !invocation.timelineEventIds) return false;
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
    {
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
    if (!session.timelineRef || !session.timelinePreviewEventIds) return false;
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
        (
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
      session.reviewerReport
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
    || referencedTimelineIds.size !== timelineEventsByRef.size
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
      !isExperienceSkillSummary(skill)
      || skillNames.has(skill.skillName)
    ) return false;
    {
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
    || referencedStoryContextIds.size !== storyContextIds.size
  ) return false;
  return report.sessions.every((session) => {
    const contextRef = session.sessionStory?.contextRef;
    if (session.sessionStory && !contextRef) return false;
    if (contextRef && !storyContextIds.has(contextRef)) return false;
    if (contextRef) {
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
      session.reviewerReport
      && session.reviewerReport.sessionStoryRef !== 'session'
      && !isObjectRecord((session.reviewerReport as unknown as Record<string, unknown>).sessionStory)
    ) return false;
    return session.reviewerReport?.sessionStoryRef !== 'session' || Boolean(session.sessionStory);
  });
}

export function sessionStoryStructureIsConsistent(
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

export function timelineScopeMatches(
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

export function traceRecordRangesEqual(
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

export function storyContextEpisodesAreConsistent(
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

export function traceTimelineStructureIsConsistent(timeline: ExperienceTraceTimeline): boolean {
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

export type ToolOutcomeSummary = Pick<
  ExperienceReviewIndicators,
  'toolCallCount' | 'toolFailureCount' | 'toolCancelledCount' | 'toolUnknownCount'
>;

export type InvocationToolOutcomeSummary = Pick<
  ExperienceInvocation['metrics'],
  'numToolCalls' | 'numToolFailures' | 'numToolCancelled' | 'numToolUnknown'
>;

export function toolOutcomeCountsMatch(
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

export function indicatorRecordsEqual(
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

export function reviewerMetricsMatch(
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

export function countRecordTotal(value: Record<string, number>): number {
  return sumSafeCounts(...Object.values(value));
}

export function countRecordsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => (left[key] ?? 0) === (right[key] ?? 0));
}

export function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameStringSet(left: string[], right: Set<string>): boolean {
  return left.length === right.size
    && new Set(left).size === left.length
    && left.every((value) => right.has(value));
}
