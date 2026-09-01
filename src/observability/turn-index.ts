import { createHash } from 'node:crypto';
import type {
  ExperienceTimelineEvent,
  ExperienceTurnStatus,
  ExperienceTurnSummary,
  TaskWindowBasis,
} from './contracts/experience.js';

interface TurnCandidate {
  basis: Exclude<TaskWindowBasis, 'unresolved'>;
  sourceTurnId?: string;
  start: number;
  end: number;
  events: ExperienceTimelineEvent[];
}

interface IndexedEvent {
  event: ExperienceTimelineEvent;
  position: number;
}

const TERMINAL_LIFECYCLE_LABELS = new Set([
  'turn_completed',
  'turn_failed',
  'turn_aborted',
  'turn_interrupted',
  'turn_ended_unknown',
]);

/** Reconstruct every observable task without consulting Skill attribution. */
export function reconstructExperienceTurns(
  timeline: ExperienceTimelineEvent[],
): ExperienceTurnSummary[] {
  const events = stableTimeline(timeline);
  const candidates = [
    ...turnIdCandidates(events),
    ...lifecycleCandidates(events),
    ...userMessageCandidates(events),
  ].sort((left, right) => left.start - right.start || left.end - right.end);

  return candidates.map(turnSummary);
}

function turnIdCandidates(events: ExperienceTimelineEvent[]): TurnCandidate[] {
  const groups = new Map<string, IndexedEvent[]>();
  events.forEach((event, position) => {
    if (!event.turnId) return;
    const key = `${traceKey(event)}\u0000${event.turnId}`;
    groups.set(key, [...(groups.get(key) ?? []), { event, position }]);
  });

  return Array.from(groups.values()).map((group) => {
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last || !first.event.turnId) return undefined;
    const start = expandTurnStart(events, first.position, traceKey(first.event));
    const end = expandTurnEnd(events, last.position, traceKey(last.event), first.event.turnId);
    return candidate('turn_id', events, start, end, traceKey(first.event), first.event.turnId);
  }).filter((item): item is TurnCandidate => Boolean(item));
}

function lifecycleCandidates(events: ExperienceTimelineEvent[]): TurnCandidate[] {
  const byTrace = indexedEventsByTrace(events);
  const candidates: TurnCandidate[] = [];
  for (const traceEvents of byTrace.values()) {
    if (traceEvents.some(({ event }) => event.turnId)) continue;
    for (let index = 0; index < traceEvents.length; index += 1) {
      const opening = traceEvents[index];
      if (!opening || opening.event.label !== 'turn_started') continue;
      const nextOpeningIndex = traceEvents.findIndex((item, candidateIndex) => (
        candidateIndex > index && item.event.label === 'turn_started'
      ));
      const searchEnd = nextOpeningIndex >= 0 ? nextOpeningIndex : traceEvents.length;
      const terminal = traceEvents.slice(index + 1, searchEnd).find((item) => (
        TERMINAL_LIFECYCLE_LABELS.has(item.event.label ?? '')
      ));
      const last = terminal ?? traceEvents[Math.max(index, searchEnd - 1)] ?? opening;
      const start = expandTurnStart(events, opening.position, traceKey(opening.event));
      candidates.push(candidate(
        'turn_lifecycle',
        events,
        start,
        last.position,
        traceKey(opening.event),
        opening.event.turnId,
      ));
    }
  }
  return candidates;
}

function userMessageCandidates(events: ExperienceTimelineEvent[]): TurnCandidate[] {
  const byTrace = indexedEventsByTrace(events);
  const candidates: TurnCandidate[] = [];
  for (const traceEvents of byTrace.values()) {
    if (traceEvents.some(({ event }) => hasNativeTurnBoundary(event))) continue;
    const users = traceEvents.filter((item) => isHumanUserMessage(item.event));
    users.forEach((user, userIndex) => {
      const nextUser = users[userIndex + 1];
      const terminal = traceEvents.find((item) => (
        item.position > user.position
        && (!nextUser || item.position < nextUser.position)
        && TERMINAL_LIFECYCLE_LABELS.has(item.event.label ?? '')
      ));
      const end = terminal?.position
        ?? (nextUser
          ? previousGlobalPosition(events, nextUser.position, traceKey(user.event))
          : traceEvents.at(-1)?.position ?? user.position);
      candidates.push(candidate(
        'user_message',
        events,
        expandUserTaskStart(events, user.position, traceKey(user.event)),
        end,
        traceKey(user.event),
      ));
    });
  }
  return candidates;
}

