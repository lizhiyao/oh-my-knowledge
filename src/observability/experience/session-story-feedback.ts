/**
 * 会话故事的反馈归因：把用户反馈信号归到技能段、承诺所有者或动作所有者，并给出归因理由。
 */
import type {
  ExperienceEvidenceRef,
  ExperienceFeedbackAttribution,
  ExperienceFeedbackAttributionReason,
  ExperienceFeedbackSignal,
  ExperienceFeedbackSignalType,
  ExperienceInvocation,
  ExperienceOrchestrationEdge,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import {
  hasNegativeFeedbackSignal,
  hasPositiveFeedbackSignal,
  hasUserCorrectionSignal,
} from '../inbox/feedback-matchers.js';
import {
  isUserInteractionMetricText,
} from '../trace/message-classification.js';
import {
  compactObjectText,
  compareTimelineEvents,
  hashParts,
  uniqueTimelineEvents,
} from './primitives.js';
import {
  evidenceRefFromTimeline,
} from './report-derivations.js';
import {
  evidenceRefsShareTraceScope,
  skillSegmentForEvidenceRef,
} from './session-story-evidence.js';
import {
  USER_INTERRUPTION_RE,
} from './text-signals.js';

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
