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
  storyContextsFromSessions,
  TIMELINE_PREVIEW_EVENT_LIMIT,
  timelineRefForSessionGroup,
  traceTimelinesFromSessions,
  flattenTimelineTree,
} from './report-structure.js';
import {
  isExperienceMeta,
  isTimestamp,
  normalizeExperienceInvocationShells,
  normalizeExperienceSessionShells,
  normalizeStoryContexts,
  normalizeTraceTimelines,
} from './report-value-guards.js';
import { validateExperienceReferences } from './report-reference-validator.js';

export const LEGACY_OBSERVATION_EXPERIENCE_SCHEMA_VERSION = 2;

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
