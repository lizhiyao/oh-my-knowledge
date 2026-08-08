import { createHash } from 'node:crypto';
import type {
  DebugKnowledgeEvidence,
  ExperienceEvidenceRef,
  ExperienceTimelineEvent,
  KnowledgeDebuggerViewModel,
  ObservationSourceRecordArchiveView,
  TaskTrajectorySession,
  TaskReplayIntegrityNotice,
  TaskReplayStep,
  TaskReplayStepKind,
  TraceIngestionSummary,
} from '../types/index.js';
import { hasUserCorrectionSignal } from './feedback-matchers.js';
import { resolveTaskWindow } from './task-window.js';

interface DebugKnowledgeCandidate extends Omit<DebugKnowledgeEvidence, 'id' | 'accessCount' | 'evidenceRefs'> {
  evidenceRef: ExperienceEvidenceRef;
}

const AGENTS_CONTEXT_RE = /^# AGENTS\.md instructions for ([^\n]+)\n/gim;
const SKILL_PATH_RE = /((?:~|\.{0,2}|\/)?[^\s"'`]*\/skills\/(?:\.system\/)?([^/\s"'`]+)\/SKILL\.md)\b/i;
const MUTATING_TOOL_RE = /(?:^|[._-])(write|edit|delete|remove|move|rename|apply[_-]?patch)(?:$|[._-])/i;
const READ_ONLY_TOOL_RE = /(?:^|[._-])(read|search|query|fetch|get|list|find|glob|grep|view|open)(?:$|[._-])/i;
const READ_ONLY_SHELL_RE = /^\s*(?:cat|head|tail|sed\s+-n|rg|grep|find|ls|pwd|wc|stat|which|git\s+(?:status|diff|show|log|branch|rev-parse)|gh\s+(?:issue|pr|run|release|repo)\s+(?:view|list|status|checks?))\b/i;

export function buildKnowledgeDebuggerViewModel(
  session: TaskTrajectorySession,
  targetTurnId: string,
  ingestion?: TraceIngestionSummary,
  sourceRecords: ObservationSourceRecordArchiveView = {
    status: 'unavailable',
    recordCount: 0,
    records: [],
    omittedRecordCount: 0,
    byteCount: 0,
    truncated: false,
    reason: 'no_record_ranges',
  },
): KnowledgeDebuggerViewModel {
  const taskWindow = resolveTaskWindow(session, targetTurnId);
  const normalizedEvents = taskWindow.events;
  const timeline = taskWindow.semanticEvents.filter((event) => event.runtimeKind !== 'usage');
  const replayTimeline = [...timeline, ...taskWindow.relatedEvents]
    .sort((left, right) => left.order - right.order);
  const knowledgeEvidence = projectKnowledgeEvidence(timeline);
  const steps = buildTaskReplaySteps(session, replayTimeline, knowledgeEvidence);
  const notices = buildIntegrityNotices(taskWindow.scope, timeline, steps, ingestion);
  const userEvents = timeline.filter((event) => event.kind === 'user_message');
  const assistantEvents = timeline.filter((event) => event.kind === 'assistant_message');
  const observedModels = timeline.reduce<string[]>((models, event) => {
    const eventModel = event.model?.trim();
    if (eventModel && !models.includes(eventModel)) models.push(eventModel);
    return models;
  }, []);

  return {
    session,
    taskScope: taskWindow.scope,
    summary: {
      userGoal: eventText(userEvents[0]),
      finalResponse: eventText(assistantEvents.at(-1)),
      observedStartTimestamp: timeline.find((event) => (
        event.timestamp && event.runtimeKind !== 'session_context'
      ))?.timestamp
        ?? timeline.find((event) => event.timestamp)?.timestamp,
      observedEndTimestamp: [...timeline].reverse().find((event) => event.timestamp)?.timestamp,
      toolCallCount: steps.filter((step) => step.stepKind === 'tool_exchange').length,
      toolFailureCount: steps.filter((step) => step.stepKind === 'tool_exchange' && step.toolStatus === 'failure').length,
      hasUserCorrection: steps.some((step) => step.stepKind === 'user_correction'),
      observedModels,
    },
    steps,
    normalizedEvents,
    sourceRecords,
    knowledgeEvidence,
    integrity: {
      status: notices.length > 0 ? 'partial' : 'complete',
      notices,
    },
  };
}

export function buildTaskReplaySteps(
  session: TaskTrajectorySession,
  timeline: ExperienceTimelineEvent[],
  knowledgeEvidence: DebugKnowledgeEvidence[],
): TaskReplayStep[] {
  const sorted = [...timeline].sort((a, b) => a.order - b.order);
  const resultsByCall = new Map<string, ExperienceTimelineEvent[]>();
  const matchedResultIds = new Set<string>();
  const knowledgeIdsByEvent = knowledgeEvidence.reduce((map, evidence) => {
    for (const ref of evidence.evidenceRefs) {
      map.set(ref.id, [...(map.get(ref.id) ?? []), evidence.id]);
    }
    return map;
  }, new Map<string, string[]>());
  const correctionIds = correctionEventIds(session, sorted);

  for (const event of sorted) {
    if (event.kind !== 'tool_result') continue;
    const key = toolCorrelationKey(event);
    resultsByCall.set(key, [...(resultsByCall.get(key) ?? []), event]);
  }

  const steps: TaskReplayStep[] = [];
  let sawUserRequest = false;
  for (const event of sorted) {
    if (event.kind === 'tool_result' && matchedResultIds.has(event.id)) continue;

    if (event.kind === 'tool_use') {
      const result = resultsByCall.get(toolCorrelationKey(event))?.find((item) => !matchedResultIds.has(item.id));
      if (result) matchedResultIds.add(result.id);
      const events = result ? [event, result] : [event];
      steps.push({
        id: `step:${event.id}`,
        order: event.order,
        stepKind: 'tool_exchange',
        timestamp: event.timestamp,
        title: event.toolName ?? event.label ?? 'Tool call',
        events,
        toolStatus: result?.toolStatus ?? (result?.isError ? 'failure' : event.toolStatus ?? 'unknown'),
        knowledgeEvidenceIds: knowledgeIdsForEvents(events, knowledgeIdsByEvent),
      });
      continue;
    }

    const stepKind = stepKindForEvent(event, sawUserRequest, correctionIds);
    if (event.kind === 'user_message' && !sawUserRequest) sawUserRequest = true;
    steps.push({
      id: `step:${event.id}`,
      order: event.order,
      stepKind,
      timestamp: event.timestamp,
      title: event.toolName ?? event.label ?? event.kind,
      events: [event],
      ...(event.kind === 'tool_result'
        ? { toolStatus: event.toolStatus ?? (event.isError ? 'failure' : 'unknown') }
        : {}),
      knowledgeEvidenceIds: knowledgeIdsForEvents([event], knowledgeIdsByEvent),
    });
  }
  return steps;
}

export function projectKnowledgeEvidence(
  timeline: ExperienceTimelineEvent[],
): DebugKnowledgeEvidence[] {
  const candidates: DebugKnowledgeCandidate[] = [];
  const toolCalls = new Map<string, ExperienceTimelineEvent>();

  for (const event of timeline) {
    if (event.kind === 'tool_use') {
      toolCalls.set(toolCorrelationKey(event), event);
      continue;
    }

    if (event.kind === 'runtime_context') {
      const text = event.fullText ?? event.snippet ?? '';
      const agentsMatches = [...text.matchAll(AGENTS_CONTEXT_RE)];
      for (const [index, agentsMatch] of agentsMatches.entries()) {
        if (!agentsMatch[1]) continue;
        const sectionStart = agentsMatch.index ?? 0;
        const sectionEnd = agentsMatches[index + 1]?.index ?? text.length;
        const section = text.slice(sectionStart, sectionEnd).trim();
        candidates.push({
          knowledgeKind: 'project_instruction',
          accessKind: 'injected',
          label: 'AGENTS.md',
          sourceLocator: `runtime-context:${agentsMatch[1].trim()}`,
          contentHash: contentHash(section),
          firstSeen: event.timestamp,
          lastSeen: event.timestamp,
          evidenceRef: evidenceRef(event),
        });
      }
      continue;
    }

    if (event.kind === 'skill_context') {
      const text = event.fullText ?? event.snippet ?? '';
      candidates.push({
        knowledgeKind: 'skill',
        accessKind: 'injected',
        label: event.label || 'Skill context',
        contentHash: text ? contentHash(text) : undefined,
        firstSeen: event.timestamp,
        lastSeen: event.timestamp,
        evidenceRef: evidenceRef(event),
      });
      continue;
    }

    if (event.kind !== 'tool_result') continue;
    const call = toolCalls.get(toolCorrelationKey(event));
    if (!call) continue;
    const output = event.fullText ?? event.snippet ?? '';
    if (!output.trim()) continue;

    const callText = call.fullText ?? call.snippet ?? '';
    const skillPath = SKILL_PATH_RE.exec(callText);
    if (skillPath?.[1] && skillPath[2]) {
      candidates.push({
        knowledgeKind: 'skill',
        accessKind: 'read',
        label: skillPath[2],
        sourceLocator: skillPath[1],
        contentHash: contentHash(output),
        firstSeen: event.timestamp ?? call.timestamp,
        lastSeen: event.timestamp ?? call.timestamp,
        evidenceRef: evidenceRef(event),
      });
      continue;
    }

    const toolName = call.toolName ?? call.label ?? 'tool';
    if (!isKnowledgeReturningCall(toolName, callText)) continue;
    candidates.push({
      knowledgeKind: 'runtime_evidence',
      accessKind: 'returned',
      label: toolName,
      sourceLocator: sourceLocator(callText),
      contentHash: contentHash(output),
      firstSeen: event.timestamp ?? call.timestamp,
      lastSeen: event.timestamp ?? call.timestamp,
      evidenceRef: evidenceRef(event),
    });
  }

  return aggregateCandidates(candidates);
}

function isKnowledgeReturningCall(toolName: string, callText: string): boolean {
  if (MUTATING_TOOL_RE.test(toolName)) return false;
  if (READ_ONLY_TOOL_RE.test(toolName)) return true;
  const command = sourceLocator(callText);
  return command ? READ_ONLY_SHELL_RE.test(command) : false;
}

function buildIntegrityNotices(
  taskScope: KnowledgeDebuggerViewModel['taskScope'],
  timeline: ExperienceTimelineEvent[],
  steps: TaskReplayStep[],
  ingestion?: TraceIngestionSummary,
): TaskReplayIntegrityNotice[] {
  const notices: TaskReplayIntegrityNotice[] = [];
  if (taskScope.basis === 'unresolved') {
    notices.push({ code: 'task_boundary_unavailable', count: 1 });
  }
  const omittedSemanticEvents = taskScope.normalizedEventCount - taskScope.semanticEventCount;
  if (omittedSemanticEvents > 0) {
    notices.push({ code: 'timeline_truncated', count: omittedSemanticEvents });
  }
  if (ingestion?.malformedRecordCount) notices.push({ code: 'malformed_records', count: ingestion.malformedRecordCount });
  if (ingestion?.ignoredValueCount) notices.push({ code: 'ignored_values', count: ingestion.ignoredValueCount });
  if (ingestion?.unknownEventCount) notices.push({ code: 'unknown_events', count: ingestion.unknownEventCount });
  const unmatchedCalls = steps.filter((step) => step.stepKind === 'tool_exchange' && step.events.length === 1).length;
  if (unmatchedCalls > 0) notices.push({ code: 'unmatched_tool_calls', count: unmatchedCalls });
  const unmatchedResults = steps.filter((step) => step.stepKind === 'unmatched_tool_result').length;
  if (unmatchedResults > 0) notices.push({ code: 'unmatched_tool_results', count: unmatchedResults });
  const missingTimestamps = timeline.filter((event) => !event.timestamp).length;
  if (missingTimestamps > 0) notices.push({ code: 'missing_timestamps', count: missingTimestamps });
  return notices;
}

function correctionEventIds(
  session: TaskTrajectorySession,
  timeline: ExperienceTimelineEvent[],
): Set<string> {
  const ids = new Set<string>();
  for (const episode of session.sessionStory?.episodes ?? []) {
    for (const signal of episode.feedbackSignals) {
      if (signal.type === 'correction' || signal.type === 'frustration' || signal.type === 'interruption') {
        ids.add(signal.evidenceRef.id);
      }
    }
  }
  const userCorrectionCount = session.indicators?.userCorrectionCount ?? 0;
  const lastAssistantOrder = Math.max(
    -1,
    ...timeline.filter((event) => event.kind === 'assistant_message').map((event) => event.order),
  );
  const explicitCandidates = timeline
    .filter((event) => (
      event.kind === 'user_message'
      && event.order > lastAssistantOrder
      && hasUserCorrectionSignal(event.fullText ?? event.snippet ?? '')
    ));
  for (const event of explicitCandidates) ids.add(event.id);
  if (ids.size > 0 || userCorrectionCount === 0) return ids;

  const correctionCandidates = timeline
    .filter((event) => event.kind === 'user_message' && event.order > lastAssistantOrder)
    .slice(-userCorrectionCount);
  for (const event of correctionCandidates) ids.add(event.id);
  return ids;
}

function stepKindForEvent(
  event: ExperienceTimelineEvent,
  sawUserRequest: boolean,
  correctionIds: Set<string>,
): TaskReplayStepKind {
  if (event.kind === 'user_message') {
    if (correctionIds.has(event.id)) return 'user_correction';
    return sawUserRequest ? 'user_message' : 'user_request';
  }
  if (event.kind === 'assistant_message') return 'assistant_message';
  if (event.kind === 'model_activity') return 'model_activity';
  if (event.kind === 'lifecycle') return 'lifecycle';
  if (event.kind === 'runtime_context') return 'runtime_context';
  if (event.kind === 'skill_context') return 'skill_context';
  if (event.kind === 'tool_result') return 'unmatched_tool_result';
  if (event.kind === 'observation') return 'observation';
  return 'system_event';
}

function knowledgeIdsForEvents(
  events: ExperienceTimelineEvent[],
  knowledgeIdsByEvent: Map<string, string[]>,
): string[] {
  return [...new Set(events.flatMap((event) => knowledgeIdsByEvent.get(event.id) ?? []))];
}

function aggregateCandidates(candidates: DebugKnowledgeCandidate[]): DebugKnowledgeEvidence[] {
  const aggregated = new Map<string, DebugKnowledgeEvidence>();
  for (const candidate of candidates) {
    const identity = [
      candidate.knowledgeKind,
      candidate.accessKind,
      candidate.sourceLocator ?? candidate.label,
      candidate.contentHash ?? '',
    ].join('\u0000');
    const id = `knowledge:${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`;
    const current = aggregated.get(id);
    if (current) {
      current.accessCount += 1;
      current.evidenceRefs.push(candidate.evidenceRef);
      if (candidate.firstSeen && (!current.firstSeen || candidate.firstSeen < current.firstSeen)) {
        current.firstSeen = candidate.firstSeen;
      }
      if (candidate.lastSeen && (!current.lastSeen || candidate.lastSeen > current.lastSeen)) {
        current.lastSeen = candidate.lastSeen;
      }
      continue;
    }
    aggregated.set(id, {
      id,
      knowledgeKind: candidate.knowledgeKind,
      accessKind: candidate.accessKind,
      label: candidate.label,
      sourceLocator: candidate.sourceLocator,
      contentHash: candidate.contentHash,
      firstSeen: candidate.firstSeen,
      lastSeen: candidate.lastSeen,
      accessCount: 1,
      evidenceRefs: [candidate.evidenceRef],
    });
  }
  return [...aggregated.values()].sort((a, b) => {
    const aTime = a.firstSeen ?? '';
    const bTime = b.firstSeen ?? '';
    return aTime.localeCompare(bTime) || a.label.localeCompare(b.label);
  });
}

function toolCorrelationKey(event: ExperienceTimelineEvent): string {
  return event.callInstanceId ?? event.toolUseId ?? event.id;
}

function sourceLocator(inputText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputText) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'url', 'query', 'command', 'cmd']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  }
  return undefined;
}

function eventText(event: ExperienceTimelineEvent | undefined): string | undefined {
  const text = event?.fullText ?? event?.snippet;
  return text?.trim() || undefined;
}

function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceRef(event: ExperienceTimelineEvent): ExperienceEvidenceRef {
  return {
    id: event.id,
    kind: event.kind,
    traceId: event.traceId,
    sourceTrace: event.sourceTrace,
    sessionId: event.sessionId,
    traceRole: event.traceRole,
    traceLabel: event.traceLabel,
    messageIndex: event.messageIndex,
    logicalMessageIndex: event.logicalMessageIndex,
    sourceLineIndex: event.sourceLineIndex,
    messageUuid: event.messageUuid,
    sourceType: event.sourceType,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    timestamp: event.timestamp,
    role: event.role,
    runtimeKind: event.runtimeKind,
    label: event.label,
    snippet: event.snippet,
  };
}
