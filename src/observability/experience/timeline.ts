import { basename } from 'node:path';
import type {
  ExperienceTimelineBranch,
  ExperienceTimelineEvent,
  ExperienceTimelineTree,
} from '../contracts/experience.js';
import {
  type TraceEvent,
  type TraceMessageEvent,
  type TraceSession,
} from '../trace/trace-ir.js';
import type { SkillSegment } from '../trace/segmentation.js';
import {
  extractCommandEnvelopeText,
  stripCommandEnvelopeText,
} from '../trace/attribution.js';
import {
  hasAssistantDeliverySignalText,
  isAssistantProtocolReplyText,
} from '../text-signals.js';
import {
  compareTimelineEvents,
  fullText,
  hashParts,
  snippet,
  uniqueTimelineEvents,
} from './primitives.js';

export function logicalSessionId(session: TraceSession): string {
  return session.rootRunId;
}

export function experienceSessionGroupKey(session: TraceSession): string {
  const logicalId = logicalSessionId(session);
  if (session.role !== 'standalone' && session.groupPath) {
    return `group:${session.groupPath}\u0000${logicalId}`;
  }
  return `trace:${session.traceId}`;
}

export function groupSessionsByExperienceKey(sessions: TraceSession[]): Map<string, TraceSession[]> {
  const groups = new Map<string, TraceSession[]>();
  for (const session of sessions) {
    const key = experienceSessionGroupKey(session);
    const group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  for (const [key, group] of groups.entries()) {
    groups.set(key, group.sort(compareSessionsForTimeline));
  }
  return groups;
}

export function compareSessionsForTimeline(a: TraceSession, b: TraceSession): number {
  const roleRank = (session: TraceSession): number => session.role === 'main' ? 0 : session.role === 'standalone' ? 1 : 2;
  const rank = roleRank(a) - roleRank(b);
  if (rank !== 0) return rank;
  const time = (a.startTimestamp ?? '').localeCompare(b.startTimestamp ?? '');
  if (time !== 0) return time;
  return a.sourcePath.localeCompare(b.sourcePath)
    || a.traceId.localeCompare(b.traceId);
}

export function segmentRecordBounds(session: TraceSession, segment: SkillSegment): { start: number; end: number } {
  if (typeof segment.startRecordIndex === 'number' && typeof segment.endRecordIndex === 'number') {
    const rawStart = eventIndexForSourceIndex(session, segment.startRecordIndex, 'first');
    const rawEnd = eventIndexForSourceIndex(
      session,
      Math.max(segment.startRecordIndex, segment.endRecordIndex),
      'last',
    );
    const humanStart = Math.min(rawStart, previousHumanUserRecordIndex(session, rawStart) ?? rawStart);
    return {
      start: includeLeadingRuntimeContext(session, humanStart),
      end: includeTrailingDeliveryContext(session, Math.min(session.events.length, rawEnd + 1)),
    };
  }
  const indexes = segment.toolCalls
    .map((toolCall) => toolCall.messageIndex)
    .filter((index): index is number => typeof index === 'number' && index >= 0);
  if (indexes.length > 0) {
    const firstEventIndex = eventIndexForSourceIndex(session, Math.min(...indexes), 'first');
    const lastEventIndex = eventIndexForSourceIndex(session, Math.max(...indexes), 'last');
    const start = Math.max(0, firstEventIndex - 3);
    return {
      start: Math.min(start, previousHumanUserRecordIndex(session, start) ?? start),
      end: includeTrailingDeliveryContext(session, Math.min(session.events.length, lastEventIndex + 5)),
    };
  }
  const timestampIndexes: number[] = [];
  session.events.forEach((event, index) => {
    const ts = event.timestamp;
    if (ts && ts >= segment.startTimestamp && ts <= segment.endTimestamp) timestampIndexes.push(index);
  });
  if (timestampIndexes.length === 0) return { start: 0, end: Math.min(session.events.length, 12) };
  const start = Math.max(0, Math.min(...timestampIndexes) - 2);
  return {
    start: Math.min(start, previousHumanUserRecordIndex(session, start) ?? start),
    end: includeTrailingDeliveryContext(session, Math.min(session.events.length, Math.max(...timestampIndexes) + 3)),
  };
}

export function clampRecordIndex(session: TraceSession, index: number): number {
  return Math.max(0, Math.min(session.events.length - 1, index));
}

export function eventIndexForSourceIndex(
  session: TraceSession,
  sourceIndex: number,
  edge: 'first' | 'last',
): number {
  if (edge === 'first') {
    const index = session.events.findIndex((event) => event.sourceIndex >= sourceIndex);
    return index < 0 ? clampRecordIndex(session, sourceIndex) : index;
  }
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    if (session.events[index].sourceIndex <= sourceIndex) return index;
  }
  return 0;
}

