import type { ExperienceTimelineEvent } from '../contracts/experience.js';
import type { TaskTrajectorySession, TaskWindowScope } from '../view-models/knowledge-debugger.js';
import { hasExplicitFollowUpCorrectionSignal } from '../inbox/feedback-matchers.js';
import { projectTaskSemanticEvents } from './task-semantic-projection.js';

export const TASK_SEMANTIC_EVENT_LIMIT = 240;

export interface ResolvedTaskWindow {
  events: ExperienceTimelineEvent[];
  semanticEvents: ExperienceTimelineEvent[];
  relatedEvents: ExperienceTimelineEvent[];
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
  const semanticEvents = projectTaskSemanticEvents(taskEvents, semanticLimit, {
    preservePendingToolCalls: selected?.status === 'open',
  });
  const relatedEvents = selected
    ? relatedCorrectionEvents(session, selected.turnId, eventById)
    : [];
  const matchedAttributedEventCount = taskEvents.filter((event) => attributedIds.has(event.id)).length;

  return {
    events: taskEvents,
    semanticEvents,
    relatedEvents,
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

function relatedCorrectionEvents(
  session: TaskTrajectorySession,
  selectedTurnId: string,
  eventById: Map<string, ExperienceTimelineEvent>,
): ExperienceTimelineEvent[] {
  const selectedIndex = session.turns.findIndex((turn) => turn.turnId === selectedTurnId);
  const selectedTurn = selectedIndex >= 0 ? session.turns[selectedIndex] : undefined;
  if (!selectedTurn) return [];
  const selectedTraceKey = turnTraceKey(selectedTurn);
  const nextTurn = session.turns.slice(selectedIndex + 1).find((turn) => (
    turnTraceKey(turn) === selectedTraceKey
  ));
  if (!nextTurn) return [];
  const firstHumanMessage = nextTurn.eventIds
    .map((id) => eventById.get(id))
    .find((event) => event?.kind === 'user_message' && event.role === 'user');
  if (!firstHumanMessage) return [];
  const text = firstHumanMessage.fullText ?? firstHumanMessage.snippet ?? '';
  return hasExplicitFollowUpCorrectionSignal(text) ? [firstHumanMessage] : [];
}

function turnTraceKey(turn: TaskTrajectorySession['turns'][number]): string {
  return turn.traceId?.trim() || turn.sourceTrace;
}
