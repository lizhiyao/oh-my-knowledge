/**
 * 会话故事的编排边与 dispatch 归属：还原「谁启动了谁」，包含分支 dispatch 的父辈、挂载点与终态判定。
 */
import type {
  ExperienceEvidenceRef,
  ExperienceInvocation,
  ExperienceOrchestrationEdge,
  ExperienceSessionStorySubagentDispatch,
  ExperienceSessionSummary,
  ExperienceSkillSegment,
  ExperienceTimelineEvent,
} from '../contracts/experience.js';
import {
  compactObjectText,
  compareTimelineEvents,
  hashParts,
  minString,
  uniqueTimelineEvents,
} from './primitives.js';
import {
  evidenceRefFromTimeline,
  uniqueEvidenceRefs,
} from './report-derivations.js';
import {
  isOrchestrationRuntimeEvent,
  skillSegmentForEvidenceRef,
  skillSegmentForTrace,
  skillSegmentsSharePhysicalTrace,
  timelineEventSharesTraceScope,
} from './session-story-evidence.js';

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

function sessionStoryChildSessionId(event?: ExperienceTimelineEvent): string | undefined {
  const text = `${event?.snippet ?? ''} ${event?.fullText ?? ''}`;
  return text.match(
    /["']?(?:child_?session_?id|agent_?id|thread_?id|session_?id)["']?\s*[:=]\s*["']?([a-z0-9][a-z0-9._-]*)/i,
  )?.[1]
    ?? text.match(/\b(?:session|thread|agent)(?:\s+id)?\s*[:=]\s*([a-z0-9][a-z0-9._-]*)/i)?.[1]
    ?? text.match(/\b(?:claude|codex|agent|subagent)-[a-z0-9_-]+\b/i)?.[0];
}
