/**
 * 会话故事的装配入口：把片段、编排边、反馈信号与目标切片组装成落盘的故事结构。
 */
import type {
  ExperienceChecklistItem,
  ExperienceEpisode,
  ExperienceEvidenceRef,
  ExperienceGoalSliceReasonCode,
  ExperienceInvocation,
  ExperienceParentReason,
  ExperienceReviewerReportStepStatus,
  ExperienceReviewIndicators,
  ExperienceSessionStory,
  ExperienceSessionStoryAnswer,
  ExperienceSessionStoryAnswerKey,
  ExperienceSessionStoryGoalSlice,
  ExperienceSessionStoryGraphEdge,
  ExperienceSessionStoryGraphNode,
  ExperienceSessionStoryNode,
  ExperienceSessionStoryNodeKind,
  ExperienceSessionStorySkillLink,
  ExperienceSessionStorySubagentDispatch,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import type {
  ObservationReviewState,
} from '../contracts/review.js';
import {
  hasUserGoalShiftSignal,
} from '../inbox/feedback-matchers.js';
import {
  UNOBSERVED_TRACE_TIMESTAMP,
} from '../trace/segmentation.js';
import {
  compareTimelineEvents,
  hashParts,
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
  sessionStoryEpisodes,
} from './session-story-episodes.js';
import {
  inferSkillRole,
  routingEvidenceEvents,
  skillRoleLabel,
} from './session-story-segments.js';

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

export function inferUserGoal(userRefs: ExperienceTimelineEvent[]): string | undefined {
  const first = userRefs.find((ref) => ref.snippet && !ref.snippet.includes('tool_result'));
  return snippet(first?.snippet, 180);
}
