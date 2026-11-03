import type { z } from 'zod';
import { ObservationExperienceReportSchema } from '../contracts/experience-evidence-schema.js';
import type {
  PersistedExperienceInvocationSchema,
  ExperienceSessionStoryWireSchema,
  PersistedExperienceReviewerReportSchema,
  PersistedExperienceSessionSchema,
  PersistedObservationExperienceReportSchema,
} from '../contracts/experience-evidence-schema.js';
import type {
  ExperienceInvocation,
  ExperienceReviewerReport,
  ExperienceSessionStory,
  ExperienceSessionSummary,
  ExperienceTimelineEvent,
  ObservationExperienceReport,
} from '../contracts/experience.js';
import {
  reconstructExperienceTurns,
} from '../conversation/turn-index.js';
import {
  unique,
} from './primitives.js';
import {
  OBSERVATION_EXPERIENCE_SCHEMA_VERSION,
  storyContextRefForSessionGroup,
  TIMELINE_PREVIEW_EVENT_LIMIT,
  timelineRefForSessionGroup,
  flattenTimelineTree,
} from './report-structure.js';
import {
  isTimestamp,
  normalizeExperienceInvocationShells,
  normalizeExperienceSessionShells,
  normalizeStoryContexts,
  normalizeTraceTimelines,
} from './report-value-guards.js';
import { validateExperienceReferences } from './report-reference-validator.js';

export type PersistedExperienceInvocation = z.infer<typeof PersistedExperienceInvocationSchema>;

export type PersistedExperienceSessionStory = z.infer<typeof ExperienceSessionStoryWireSchema>;

export type PersistedExperienceReviewerReport = z.infer<typeof PersistedExperienceReviewerReportSchema>;

export type PersistedExperienceSession = z.infer<typeof PersistedExperienceSessionSchema>;

export type PersistedObservationExperienceReport = z.infer<typeof PersistedObservationExperienceReportSchema>;

export function normalizeObservationExperienceReport(value: unknown): ObservationExperienceReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Record<string, unknown>;
  if (!ReportHeaderSchema.safeParse(report).success
    || !isTimestamp(report.generatedAt)
    || !reportArrayKeys.every((key) => Array.isArray(report[key]))) return null;
  const invocations = normalizeExperienceInvocationShells(report.invocations as unknown[]);
  const sessions = normalizeExperienceSessionShells(report.sessions as unknown[]);
  if (!invocations || !sessions) return null;
  const traceTimelines = normalizeTraceTimelines(report.traceTimelines as unknown[]);
  const storyContexts = normalizeStoryContexts(report.storyContexts as unknown[]);
  if (!traceTimelines || !storyContexts) return null;
  const normalized: ObservationExperienceReport = {
    kind: ObservationExperienceReportSchema.shape.kind.value,
    schemaVersion: OBSERVATION_EXPERIENCE_SCHEMA_VERSION,
    scope: ObservationExperienceReportSchema.shape.scope.value,
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
    if (!validateExperienceReferences(hydrated)) return null;
  } catch {
    return null;
  }
  return hydrated;
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

export function hydrateExperienceTimelines(
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

export function compactSessionStory(
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

export function omitSessionStory(
  report: ExperienceReviewerReport,
): Omit<ExperienceReviewerReport, 'sessionStory' | 'sessionStoryRef'> {
  return omitProperties(report, ['sessionStory', 'sessionStoryRef']);
}

export function omitProperties<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

const ReportHeaderSchema = ObservationExperienceReportSchema.pick({
  kind: true,
  schemaVersion: true,
  scope: true,
  generatedAt: true,
  meta: true,
});
const reportArrayKeys = ObservationExperienceReportSchema.keyof().options
  .filter((key) => !Object.hasOwn(ReportHeaderSchema.shape, key));