export function includeLeadingRuntimeContext(session: TraceSession, start: number): number {
  let nextStart = start;
  for (let index = start - 1; index >= 0; index -= 1) {
    const events = timelineEventsFromTraceEvent(session, session.events[index], index);
    if (events.length === 0) continue;
    if (events.some((event) => event.kind === 'runtime_context')) {
      nextStart = index;
      continue;
    }
    break;
  }
  return nextStart;
}

export function includeTrailingDeliveryContext(session: TraceSession, end: number): number {
  const safeEnd = Math.min(session.events.length, Math.max(0, end));
  const lookaheadEnd = Math.min(session.events.length, safeEnd + 8);
  for (let index = safeEnd; index < lookaheadEnd; index += 1) {
    const events = timelineEventsFromTraceEvent(session, session.events[index], index);
    if (events.some((event) => event.kind === 'user_message')) break;
    if (events.some(isAssistantDeliveryEvent)) return index + 1;
  }
  return safeEnd;
}

export function previousHumanUserRecordIndex(session: TraceSession, start: number): number | undefined {
  for (let index = Math.min(start, session.events.length - 1); index >= 0; index -= 1) {
    const events = timelineEventsFromTraceEvent(session, session.events[index], index);
    if (events.some((event) => event.kind === 'user_message')) return index;
  }
  return undefined;
}

export function isAssistantDeliveryEvent(event: ExperienceTimelineEvent): boolean {
  if (event.kind !== 'assistant_message') return false;
  const text = event.fullText ?? event.snippet ?? '';
  return hasAssistantDeliverySignalText(text);
}

export function buildInvocationTimeline(
  session: TraceSession,
  start: number,
  end: number,
  segment: SkillSegment,
): ExperienceTimelineEvent[] {
  const window = buildTimelineWindow(session, start, end);
  const callInstanceIds = new Set(
    segment.toolCalls.flatMap((toolCall) =>
      toolCall.callInstanceId ? [toolCall.callInstanceId] : []
    ),
  );
  const legacyCallIds = new Set(
    segment.toolCalls.flatMap((toolCall) =>
      !toolCall.callInstanceId && toolCall.toolUseId ? [toolCall.toolUseId] : []
    ),
  );
  if (callInstanceIds.size === 0 && legacyCallIds.size === 0) return window;
  const linkedResults = session.events.flatMap((event, eventIndex) =>
    event.eventKind === 'tool_result'
    && (
      event.callInstanceId
        ? callInstanceIds.has(event.callInstanceId)
        : legacyCallIds.has(event.callId)
    )
    && (eventIndex < start || eventIndex >= end)
      ? timelineEventsFromTraceEvent(session, event, eventIndex)
      : [],
  );
  return uniqueTimelineEvents([...window, ...linkedResults]).sort(compareTimelineEvents);
}

export function buildTimelineWindow(session: TraceSession, start: number, end: number): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const safeEnd = Math.min(session.events.length, Math.max(start, end));
  for (let index = start; index < safeEnd; index += 1) {
    events.push(...timelineEventsFromTraceEvent(session, session.events[index], index));
  }
  return events.sort((a, b) => a.order - b.order);
}

