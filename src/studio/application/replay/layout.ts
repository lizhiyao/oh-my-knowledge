import type {
  TaskReplayStep
} from '../../../observability/view-models/index.js';
import type { Lang } from '../../../shared/language.js';
import type { ReplayAxisTick, ReplayGap, ReplayLaneKind, ReplayMilestoneTone, ReplayProjection } from '../../view-models/replay.js';
import { inlineMarkdownText } from '../inline-markdown.js';
import { compactText, durationBetween, formatRelativeTimestamp, parseTimestamp } from './format.js';
import { eventPreview, replayEventModel, resolveToolResultState, resultCardDetail, resultCardStatusLabel, resultTitle, STEP_LABELS, toolInputPreview, toolOperationTitle } from './summary.js';

const REPLAY_CARD_WIDTH = 190;

const REPLAY_CARD_MEDIUM_WIDTH = 154;

const REPLAY_CARD_SMALL_WIDTH = 118;

const REPLAY_COMPACT_CARD_WIDTH = 14;

const OPERATION_LANE_GAP = 20;

const OPERATION_FLOW_ADVANCE = 28;

const COMPACT_FLOW_ADVANCE = 18;

export const TRACK_START_PADDING = 16;

const AXIS_TICK_PADDING = 7;

const AXIS_TICK_GLYPH_WIDTH = 5.5;

const AXIS_TICK_CLEARANCE = 8;

export function projectsToSemanticTrajectory(step: TaskReplayStep): boolean {
  return step.stepKind !== 'observation' && step.stepKind !== 'system_event';
}

export function projectsAsOperation(step: TaskReplayStep): boolean {
  return projectsToSemanticTrajectory(step) && step.stepKind !== 'lifecycle';
}

function displayWidthUnits(value: string): number {
  return [...value].reduce((total, character) => total + (/[^\x00-\xff]/.test(character) ? 2 : 1), 0);
}

export function adaptiveCardWidth(kindLabel: string, title: string, detail = ''): number {
  const headUnits = 8 + displayWidthUnits(kindLabel);
  const titleUnitsPerLine = Math.ceil(displayWidthUnits(title) / 2);
  const detailUnits = Math.min(32, displayWidthUnits(detail));
  const requiredUnits = Math.max(headUnits, titleUnitsPerLine, detailUnits);
  if (requiredUnits <= 18) return REPLAY_CARD_SMALL_WIDTH;
  if (requiredUnits <= 27) return REPLAY_CARD_MEDIUM_WIDTH;
  return REPLAY_CARD_WIDTH;
}

function replayCardWidth(step: TaskReplayStep, lang: Lang, pendingToolResults: boolean): number {
  const event = step.events[0];
  if (step.stepKind === 'model_activity' && event?.contentVisibility === 'opaque') return REPLAY_COMPACT_CARD_WIDTH;
  if (step.stepKind === 'runtime_context' || step.stepKind === 'skill_context') return REPLAY_CARD_WIDTH;
  if (step.stepKind === 'tool_exchange') {
    const call = step.events[0];
    const result = step.events[1];
    const input = toolInputPreview(call).replace(/\s+/g, ' ').trim();
    const resultState = resolveToolResultState(step, pendingToolResults);
    const actionTitle = toolOperationTitle(call?.toolName ?? step.title, input, lang);
    const actionWidth = adaptiveCardWidth(call?.toolName ?? step.title, actionTitle);
    const resultWidth = adaptiveCardWidth(
      resultCardStatusLabel(resultState, lang),
      resultTitle(step, [], lang, input, call?.toolName ?? step.title, resultState),
      resultCardDetail(step, result, durationBetween(call?.timestamp, result?.timestamp, lang), lang),
    );
    return Math.max(actionWidth, resultWidth, step.knowledgeEvidenceIds.length > 0 ? REPLAY_CARD_WIDTH : 0);
  }
  const kindLabel = step.stepKind === 'model_activity'
    ? STEP_LABELS.model_activity[lang]
    : STEP_LABELS[step.stepKind][lang];
  const eventModel = replayEventModel(step, event);
  return adaptiveCardWidth(
    [kindLabel, eventModel].filter(Boolean).join(' · '),
    compactText(inlineMarkdownText(eventPreview(event, step.title)), 72),
  );
}

function replayLayoutTracks(step: TaskReplayStep): ReplayLaneKind[] {
  if (step.stepKind === 'tool_exchange') {
    return step.knowledgeEvidenceIds.length > 0
      ? ['action', 'result', 'knowledge']
      : ['action', 'result'];
  }
  if (step.stepKind === 'runtime_context' || step.stepKind === 'skill_context') return ['knowledge'];
  if (['user_request', 'user_message', 'user_correction', 'assistant_message', 'model_activity'].includes(step.stepKind)) {
    return ['conversation'];
  }
  return ['result'];
}

function operationFlowAdvance(previousStep: TaskReplayStep | undefined, step: TaskReplayStep): number {
  const compact = (candidate: TaskReplayStep | undefined): boolean =>
    candidate?.stepKind === 'model_activity' && candidate.events[0]?.contentVisibility === 'opaque';
  return compact(previousStep) || compact(step) ? COMPACT_FLOW_ADVANCE : OPERATION_FLOW_ADVANCE;
}

