import type { ExperienceTimelineEvent } from '../types/index.js';

interface SemanticUnit {
  id: string;
  events: ExperienceTimelineEvent[];
  order: number;
  priority: number;
  required: boolean;
  retentionOrder: number;
}

export interface TaskSemanticProjectionOptions {
  preservePendingToolCalls?: boolean;
}

const PRIORITY_BANDS = [100, 90, 80, 70, 60, 40, 20, 0] as const;

/**
 * Bound one task's semantic projection without separating tool exchanges or
 * blindly discarding the middle of a long task. Failures, task boundaries and
 * the user/assistant endpoints are retained first; remaining capacity is
 * distributed across the task so the preview still explains its progression.
 */
export function projectTaskSemanticEvents(
  events: ExperienceTimelineEvent[],
  limit: number,
  options: TaskSemanticProjectionOptions = {},
): ExperienceTimelineEvent[] {
  if (limit <= 0 || events.length === 0) return [];
  if (events.length <= limit) return events;

  const units = semanticUnits(events, options);
  const selected = new Map<string, SemanticUnit>();
  let remaining = limit;

  const required = units
    .filter((unit) => unit.required)
    .sort((left, right) => right.priority - left.priority || left.retentionOrder - right.retentionOrder);
  for (const unit of required) {
    if (unit.events.length > remaining) continue;
    selected.set(unit.id, unit);
    remaining -= unit.events.length;
  }

  for (const priority of PRIORITY_BANDS) {
    if (remaining <= 0) break;
    const candidates = units.filter((unit) => (
      !selected.has(unit.id) && unit.priority === priority
    ));
    if (candidates.length === 0) continue;
    const totalSize = candidates.reduce((sum, unit) => sum + unit.events.length, 0);
    if (totalSize <= remaining) {
      for (const unit of candidates) selected.set(unit.id, unit);
      remaining -= totalSize;
      continue;
    }

    remaining = selectSpreadCandidates(candidates, selected, units, remaining);
  }

  return [...selected.values()]
    .flatMap((unit) => unit.events)
    .sort((left, right) => left.order - right.order);
}

function semanticUnits(
  events: ExperienceTimelineEvent[],
  options: TaskSemanticProjectionOptions,
): SemanticUnit[] {
  const resultByCall = new Map<string, ExperienceTimelineEvent[]>();
  for (const event of events) {
    if (event.kind !== 'tool_result') continue;
    const key = toolCorrelationKey(event);
    resultByCall.set(key, [...(resultByCall.get(key) ?? []), event]);
  }

  const firstUserId = events.find((event) => event.kind === 'user_message')?.id;
  const finalAssistantId = [...events].reverse()
    .find((event) => event.kind === 'assistant_message')?.id;
  const consumedResults = new Set<string>();
  const units: SemanticUnit[] = [];

  for (const event of events) {
    if (event.kind === 'tool_result' && consumedResults.has(event.id)) continue;
    if (event.kind === 'tool_use') {
      const result = resultByCall.get(toolCorrelationKey(event))
        ?.find((candidate) => !consumedResults.has(candidate.id));
      if (result) consumedResults.add(result.id);
      const exchange = result ? [event, result] : [event];
      const failed = exchange.some((candidate) => candidate.isError || candidate.toolStatus === 'failure');
      const pending = !result && options.preservePendingToolCalls === true;
      units.push({
        id: `tool:${event.id}`,
        events: exchange,
        order: event.order,
        priority: failed ? 135 : pending ? 140 : 70,
        required: failed || pending,
        retentionOrder: pending ? -event.order : event.order,
      });
      continue;
    }

    const isFirstUser = event.id === firstUserId;
    const isFinalAssistant = event.id === finalAssistantId;
    const isBoundary = event.kind === 'lifecycle' && isBoundaryLifecycle(event);
    const isFailedResult = event.kind === 'tool_result'
      && (event.isError || event.toolStatus === 'failure');
    const required = isFirstUser
      || event.id === finalAssistantId
      || isFailedResult
      || isBoundary;
    units.push({
      id: `event:${event.id}`,
      events: [event],
      order: event.order,
      priority: requiredPriority(event, {
        isFirstUser,
        isFinalAssistant,
        isBoundary,
        isFailedResult,
      }),
      required,
      retentionOrder: event.order,
    });
  }
  return units;
}

function requiredPriority(
  event: ExperienceTimelineEvent,
  flags: {
    isFirstUser: boolean;
    isFinalAssistant: boolean;
    isBoundary: boolean;
    isFailedResult: boolean;
  },
): number {
  if (flags.isFirstUser) return 160;
  if (flags.isFinalAssistant) return 150;
  if (flags.isBoundary && event.label === 'turn_started') return 145;
  if (flags.isFailedResult) return 135;
  if (flags.isBoundary) return 130;
  return semanticPriority(event);
}

function semanticPriority(event: ExperienceTimelineEvent): number {
  if (event.kind === 'user_message' || event.kind === 'assistant_message') return 90;
  if (event.kind === 'skill_context') return 80;
  if (event.kind === 'runtime_context') return event.runtimeKind === 'usage' ? 0 : 80;
  if (event.kind === 'lifecycle') return 70;
  if (event.kind === 'tool_result') return event.isError || event.toolStatus === 'failure' ? 100 : 70;
  if (event.kind === 'observation' || event.kind === 'agent_activity') return 60;
  if (event.kind === 'model_activity') return event.contentVisibility === 'plaintext' ? 40 : 20;
  return 0;
}

function isBoundaryLifecycle(event: ExperienceTimelineEvent): boolean {
  const label = `${event.label ?? ''} ${event.sourceType ?? ''}`.toLowerCase();
  return /(?:turn|task)[_-]?(?:start|complete|abort|interrupt|end)/.test(label);
}

function selectSpreadCandidates(
  candidates: SemanticUnit[],
  selected: Map<string, SemanticUnit>,
  allUnits: SemanticUnit[],
  capacity: number,
): number {
  const selectedOrders = [...selected.values()].map((unit) => unit.order);
  const firstOrder = allUnits[0]?.order ?? 0;
  const lastOrder = allUnits.at(-1)?.order ?? firstOrder;
  const distances = new Map(candidates.map((candidate) => [
    candidate.id,
    selectedOrders.length > 0
      ? Math.min(...selectedOrders.map((order) => Math.abs(candidate.order - order)))
      : Math.min(Math.abs(candidate.order - firstOrder), Math.abs(lastOrder - candidate.order)),
  ]));
  let remaining = capacity;

  while (remaining > 0) {
    const fitting = candidates.filter((unit) => (
      !selected.has(unit.id) && unit.events.length <= remaining
    ));
    if (fitting.length === 0) break;
    const next = fitting.reduce((best, candidate) => {
      const candidateDistance = distances.get(candidate.id) ?? 0;
      const bestDistance = distances.get(best.id) ?? 0;
      return candidateDistance > bestDistance
        || (candidateDistance === bestDistance && candidate.order < best.order)
        ? candidate
        : best;
    });
    selected.set(next.id, next);
    remaining -= next.events.length;
    for (const candidate of candidates) {
      if (selected.has(candidate.id)) continue;
      distances.set(candidate.id, Math.min(
        distances.get(candidate.id) ?? Number.POSITIVE_INFINITY,
        Math.abs(candidate.order - next.order),
      ));
    }
  }
  return remaining;
}

function toolCorrelationKey(event: ExperienceTimelineEvent): string {
  return event.callInstanceId ?? event.toolUseId ?? event.id;
}