/** Project one source-neutral Trace IR session into Studio's semantic timeline. */
export function projectTraceSessionTimeline(session: TraceSession): ExperienceTimelineEvent[] {
  return buildTimelineWindow(session, 0, session.events.length);
}

export function timelineEventsFromTraceEvent(
  session: TraceSession,
  event: TraceEvent,
  eventIndex: number,
): ExperienceTimelineEvent[] {
  const messageIndex = event.sourceIndex;
  const base = {
    traceId: session.traceId,
    sourceTrace: session.sourcePath,
    sessionId: logicalSessionId(session),
    traceRole: session.role,
    traceLabel: session.label,
    messageIndex,
    logicalMessageIndex: messageIndex,
    sourceLineIndex: messageIndex,
    messageUuid: event.sourceEventId ?? event.eventId,
    sourceType: event.sourceType,
    turnId: event.turnId,
    timestamp: event.timestamp,
  };
  const order = eventIndex * 10;

  if (event.eventKind === 'message' && event.role === 'user') {
    return userTimelineEvents(event, base, order);
  }
  if (event.eventKind === 'message' && event.role === 'system') {
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'tool',
      order,
      snippet: snippet(event.text, 700),
      fullText: fullText(event.text),
      label: 'system context',
    })];
  }
  if (event.eventKind === 'message' && event.role === 'assistant') {
    const protocolReply = isAssistantProtocolReplyText(event.text);
    return [timelineEvent({
      ...base,
      kind: protocolReply ? 'runtime_context' : 'assistant_message',
      role: 'assistant',
      order,
      model: event.model,
      snippet: snippet(event.text, 700),
      fullText: fullText(event.text),
      label: protocolReply ? 'assistant protocol reply' : 'assistant message',
    })];
  }
  if (event.eventKind === 'model_activity') {
    return [timelineEvent({
      ...base,
      kind: 'model_activity',
      role: 'assistant',
      order,
      model: event.model,
      modelActivityKind: event.activityKind,
      contentVisibility: event.contentVisibility,
      contentSource: event.contentSource,
      snippet: snippet(event.text, 700),
      fullText: fullText(event.text),
      label: 'model reasoning',
    })];
  }
  if (event.eventKind === 'tool_call') {
    const inputText = JSON.stringify(event.input);
    return [timelineEvent({
      ...base,
      kind: 'tool_use',
      role: 'assistant',
      order,
      callInstanceId: event.callInstanceId,
      toolUseId: event.callId,
      toolName: event.tool.displayName ?? event.tool.name,
      snippet: snippet(inputText, 900),
      fullText: fullText(inputText),
      label: `tool_use ${event.tool.displayName ?? event.tool.name}`,
    })];
  }
  if (event.eventKind === 'tool_result') {
    const failed = event.status === 'failure';
    return [timelineEvent({
      ...base,
      kind: 'tool_result',
      role: 'tool',
      order,
      callInstanceId: event.callInstanceId,
      toolUseId: event.callId,
      toolStatus: event.status,
      isError: failed,
      snippet: snippet(event.output, 900),
      fullText: fullText(event.output),
      label: failed
        ? 'tool result error'
        : event.status === 'cancelled' ? 'tool result cancelled'
        : event.status === 'unknown' ? 'tool result status unknown' : 'tool result',
    })];
  }
  if (event.eventKind === 'lifecycle') {
    return [timelineEvent({
      ...base,
      kind: 'lifecycle',
      role: 'other',
      order,
      snippet: snippet(`${event.phase}${event.reason ? `: ${event.reason}` : ''}`, 700),
      fullText: fullText(JSON.stringify(event)),
      label: event.phase,
    })];
  }
  if (event.eventKind === 'runtime_context') {
    const details = JSON.stringify({
      runtimeName: event.runtimeName,
      runtimeVersion: event.runtimeVersion,
      cwd: event.cwd,
      workspaceRoots: event.workspaceRoots,
      currentDate: event.currentDate,
      timezone: event.timezone,
      model: event.model,
      modelProvider: event.modelProvider,
      serviceTier: event.serviceTier,
      reasoningEffort: event.reasoningEffort,
      reasoningSummary: event.reasoningSummary,
      personality: event.personality,
      approvalPolicy: event.approvalPolicy,
      approvalReviewer: event.approvalReviewer,
      permissionProfile: event.permissionProfile,
      sandboxMode: event.sandboxMode,
      collaborationMode: event.collaborationMode,
      realtimeActive: event.realtimeActive,
      multiAgentMode: event.multiAgentMode,
      multiAgentVersion: event.multiAgentVersion,
      memoryMode: event.memoryMode,
      historyMode: event.historyMode,
      contextWindowId: event.contextWindowId,
      parentRunId: event.parentRunId,
      delegationDepth: event.delegationDepth,
      sourceOrigin: event.sourceOrigin,
      availableTools: event.availableTools,
      instructions: event.instructions,
      goal: event.goal,
      goalStatus: event.goalStatus,
      summary: event.summary,
    });
    const visible = event.summary
      ?? event.goal
      ?? event.instructions
      ?? [event.runtimeName, event.runtimeVersion, event.cwd, event.model, event.reasoningEffort, event.collaborationMode]
        .filter(Boolean)
        .join(' · ');
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      model: event.model,
      runtimeKind: event.runtimeKind,
      snippet: snippet(visible, 700),
      fullText: fullText(details),
      label: event.runtimeKind,
    })];
  }
  if (event.eventKind === 'context_compaction') {
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      runtimeKind: 'context_compaction',
      snippet: snippet(event.summary ?? 'context compacted', 700),
      fullText: fullText(JSON.stringify(event)),
      label: 'context compacted',
    })];
  }
  if (event.eventKind === 'agent_activity') {
    const visible = event.text
      ?? [event.activity, event.author, event.recipient, event.agentPath, event.agentId]
        .filter(Boolean)
        .join(' · ');
    return [timelineEvent({
      ...base,
      kind: 'agent_activity',
      role: 'other',
      order,
      snippet: snippet(visible, 700),
      fullText: fullText(JSON.stringify({
        activityKind: event.activityKind,
        activity: event.activity,
        author: event.author,
        recipient: event.recipient,
        agentId: event.agentId,
        agentPath: event.agentPath,
        text: event.text,
      })),
      label: event.activityKind === 'communication' ? 'agent communication' : 'agent status',
    })];
  }
  if (event.eventKind === 'usage') {
    const usageText = JSON.stringify({
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      reasoningTokens: event.reasoningTokens,
    });
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      model: event.model,
      runtimeKind: 'usage',
      snippet: snippet(usageText, 700),
      fullText: fullText(usageText),
      label: 'token usage',
    })];
  }
  if (event.eventKind === 'unknown') {
    const rawText = safeRecordText(event.raw);
    if (!hasAssistantTurnFailedText(rawText)) return [];
    return [timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'other',
      order,
      snippet: snippet(rawText, 700),
      fullText: fullText(rawText),
      label: event.sourceType,
    })];
  }
  return [];
}