function candidate(
  basis: Exclude<TaskWindowBasis, 'unresolved'>,
  events: ExperienceTimelineEvent[],
  start: number,
  end: number,
  eventTraceKey: string,
  sourceTurnId?: string,
): TurnCandidate {
  const safeStart = Math.max(0, Math.min(start, events.length - 1));
  const safeEnd = Math.max(safeStart, Math.min(end, events.length - 1));
  return {
    basis,
    sourceTurnId,
    start: safeStart,
    end: safeEnd,
    events: events.slice(safeStart, safeEnd + 1)
      .filter((event) => traceKey(event) === eventTraceKey),
  };
}

function turnSummary(value: TurnCandidate): ExperienceTurnSummary {
  const events = value.events;
  const first = events[0];
  return {
    turnId: value.sourceTurnId ?? syntheticTurnId(value),
    sourceTurnId: value.sourceTurnId,
    boundaryBasis: value.basis,
    traceId: first?.traceId,
    sourceTrace: first?.sourceTrace ?? '',
    startTimestamp: events.find((event) => event.timestamp)?.timestamp,
    endTimestamp: [...events].reverse().find((event) => event.timestamp)?.timestamp,
    status: turnStatus(events),
    title: turnTitle(events),
    eventIds: events.map((event) => event.id),
    userMessageCount: events.filter(isHumanUserMessage).length,
    assistantMessageCount: events.filter((event) => event.kind === 'assistant_message').length,
    toolCallCount: events.filter((event) => event.kind === 'tool_use').length,
    toolFailureCount: events.filter((event) => (
      event.kind === 'tool_result'
      && (event.toolStatus === 'failure' || event.isError)
    )).length,
  };
}

