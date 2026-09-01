import type {
  ExperienceChecklistItem,
  ExperienceEpisode,
  ExperienceEpisodeArtifact,
  ExperienceEpisodeBoundaryReason,
  ExperienceEpisodeRole,
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceFeedbackAttributionReason,
  ExperienceFeedbackSignal,
  ExperienceFeedbackSignalType,
  ExperienceGoalSliceReasonCode,
  ExperienceInvocation,
  ExperienceMessageRange,
  ExperienceOrchestrationEdge,
  ExperienceOutcomeClosure,
  ExperienceParentReason,
  ExperienceReviewIndicators,
  ExperienceReviewerReportStepStatus,
  ExperienceRuntimeSkillType,
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
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import type {
  ObservationReviewState,
} from '../contracts/review.js';
import {
  UNOBSERVED_TRACE_TIMESTAMP,
} from '../trace/segmentation.js';
import {
  hasAssistantDeliverableArtifactText,
  USER_INTERRUPTION_RE,
} from './text-signals.js';
import { isUserInteractionMetricText } from '../trace/message-classification.js';
import {
  compareTimelineEvents,
  hashParts,
  isObjectRecord,
  maxString,
  minString,
  snippet,
  unique,
  uniqueTimelineEvents,
} from './primitives.js';
import {
  assistantFinalDeliveryEvents,
  assistantProgressUpdateEvents,
  evidenceRefFromTimeline,
  invocationTimestampObserved,
  primarySourceTraceForSession,
  uniqueEvidenceRefs,
  userFacingClosureForSession,
} from './report-derivations.js';
import {
  canonicalFeedbackCountsForSession,
  checklistItemsForAnswer,
  foldExperienceChecklistItems,
  userFeedbackEvidenceRefs,
} from './review-checklist.js';
import {
  loadFrontmatterSkillType,
} from '../skill-health/experience-frontmatter.js';
import {
  hasNegativeFeedbackSignal,
  hasPositiveFeedbackSignal,
  hasUserCorrectionSignal,
  hasUserGoalShiftSignal,
} from '../inbox/feedback-matchers.js';

export interface ExperienceEpisodeRange {
  startMessageIndex: number;
  endMessageIndex: number;
  traceId?: string;
  sourceTrace?: string;
  sessionId?: string;
  boundaryReason?: ExperienceEpisodeBoundaryReason;
}

export function buildSessionStory(
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

export function skillSegmentsWithOrchestrationRoles(
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

export function sessionStoryEpisodeRanges(
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

export function primaryTraceIdForSession(
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

export function sessionStorySkillSegments(
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

export function traceInferredSkillTypeForLink(link: ExperienceSessionStorySkillLink): ExperienceRuntimeSkillType | undefined {
  if (link.role === 'router') return 'router';
  if (link.role === 'executor' || link.role === 'mixed') return 'executor';
  return undefined;
}

export function episodeRoleForLink(
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

export function sessionStoryOrchestrationEdges(
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

export function skillSegmentForTrace(
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

export function dispatchParentSkillSegment(
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

export function dispatchAttachmentEvidenceRef(
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

export function dispatchTerminalLifecycle(
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

export function bestPriorUpstreamSkillSegmentForRuntime(
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

export function mentionedUpstreamSkillSegmentForRuntime(
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

export function upstreamParentScore(segment: ExperienceSkillSegment, runnerOwner: ExperienceSkillSegment, contextText: string): number {
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

export function fallbackOrchestrationEdgeFromRuntime(
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

export function isOrchestrationRuntimeEvent(event: ExperienceTimelineEvent): boolean {
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

export function sessionStoryChildSessionId(event?: ExperienceTimelineEvent): string | undefined {
  const text = `${event?.snippet ?? ''} ${event?.fullText ?? ''}`;
  return text.match(
    /["']?(?:child_?session_?id|agent_?id|thread_?id|session_?id)["']?\s*[:=]\s*["']?([a-z0-9][a-z0-9._-]*)/i,
  )?.[1]
    ?? text.match(/\b(?:session|thread|agent)(?:\s+id)?\s*[:=]\s*([a-z0-9][a-z0-9._-]*)/i)?.[1]
    ?? text.match(/\b(?:claude|codex|agent|subagent)-[a-z0-9_-]+\b/i)?.[0];
}

export function sessionStoryFeedbackSignals(
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

export function feedbackSignalType(text: string, index: number): ExperienceFeedbackSignalType {
  if (USER_INTERRUPTION_RE.test(text)) return 'interruption';
  if (hasUserCorrectionSignal(text) || /不是|不对|错了|跑偏|漏了|组件.*pr|master/i.test(text)) return 'correction';
  if (hasNegativeFeedbackSignal(text) || /烦|失望|怎么.*还|为什么.*没|没返回|有结论吗/i.test(text)) return 'frustration';
  if (hasPositiveFeedbackSignal(text)) return 'positive';
  if (index > 0) return 'follow_up';
  return 'unknown';
}

export function feedbackTargetObject(text: string, skillSegments: ExperienceSkillSegment[]): string | undefined {
  const skillOwner = targetObjectSkillOwner(text, skillSegments);
  if (skillOwner) return skillOwner.skillName;
  if (/pr|pull request/i.test(text)) return 'PR';
  if (/有结论|进度|没返回|通知|返回/i.test(text)) return '异步结果';
  if (/停止|暂停|中断|别动/i.test(text)) return '执行流程';
  if (/产物|文档|报告|demo/i.test(text)) return '产物';
  return undefined;
}

export function feedbackAttributionsForText(
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

export function upstreamPromiseOwnerForFeedback(
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

export function upstreamPromiseOwnerScore(segment: ExperienceSkillSegment): number {
  let score = 0;
  if (segment.episodeRole === 'router' || segment.skillType === 'router') score += 80;
  if (segment.episodeRole === 'delegator' || segment.skillType === 'delegation') score += 70;
  return score;
}

export function downstreamRelatedParentsForPrimary(
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

export function isAsyncPromiseFeedbackText(text: string): boolean {
  return /有结论|进度|怎么样了|跑完|完成了吗|没返回|为什么.*(?:没|不).*?(?:通知|返回|同步)|通知|返回|同步|查看地址/i.test(text);
}

export function shouldPromiseOwnerReceivePrimaryFeedback(text: string): boolean {
  return /为什么.*(?:没|不).*?(?:通知|返回|同步)|没返回|没有.*(?:通知|返回|同步)|有结论吗|怎么.*还没/i.test(text);
}

export function isExplicitSkillTargetText(text: string, owner: ExperienceSkillSegment): boolean {
  const lower = text.toLowerCase();
  const name = owner.skillName.toLowerCase();
  const compact = compactObjectText(lower);
  const compactName = compactObjectText(name);
  return lower.includes(name) || (compactName.length >= 4 && compact.includes(compactName));
}

export interface ExperiencePromiseOwner {
  messageIndex: number;
  segment: ExperienceSkillSegment;
  evidenceRef: ExperienceEvidenceRef;
}

export function sessionStoryPromiseOwners(
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

export function promiseOwnerForFeedback(
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

export function targetObjectSkillOwner(text: string, skillSegments: ExperienceSkillSegment[]): ExperienceSkillSegment | undefined {
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

export function compactObjectText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
}

export function actionOwnerForFeedback(
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

export function feedbackActionCategory(text: string): 'delete' | 'pull' | 'preview' | 'review' | 'stop' | undefined {
  if (/删除|删掉|remove|delete|rm\s/.test(text)) return 'delete';
  if (/拉下|拉取|pull|fetch|checkout|分支/.test(text)) return 'pull';
  if (/预览|链接|端口|打开|url/.test(text)) return 'preview';
  if (/看下|review|检查|确认|否决|补充|更新|执行流程|skill/.test(text)) return 'review';
  if (/停止|暂停|中断|stop|cancel/.test(text)) return 'stop';
  return undefined;
}

export function actionCategoryMatchesRuntimeEvent(category: ReturnType<typeof feedbackActionCategory>, eventText: string): boolean {
  if (!category) return false;
  const lower = eventText.toLowerCase();
  if (category === 'delete') return /\brm\b|delete|remove|unlink|删除/.test(lower);
  if (category === 'pull') return /git\s+(?:pull|fetch|checkout|switch)|拉取|拉下|分支/.test(lower);
  if (category === 'preview') return /preview|localhost|127\.0\.0\.1|端口|server|vite|python3.*server|npm.*dev/.test(lower);
  if (category === 'review') return /skill|review|grep|rg|read|sed|cat|检查|确认|否决|补充|更新/.test(lower);
  if (category === 'stop') return /kill|stop|cancel|interrupt|停止|中断/.test(lower);
  return false;
}

export function shouldUseWindowFeedbackOwner(segment: ExperienceSkillSegment, text: string): boolean {
  if (segment.skillType !== 'delegation' && segment.episodeRole !== 'delegator') return true;
  return /子\s*(?:claude|codex|agent|代理|智能体)|subagent|sub-agent|child|runner|ttyd|session|thread|agent|有结论|进度|怎么样了|没返回|通知|同步|跑完|完成了吗/i.test(text);
}

export function dedupeFeedbackAttributions(attributions: ExperienceFeedbackAttribution[]): ExperienceFeedbackAttribution[] {
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

export function feedbackAttributionReasonForText(lowerText: string): ExperienceFeedbackAttributionReason {
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

export function skillSegmentForEvidenceRef(
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

export function messageRangeContainsEvidenceRef(
  range: ExperienceMessageRange,
  ref: Pick<ExperienceEvidenceRef, 'messageIndex' | 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (typeof ref.messageIndex !== 'number') return false;
  if (range.traceId && ref.traceId && range.traceId !== ref.traceId) return false;
  if (range.sourceTrace && ref.sourceTrace && range.sourceTrace !== ref.sourceTrace) return false;
  if (range.sessionId && ref.sessionId && range.sessionId !== ref.sessionId) return false;
  return ref.messageIndex >= range.startMessageIndex && ref.messageIndex <= range.endMessageIndex;
}

export function messageRangeTraceSpecificity(
  range: ExperienceMessageRange,
  ref: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
): number {
  return (range.traceId && ref.traceId && range.traceId === ref.traceId ? 4 : 0)
    + (range.sourceTrace && ref.sourceTrace && range.sourceTrace === ref.sourceTrace ? 2 : 0)
    + (range.sessionId && ref.sessionId && range.sessionId === ref.sessionId ? 1 : 0);
}

export function evidenceRefsShareTraceScope(
  a?: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
  b?: Pick<ExperienceEvidenceRef, 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  if (!a || !b) return true;
  if (a.traceId && b.traceId && a.traceId !== b.traceId) return false;
  if (a.sourceTrace && b.sourceTrace && a.sourceTrace !== b.sourceTrace) return false;
  if (a.sessionId && b.sessionId && a.sessionId !== b.sessionId) return false;
  return true;
}

export function timelineEventSharesTraceScope(
  event: Pick<ExperienceTimelineEvent, 'traceId' | 'sourceTrace' | 'sessionId'>,
  anchor?: Pick<ExperienceTimelineEvent, 'traceId' | 'sourceTrace' | 'sessionId'>,
): boolean {
  return evidenceRefsShareTraceScope(event, anchor);
}

export function skillSegmentsSharePhysicalTrace(a: ExperienceSkillSegment, b: ExperienceSkillSegment): boolean {
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

export function sessionStoryArtifacts(invocations: ExperienceInvocation[]): ExperienceEpisodeArtifact[] {
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

export function sessionStoryOutcomeClosure(session: ExperienceSessionSummary, artifacts: ExperienceEpisodeArtifact[]): ExperienceOutcomeClosure {
  if (session.indicators.userInterruptionCount > 0) return 'abandoned';
  if (session.indicators.assistantDeliverySignalCount > 0 || artifacts.length > 0) return 'closed';
  if (session.indicators.userFollowUpCount > 0 || session.indicators.negativeFeedbackCount > 0 || session.indicators.userCorrectionCount > 0) return 'unresolved';
  return 'unknown';
}

export function sessionStoryAcceptanceCriteria(
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

export function sessionStoryGoalSlices(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStoryGoalSlice[] {
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

export function sessionStorySubagentDispatches(session: ExperienceSessionSummary): ExperienceSessionStorySubagentDispatch[] {
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

export function sessionStorySkillLinks(session: ExperienceSessionSummary, invocations: ExperienceInvocation[]): ExperienceSessionStorySkillLink[] {
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

export function inferSkillRole(group: ExperienceInvocation[], allInvocations: ExperienceInvocation[], session: ExperienceSessionSummary): ExperienceSessionStorySkillRole {
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

export function routingEvidenceEvents(invocation: ExperienceInvocation): ExperienceTimelineEvent[] {
  return invocation.timeline
    .filter((event) =>
      isOrchestrationRuntimeEvent(event)
      || isDifferentSkillInvocationEvent(event, invocation.skillName)
    )
    .slice(0, 3);
}

export function isDifferentSkillInvocationEvent(
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

export function skillRoleLabel(role: ExperienceSessionStorySkillRole): string {
  if (role === 'router') return '路由';
  if (role === 'executor') return '执行';
  if (role === 'mixed') return '路由 + 执行';
  return '未确认';
}

export function sessionStoryGraph(
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

export function sessionStoryAnswer(
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

export function sessionStoryAnswerText(key: ExperienceSessionStoryAnswerKey, reason: ExperienceParentReason): string {
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

export function executionOutcomeText(indicators: ExperienceReviewIndicators): string {
  const details = [
    indicators.toolFailureCount > 0 ? `失败 ${indicators.toolFailureCount} 次` : '',
    (indicators.toolCancelledCount ?? 0) > 0 ? `取消 ${indicators.toolCancelledCount ?? 0} 次` : '',
    (indicators.toolUnknownCount ?? 0) > 0 ? `状态未知 ${indicators.toolUnknownCount ?? 0} 次` : '',
  ].filter(Boolean);
  return `执行中看到 ${indicators.toolCallCount} 次工具调用${details.length > 0 ? `，其中${details.join('，')}` : ''}。`;
}

export function deliveryStepText(session: ExperienceSessionSummary): string {
  const closure = userFacingClosureForSession(session);
  if (closure.deliveryCount > 0) {
    const artifact = closure.artifactCount > 0
      ? `，其中 ${closure.artifactCount} 次包含具体产物线索`
      : '，但未看到明确产物线索';
    return `看到 ${closure.deliveryCount} 次完成态或结果反馈${artifact}。`;
  }
  return '没有发现最后结果反馈；当前不能把过程进展当成完成。';
}

export function userFeedbackStepText(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): string {
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

export function userFeedbackStepStatus(session: ExperienceSessionSummary, reviewState?: ObservationReviewState): ExperienceReviewerReportStepStatus {
  const feedbackCounts = canonicalFeedbackCountsForSession(session, reviewState);
  if (feedbackCounts.userCorrectionCount > 0 || feedbackCounts.negativeFeedbackCount > 0 || feedbackCounts.userInterruptionCount > 0) return 'attention';
  if (feedbackCounts.positiveFeedbackCount > 0) return 'ok';
  return 'unknown';
}

export function minDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.min(...filtered) : undefined;
}

export function maxDefined(values: Array<number | undefined>): number | undefined {
  const filtered = values.filter((value): value is number => typeof value === 'number');
  return filtered.length > 0 ? Math.max(...filtered) : undefined;
}

export function inferUserGoal(userRefs: ExperienceTimelineEvent[]): string | undefined {
  const first = userRefs.find((ref) => ref.snippet && !ref.snippet.includes('tool_result'));
  return snippet(first?.snippet, 180);
}