export function userTimelineEvents(
  event: TraceMessageEvent,
  base: Omit<ExperienceTimelineEvent, 'id' | 'kind' | 'order'>,
  order: number,
): ExperienceTimelineEvent[] {
  const events: ExperienceTimelineEvent[] = [];
  const commandEnvelope = extractCommandEnvelopeText(event.text);
  if (commandEnvelope) {
    events.push(timelineEvent({
      ...base,
      kind: 'runtime_context',
      role: 'tool',
      order,
      snippet: snippet(commandEnvelope, 700),
      fullText: fullText(commandEnvelope),
      label: 'command envelope',
    }));
  }
  const text = commandEnvelope ? stripCommandEnvelopeText(event.text) : event.text;
  const displayedSourceText = event.displayText?.trim() || event.text;
  const displayText = commandEnvelope
    ? stripCommandEnvelopeText(displayedSourceText)
    : displayedSourceText;
  const semanticText = event.origin === 'human' ? displayText : text;
  if (!semanticText.trim()) return events;
  const kind = event.origin === 'human'
    ? 'user_message'
    : event.origin === 'skill-context'
      ? 'skill_context'
      : event.origin === 'synthetic'
        ? 'synthetic_user_event'
        : 'runtime_context';
  events.push(timelineEvent({
    ...base,
    kind,
    role: kind === 'user_message' ? 'user' : kind === 'synthetic_user_event' ? 'other' : 'tool',
    order: order + (commandEnvelope ? 1 : 0),
    snippet: snippet(semanticText, 700),
    fullText: fullText(semanticText),
    attachments: event.attachments,
    label: userTextEventLabel(kind),
  }));
  return events;
}

