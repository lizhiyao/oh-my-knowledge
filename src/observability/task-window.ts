import type {
  ExperienceTimelineEvent,
  TaskTrajectorySession,
  TaskWindowScope,
} from '../types/index.js';

export const TASK_SEMANTIC_EVENT_LIMIT = 240;

export interface ResolvedTaskWindow {
  events: ExperienceTimelineEvent[];
  semanticEvents: ExperienceTimelineEvent[];
  scope: TaskWindowScope;
}

export function resolveTaskWindow(
  session: TaskTrajectorySession,
  targetTurnId: string,
  semanticLimit = TASK_SEMANTIC_EVENT_LIMIT,
): ResolvedTaskWindow {
  const events = session.fullSessionTimeline;
  const attributedIds = new Set(session.attributedEventIds);
  const attributed = events.filter((event) => attributedIds.has(event.id));
  const selected = session.turns.find((turn) => turn.turnId === targetTurnId);
  const eventById = new Map(events.map((event) => [event.id, event]));
  const taskEvents = selected
    ? selected.eventIds.flatMap((id) => {
        const event = eventById.get(id);
        return event ? [event] : [];
      })
    : [];
  const semanticEvents = semanticPreview(taskEvents, semanticLimit);
  const matchedAttributedEventCount = taskEvents.filter((event) => attributedIds.has(event.id)).length;

  return {
    events: taskEvents,
    semanticEvents,
    scope: {
      basis: selected?.boundaryBasis ?? 'unresolved',
      turnId: selected?.turnId,
      normalizedEventCount: taskEvents.length,
      semanticEventCount: semanticEvents.length,
      attributedEventCount: attributed.length,
      matchedAttributedEventCount,
      truncated: semanticEvents.length < taskEvents.length,
    },
  };
}

function semanticPreview(
  events: ExperienceTimelineEvent[],
  limit: number,
): ExperienceTimelineEvent[] {
  if (events.length <= limit) return events;
  const headCount = Math.ceil(limit * 0.6);
  const tailCount = limit - headCount;
  return [...events.slice(0, headCount), ...events.slice(-tailCount)];
}