export function milestonePosition(
  stepIndex: number,
  steps: TaskReplayStep[],
  positionsByStepId: Map<string, number>,
  tone: ReplayMilestoneTone,
  timestamp: string | undefined,
  taskStartTimestamp: string | undefined,
  lang: Lang,
  pendingToolResults: boolean,
): number {
  const milestoneMs = parseTimestamp(timestamp);
  const taskStartMs = parseTimestamp(taskStartTimestamp);
  if (
    tone === 'start'
    && milestoneMs !== undefined
    && taskStartMs !== undefined
    && milestoneMs <= taskStartMs
  ) return 4;

  const operationPositions = [...positionsByStepId.values()];
  const lastPosition = operationPositions.at(-1) ?? TRACK_START_PADDING;
  const lastStep = [...steps].reverse().find(projectsAsOperation);
  const previousStep = [...steps.slice(0, stepIndex)].reverse().find(projectsAsOperation);
  const nextStep = steps.slice(stepIndex + 1).find(projectsAsOperation);
  const previousPosition = previousStep ? positionsByStepId.get(previousStep.id) : undefined;
  const nextPosition = nextStep ? positionsByStepId.get(nextStep.id) : undefined;

  if (previousPosition === undefined) return 4;
  if (nextPosition === undefined) return lastPosition + (lastStep ? replayCardWidth(lastStep, lang, pendingToolResults) : REPLAY_CARD_WIDTH) + 5;
  return tone === 'start'
    ? Math.max(4, nextPosition - 5)
    : previousPosition + (previousStep ? replayCardWidth(previousStep, lang, pendingToolResults) : REPLAY_CARD_WIDTH) + 5;
}

export function buildOperationLayout(
  steps: TaskReplayStep[],
  startTimestamp: string | undefined,
  lang: Lang,
  pendingToolResults: boolean,
): { positionsByStepId: Map<string, number>; gaps: ReplayGap[]; axisTicks: ReplayAxisTick[]; detailWidth: number } {
  const gapWidth = 96;
  const gapPadding = 16;
  const laneLabelWidth = 108;
  const idleGapThresholdMs = 60_000;
  const positionsByStepId = new Map<string, number>();
  const positions: number[] = [];
  const gaps: ReplayGap[] = [];
  const rightEdgeByTrack = new Map<ReplayLaneKind, number>();
  const taskStartMs = parseTimestamp(startTimestamp);
  // Session-level context may predate the selected task; keep its card without expanding the task axis.
  const inTaskTimeDomain = (timestamp: string | undefined): number | undefined => {
    const value = parseTimestamp(timestamp);
    if (value === undefined || taskStartMs === undefined) return value;
    return Math.max(value, taskStartMs);
  };
  let previousPosition = TRACK_START_PADDING;
  let previousEndMs: number | undefined;

  steps.forEach((step, index) => {
    const startMs = inTaskTimeDomain(step.timestamp);
    let position = index === 0
      ? TRACK_START_PADDING
      : previousPosition + operationFlowAdvance(steps[index - 1], step);
    if (
      index > 0
      && startMs !== undefined
      && previousEndMs !== undefined
      && startMs - previousEndMs >= idleGapThresholdMs
    ) {
      const occupiedRight = Math.max(position, ...rightEdgeByTrack.values());
      const gapPosition = occupiedRight + gapPadding;
      gaps.push({ position: gapPosition, width: gapWidth, durationMs: startMs - previousEndMs });
      position = gapPosition + gapWidth + gapPadding;
    }

    const tracks = replayLayoutTracks(step);
    for (const track of tracks) {
      const rightEdge = rightEdgeByTrack.get(track);
      if (rightEdge !== undefined) position = Math.max(position, rightEdge + OPERATION_LANE_GAP);
    }

    positions.push(position);
    positionsByStepId.set(step.id, position);
    const rightEdge = position + replayCardWidth(step, lang, pendingToolResults);
    tracks.forEach((track) => rightEdgeByTrack.set(track, rightEdge));
    previousPosition = position;
    const eventTimes = step.events
      .map((event) => inTaskTimeDomain(event.timestamp))
      .filter((value): value is number => value !== undefined);
    previousEndMs = eventTimes.length > 0 ? Math.max(...eventTimes) : startMs ?? previousEndMs;
  });

  const tickStride = Math.max(1, Math.ceil(steps.length / 9));
  const axisTickCandidates = steps.flatMap((step, index): ReplayAxisTick[] => (
    index === 0 || index === steps.length - 1 || index % tickStride === 0
      ? [{ position: positions[index] ?? TRACK_START_PADDING, label: formatRelativeTimestamp(step.timestamp, startTimestamp) }]
      : []
  ));
  const axisTicks = axisTickCandidates.filter((tick, index) => index === 0 || tick.label !== axisTickCandidates[index - 1]?.label);
  const lastPosition = positions.at(-1) ?? TRACK_START_PADDING;
  const lastWidth = steps.length > 0 ? replayCardWidth(steps[steps.length - 1], lang, pendingToolResults) : REPLAY_CARD_WIDTH;
  const occupiedRight = Math.max(lastPosition + lastWidth, ...rightEdgeByTrack.values());
  const detailWidth = Math.max(960, laneLabelWidth + occupiedRight + 24);
  return { positionsByStepId, gaps, axisTicks, detailWidth };
}

export function visibleAxisTicks(projection: ReplayProjection): ReplayAxisTick[] {
  const candidates = projection.axisTicks
    .filter((tick) => !projection.milestones.some((milestone) => Math.abs(milestone.position - tick.position) < 110))
    .sort((left, right) => left.position - right.position);
  const selectedFromRight: ReplayAxisTick[] = [];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const tick = candidates[index];
    const rightNeighbor = selectedFromRight.at(-1);
    const occupiedWidth = AXIS_TICK_PADDING + tick.label.length * AXIS_TICK_GLYPH_WIDTH + AXIS_TICK_CLEARANCE;
    if (!rightNeighbor || rightNeighbor.position - tick.position >= occupiedWidth) {
      selectedFromRight.push(tick);
    }
  }
  return selectedFromRight.reverse();
}