export function safeRecordText(record: unknown): string {
  try {
    return JSON.stringify(record);
  } catch {
    return String(record ?? '');
  }
}

export function hasAssistantTurnFailedText(value: string): boolean {
  return /\[assistant turn failed\]|assistant turn failed|assistant_turn_failed|turn failed/i.test(value);
}

export function timelineEvent(input: Omit<ExperienceTimelineEvent, 'id'>): ExperienceTimelineEvent {
  return {
    ...input,
    id: hashParts(
      input.traceId ?? '',
      input.sourceTrace,
      input.sessionId,
      input.messageUuid ?? '',
      String(input.messageIndex ?? ''),
      input.kind,
      input.callInstanceId ?? '',
      input.toolUseId ?? '',
      input.snippet ?? '',
    ),
  };
}

export function userTextEventLabel(kind: 'user_message' | 'synthetic_user_event' | 'skill_context' | 'runtime_context'): string {
  if (kind === 'skill_context') return 'skill context';
  if (kind === 'runtime_context') return 'runtime context';
  if (kind === 'synthetic_user_event') return 'synthetic user event';
  return 'user message';
}

export function buildSessionTimelineTree(sessionId: string, sessions: TraceSession[]): ExperienceTimelineTree {
  const mainSession = sessions.find((session) => session.role === 'main')
    ?? sessions.find((session) => session.role === 'standalone');
  const main = mainSession ? buildTimelineWindow(mainSession, 0, mainSession.events.length) : [];
  const branches = sessions
    .filter((session) => !mainSession || session !== mainSession)
    .map((session): ExperienceTimelineBranch => {
      const events = buildTimelineWindow(session, 0, session.events.length);
      const attachTo = inferSubagentAttachment(main, session);
      return {
        id: hashParts('timeline-branch', session.traceId),
        label: (session.label ?? basename(session.sourcePath)) || 'subagent',
        sessionId: session.runId,
        traceId: session.traceId,
        sourceTrace: session.sourcePath,
        traceRole: session.role,
        attachTo,
        events,
      };
    });
  return {
    sessionId,
    main,
    branches,
  };
}

export function inferSubagentAttachment(
  mainEvents: ExperienceTimelineEvent[],
  branchSession: TraceSession,
): ExperienceTimelineBranch['attachTo'] | undefined {
  const startedAt = branchSession.startTimestamp;
  const taskUses = mainEvents.filter((event) => event.kind === 'tool_use' && /^(Task|Agent|Skill)$/i.test(event.toolName ?? ''));
  const candidates = startedAt
    ? taskUses.filter((event) => !event.timestamp || event.timestamp <= startedAt)
    : taskUses;
  const event = candidates.at(-1) ?? taskUses.at(-1);
  if (!event) return undefined;
  return {
    traceId: event.traceId,
    sourceTrace: event.sourceTrace,
    messageIndex: event.messageIndex,
    callInstanceId: event.callInstanceId,
    toolUseId: event.toolUseId,
    label: event.toolName,
  };
}
