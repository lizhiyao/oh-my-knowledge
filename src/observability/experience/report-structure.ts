import type {
  ExperienceInvocation,
  ExperienceSessionSummary,
  ExperienceStoryContext,
  ExperienceTimelineEvent,
  ExperienceTimelineTree,
  ExperienceTraceRecordRange,
  ExperienceTraceTimeline,
} from '../contracts/experience.js';
import {
  compareTimelineEvents,
  hashParts,
  uniqueTimelineEvents,
} from './primitives.js';

export const OBSERVATION_EXPERIENCE_SCHEMA_VERSION = 3;

export const TIMELINE_PREVIEW_EVENT_LIMIT = 240;

export function traceTimelinesFromSessions(
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

export function storyContextsFromSessions(
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

export function timelineRefForSessionGroup(sessionGroupKey: string): string {
  return hashParts('trace-timeline', sessionGroupKey);
}

export function storyContextRefForSessionGroup(sessionGroupKey: string): string {
  return hashParts('story-context', sessionGroupKey);
}

export function flattenTimelineTree(tree: ExperienceTimelineTree): ExperienceTimelineEvent[] {
  return uniqueTimelineEvents([
    ...tree.main,
    ...tree.branches.flatMap((branch) => branch.events),
  ]).sort(compareTimelineEvents);
}

export function traceRecordRanges(events: ExperienceTimelineEvent[]): ExperienceTraceRecordRange[] {
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