function syntheticTurnId(value: TurnCandidate): string {
  const first = value.events[0];
  const last = value.events.at(-1);
  const digest = createHash('sha256')
    .update([
      value.basis,
      first ? traceKey(first) : '',
      first?.id ?? String(value.start),
      last?.id ?? String(value.end),
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 20);
  return `turn:${digest}`;
}

function turnStatus(events: ExperienceTimelineEvent[]): ExperienceTurnStatus {
  const labels = new Set(events.map((event) => event.label));
  if (labels.has('turn_completed')) return 'completed';
  if (labels.has('turn_failed')) return 'failed';
  if (labels.has('turn_aborted')) return 'aborted';
  if (labels.has('turn_interrupted')) return 'interrupted';
  if (labels.has('turn_started')) return 'open';
  return 'unknown';
}

function turnTitle(events: ExperienceTimelineEvent[]): string {
  const userText = events.find(isHumanUserMessage);
  const assistantText = events.find((event) => event.kind === 'assistant_message');
  const fallback = events.find((event) => event.kind !== 'runtime_context' && event.kind !== 'lifecycle');
  return eventDisplayText(userText)
    ?? eventDisplayText(assistantText)
    ?? eventDisplayText(fallback)
    ?? '未命名任务';
}

function eventDisplayText(event: ExperienceTimelineEvent | undefined): string | undefined {
  const value = event?.snippet?.trim()
    || event?.fullText?.trim()
    || event?.label?.trim();
  if (!value) return undefined;
  return value.replace(/\s+/g, ' ').slice(0, 160);
}

function expandTurnStart(
  events: ExperienceTimelineEvent[],
  firstPosition: number,
  eventTraceKey: string,
): number {
  let start = firstPosition;
  let foundUser = false;
  for (let position = firstPosition - 1; position >= 0; position -= 1) {
    const event = events[position];
    if (!event || traceKey(event) !== eventTraceKey) continue;
    if (TERMINAL_LIFECYCLE_LABELS.has(event.label ?? '') || event.label === 'turn_started') break;
    if (event.turnId && events[firstPosition]?.turnId && event.turnId !== events[firstPosition]?.turnId) break;
    if (isHumanUserMessage(event)) {
      if (foundUser) break;
      foundUser = true;
      start = position;
      continue;
    }
    if (foundUser && event.kind !== 'runtime_context' && event.kind !== 'skill_context') break;
    start = position;
  }
  return start;
}

function expandUserTaskStart(
  events: ExperienceTimelineEvent[],
  userPosition: number,
  eventTraceKey: string,
): number {
  let start = userPosition;
  for (let position = userPosition - 1; position >= 0; position -= 1) {
    const event = events[position];
    if (!event || traceKey(event) !== eventTraceKey) continue;
    if (
      TERMINAL_LIFECYCLE_LABELS.has(event.label ?? '')
      || event.label === 'turn_started'
      || isHumanUserMessage(event)
    ) break;
    if (event.kind !== 'runtime_context' && event.kind !== 'skill_context') break;
    start = position;
  }
  return start;
}

function expandTurnEnd(
  events: ExperienceTimelineEvent[],
  lastPosition: number,
  eventTraceKey: string,
  turnId: string,
): number {
  if (TERMINAL_LIFECYCLE_LABELS.has(events[lastPosition]?.label ?? '')) return lastPosition;
  let end = lastPosition;
  for (let position = lastPosition + 1; position < events.length; position += 1) {
    const event = events[position];
    if (!event || traceKey(event) !== eventTraceKey) continue;
    if (event.turnId && event.turnId !== turnId) break;
    if (event.label === 'turn_started' || isHumanUserMessage(event)) break;
    end = position;
    if (TERMINAL_LIFECYCLE_LABELS.has(event.label ?? '')) break;
  }
  return end;
}

function previousGlobalPosition(
  events: ExperienceTimelineEvent[],
  nextPosition: number,
  eventTraceKey: string,
): number {
  for (let position = nextPosition - 1; position >= 0; position -= 1) {
    const event = events[position];
    if (event && traceKey(event) === eventTraceKey) return position;
  }
  return Math.max(0, nextPosition - 1);
}

function indexedEventsByTrace(events: ExperienceTimelineEvent[]): Map<string, IndexedEvent[]> {
  const groups = new Map<string, IndexedEvent[]>();
  events.forEach((event, position) => {
    const key = traceKey(event);
    groups.set(key, [...(groups.get(key) ?? []), { event, position }]);
  });
  return groups;
}

function stableTimeline(events: ExperienceTimelineEvent[]): ExperienceTimelineEvent[] {
  return events.map((event, position) => ({ event, position }))
    .sort((left, right) => {
      const leftTimestamp = left.event.timestamp;
      const rightTimestamp = right.event.timestamp;
      if (leftTimestamp && rightTimestamp && leftTimestamp !== rightTimestamp) {
        return leftTimestamp.localeCompare(rightTimestamp);
      }
      if (traceKey(left.event) === traceKey(right.event)) {
        return left.event.order - right.event.order;
      }
      return left.position - right.position;
    })
    .map(({ event }) => event);
}

function traceKey(event: ExperienceTimelineEvent): string {
  return event.traceId ?? event.sourceTrace;
}

function isHumanUserMessage(event: ExperienceTimelineEvent): boolean {
  return event.kind === 'user_message' && event.role !== 'tool';
}

function hasNativeTurnBoundary(event: ExperienceTimelineEvent): boolean {
  return Boolean(event.turnId)
    || event.label === 'turn_started'
    || TERMINAL_LIFECYCLE_LABELS.has(event.label ?? '');
}
