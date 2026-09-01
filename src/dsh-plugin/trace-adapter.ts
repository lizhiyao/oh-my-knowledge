import type { ExperienceTurnStatus } from '../observability/contracts/experience.js';
import { normalizeToolIdentity } from '../shared/tool-identity.js';
import {
  correlateTraceToolEvents,
  createTraceId,
  traceTimestampBounds,
  type TraceEvent,
  type TraceMessageOrigin,
  type TraceSession,
} from '../observability/trace-ir.js';

type UnknownRecord = Record<string, unknown>;

export interface DshSessionHeaderLike {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly seedLength?: number;
  readonly origin?: string;
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
}

export interface DshSessionEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: readonly number[];
  readonly surfaceOp?: unknown;
}

export interface DshTraceIntegrity {
  complete: boolean;
  status: ExperienceTurnStatus;
  unknownEventCount: number;
  ignoredChunkCount: number;
  unmatchedToolCallCount: number;
  unmatchedToolResultCount: number;
  openTurnCount: number;
  openStepCount: number;
}

export interface DshTraceAdapterOptions {
  rootRunId?: string;
  role?: TraceSession['role'];
  groupPath?: string;
}

export interface DshTraceAdapterResult {
  session: TraceSession;
  integrity: DshTraceIntegrity;
}

export class DshTraceUnsupportedEventError extends Error {
  constructor(readonly eventType: string, readonly seq: number) {
    super(`DSH session 包含 OMK 尚不认识的 required event：${eventType}（seq=${seq}）。`);
    this.name = 'DshTraceUnsupportedEventError';
  }
}

const AUXILIARY_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'command/done',
  'command/run',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'llm/retry',
  'llm/retry-started',
  'permission/preset',
  'plan/mode',
  'sandbox/mode',
  'schedule/change',
  'session/title',
  'session/title-llm-request',
  'subagent/descriptor',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/code-dispatch',
  'tool/code-dispatch-start',
  'web/deepseek-search-llm-request',
]);

const PROJECTED_EVENT_TYPES = new Set([
  'assistant/chunk',
  'assistant/message',
  'request/context',
  'request/header',
  'session/end-seed',
  'step/end',
  'step/start',
  'todo/write',
  'tool/call',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
]);

export function supportsDshTraceEventType(eventType: string): boolean {
  return PROJECTED_EVENT_TYPES.has(eventType)
    || AUXILIARY_EVENT_TYPES.has(eventType)
    || eventType.startsWith('compaction/');
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function timestamp(value: unknown): string | undefined {
  const milliseconds = nonNegativeInteger(value);
  if (milliseconds === undefined) return undefined;
  return new Date(milliseconds).toISOString();
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((block) => (
    isRecord(block) && block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : []
  )).join('');
}

function reasoningFromContent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => (
    isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string'
      ? [block.text]
      : []
  ));
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Preserve the exact provider output below.
    }
    return { rawArguments: value };
  }
  return { rawArguments: value ?? null };
}

function turnId(runId: string, data: UnknownRecord): string | undefined {
  const turn = nonNegativeInteger(data.turn);
  return turn === undefined ? undefined : `dsh:${runId}:turn:${turn}`;
}

function eventBase(
  runId: string,
  event: DshSessionEventLike,
  sourceIndex: number,
  suffix: string,
): Pick<TraceEvent, 'eventId' | 'sourceIndex' | 'sourceType' | 'timestamp' | 'turnId'> {
  const data = isRecord(event.data) ? event.data : {};
  return {
    eventId: `${runId}:${event.seq}:${suffix}`,
    sourceIndex,
    sourceType: event.type,
    timestamp: timestamp(event.time),
    turnId: turnId(runId, data),
  };
}

function messageOrigin(source: unknown): TraceMessageOrigin {
  if (!isRecord(source)) return 'synthetic';
  const sourceKind = stringValue(source.kind);
  if (sourceKind === 'user') return 'human';
  if (sourceKind === 'skill-invocation' || sourceKind === 'skill-catalog') return 'skill-context';
  if (sourceKind?.includes('skill')) return 'skill-context';
  if (sourceKind === 'plugin' || sourceKind === 'agent-instructions') return 'runtime';
  return 'synthetic';
}

function turnEndProjection(reason: unknown): {
  phase: Extract<TraceEvent, { eventKind: 'lifecycle' }>['phase'];
  status: ExperienceTurnStatus;
  reason: string;
} {
  const record = isRecord(reason) ? reason : {};
  const reasonKind = stringValue(record.kind) ?? 'unknown';
  if (reasonKind === 'completed') return { phase: 'turn_completed', status: 'completed', reason: reasonKind };
  if (reasonKind === 'aborted') return { phase: 'turn_aborted', status: 'aborted', reason: jsonText(record) };
  if (reasonKind === 'interrupted') return { phase: 'turn_interrupted', status: 'interrupted', reason: reasonKind };
  if (reasonKind === 'error' || reasonKind === 'blocked' || reasonKind === 'max-tokens') {
    return { phase: 'turn_failed', status: 'failed', reason: jsonText(record) };
  }
  return {
    phase: 'turn_ended_unknown',
    status: 'unknown',
    reason: `unknown terminal reason: ${jsonText(record)}`,
  };
}

function requestFacts(data: UnknownRecord): {
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  contextWindowId?: string;
} {
  if (isRecord(data.header)) {
    const config = isRecord(data.header.config) ? data.header.config : {};
    return {
      model: stringValue(config.model),
      provider: stringValue(config.provider),
      reasoningEffort: stringValue(config.reasoningEffort),
    };
  }
  return {
    model: stringValue(data.model),
    provider: stringValue(data.provider),
    contextWindowId: nonNegativeInteger(data.contextWindow)?.toString(),
  };
}

function compactionEvents(
  runId: string,
  event: DshSessionEventLike,
  sourceIndex: number,
): TraceEvent[] {
  const data = isRecord(event.data) ? event.data : {};
  if (event.type === 'compaction/summary') {
    return [{
      ...eventBase(runId, event, sourceIndex, 'compaction-summary'),
      eventKind: 'context_compaction',
      summary: textFromContent(data.summary),
      replacementItemCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined,
    }];
  }
  return [{
    ...eventBase(runId, event, sourceIndex, 'compaction'),
    eventKind: 'runtime_context',
    runtimeKind: 'execution_context',
    summary: `${event.type}: ${jsonText(data)}`,
  }];
}

function auxiliaryEvent(
  runId: string,
  event: DshSessionEventLike,
  sourceIndex: number,
): TraceEvent {
  const data = isRecord(event.data) ? event.data : {};
  const agentActivity = event.type.startsWith('subagent/')
    || event.type.startsWith('team/')
    || event.type.startsWith('tool-workflow/');
  if (agentActivity) {
    return {
      ...eventBase(runId, event, sourceIndex, 'agent-activity'),
      eventKind: 'agent_activity',
      activityKind: event.type.includes('message') ? 'communication' : 'status',
      activity: event.type,
      agentId: stringValue(data.agentId) ?? stringValue(data.memberId),
      author: stringValue(data.author),
      recipient: stringValue(data.recipient),
      text: jsonText(data),
    };
  }
  return {
    ...eventBase(runId, event, sourceIndex, 'runtime-context'),
    eventKind: 'runtime_context',
    runtimeKind: event.type.startsWith('goal/') || event.type === 'todo/write' ? 'goal' : 'execution_context',
    goal: event.type.startsWith('goal/') || event.type === 'todo/write' ? jsonText(data) : undefined,
    summary: `${event.type}: ${jsonText(data)}`,
  };
}

function toolResultData(data: UnknownRecord): {
  callId?: string;
  output: string;
  failed: boolean;
} {
  const message = isRecord(data.message) ? data.message : {};
  const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
  const result = blocks.find((block) => block.type === 'tool-result');
  const content = isRecord(result) ? result.content : undefined;
  const output = textFromContent(content) || jsonText(content ?? result ?? data);
  return {
    callId: isRecord(result) ? stringValue(result.toolCallId) : undefined,
    output,
    failed: data.error !== undefined || (isRecord(result) && result.isError === true),
  };
}

function validateEnvelope(event: DshSessionEventLike, expectedSeq: number): void {
  if (!Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) {
    throw new Error(`DSH session event seq 不连续：期望 ${expectedSeq}，实际 ${String(event.seq)}。`);
  }
  if (!Number.isSafeInteger(event.time) || event.time < 0) {
    throw new Error(`DSH session event time 非法：seq=${event.seq}。`);
  }
  if (!event.type.trim()) throw new Error(`DSH session event type 为空：seq=${event.seq}。`);
}

/** Project one validated, backend-neutral DSH logical log into OMK Trace IR. */
export function adaptDshSession(
  header: DshSessionHeaderLike,
  inputEvents: readonly DshSessionEventLike[],
  options: DshTraceAdapterOptions = {},
): DshTraceAdapterResult {
  const runId = String(header.id);
  if (!runId.trim()) throw new Error('DSH session header 缺少 id。');
  const seedLength = header.seedLength === undefined ? 0 : nonNegativeInteger(header.seedLength);
  if (seedLength === undefined || seedLength > inputEvents.length) {
    throw new Error(`DSH session header seedLength 非法：${String(header.seedLength)}。`);
  }
  inputEvents.forEach(validateEnvelope);
  const activeEvents = inputEvents.slice(seedLength);
  const isSubagent = header.origin === 'subagent';
  const sourcePath = `dsh:${runId}`;
  const traceId = createTraceId({ sourceKind: 'dsh', runId, sourcePath });
  const rootRunId = options.rootRunId ?? (isSubagent ? header.parentSession : undefined) ?? runId;
  const role = options.role ?? (isSubagent ? 'subagent' : 'main');
  const events: TraceEvent[] = [{
    eventKind: 'lifecycle',
    eventId: `${runId}:header:session-started`,
    sourceIndex: 0,
    sourceType: 'session/header',
    timestamp: timestamp(header.createdAt),
    phase: 'session_started',
  }, {
    eventKind: 'runtime_context',
    eventId: `${runId}:header:context`,
    sourceIndex: 0,
    sourceType: 'session/header',
    timestamp: timestamp(header.createdAt),
    runtimeKind: 'session_context',
    runtimeName: 'DeepSeek Harness',
    cwd: header.cwd,
    parentRunId: isSubagent ? header.parentSession : undefined,
    delegationDepth: header.delegationDepth,
    sourceOrigin: header.origin,
    historyMode: header.seedLength === undefined ? undefined : `seed:${header.seedLength}`,
    summary: jsonText({
      agentPreset: header.agentPreset,
      parentSession: header.parentSession,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      seedLength: header.seedLength,
    }),
  }];
  const pendingTools = new Set<string>();
  const openTurns = new Set<number>();
  const openSteps = new Set<string>();
  const assembledSteps = new Set<string>();
  let unknownEventCount = 0;
  let ignoredChunkCount = 0;
  let unmatchedToolResultCount = 0;
  const terminal: { status: ExperienceTurnStatus } = { status: 'unknown' };
  let observedModel: string | undefined;
  let observedProvider: string | undefined;

  for (const event of activeEvents) {
    if (event.type !== 'assistant/message') continue;
    const data = isRecord(event.data) ? event.data : {};
    const turn = nonNegativeInteger(data.turn);
    const step = nonNegativeInteger(data.step);
    if (turn !== undefined && step !== undefined) assembledSteps.add(`${turn}:${step}`);
  }

  inputEvents.slice(0, seedLength).forEach((event) => {
    if (event.ignorable !== true && !supportsDshTraceEventType(event.type)) {
      throw new DshTraceUnsupportedEventError(event.type, event.seq);
    }
  });

  activeEvents.forEach((event, activeIndex) => {
    const index = seedLength + activeIndex;
    const sourceIndex = index + 1;
    const data = isRecord(event.data) ? event.data : {};
    const base = (suffix: string) => eventBase(runId, event, sourceIndex, suffix);
    const sourceEventId = (value: unknown): { sourceEventId?: string } => {
      const id = stringValue(value);
      return id ? { sourceEventId: id } : {};
    };

    if (event.type === 'turn/start') {
      const turn = nonNegativeInteger(data.turn);
      if (turn === undefined) throw new Error(`DSH turn/start 缺少 turn：seq=${event.seq}。`);
      openTurns.add(turn);
      terminal.status = 'open';
      events.push({ ...base('turn-start'), eventKind: 'lifecycle', phase: 'turn_started' });
      return;
    }
    if (event.type === 'turn/end') {
      const turn = nonNegativeInteger(data.turn);
      if (turn === undefined) throw new Error(`DSH turn/end 缺少 turn：seq=${event.seq}。`);
      openTurns.delete(turn);
      const projection = turnEndProjection(data.reason);
      terminal.status = projection.status;
      events.push({
        ...base('turn-end'),
        eventKind: 'lifecycle',
        phase: projection.phase,
        reason: projection.reason,
      });
      return;
    }
    if (event.type === 'step/start' || event.type === 'step/end') {
      const turn = nonNegativeInteger(data.turn);
      const step = nonNegativeInteger(data.step);
      if (turn === undefined || step === undefined) {
        throw new Error(`DSH ${event.type} 缺少 turn／step：seq=${event.seq}。`);
      }
      const key = `${turn}:${step}`;
      if (event.type === 'step/start') openSteps.add(key);
      else openSteps.delete(key);
      events.push({
        ...base(event.type === 'step/start' ? 'step-start' : 'step-end'),
        eventKind: 'lifecycle',
        phase: event.type === 'step/start' ? 'step_started' : 'step_completed',
        reason: `step=${step}`,
      });
      return;
    }
    if (event.type === 'user/message') {
      const text = textFromContent(data.content);
      const source = isRecord(data.source) ? data.source : undefined;
      events.push({
        ...base('user-message'),
        ...sourceEventId(data.id),
        eventKind: 'message',
        role: 'user',
        origin: messageOrigin(source),
        text,
        attributionSkill: source?.kind === 'skill-invocation' ? stringValue(source.name) : undefined,
      });
      return;
    }
    if (event.type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : {};
      const source = isRecord(message.source) ? message.source : {};
      const model = stringValue(source.model);
      const provider = stringValue(source.provider);
      observedModel = model ?? observedModel;
      observedProvider = provider ?? observedProvider;
      const text = textFromContent(message.content);
      if (text) {
        events.push({
          ...base('assistant-message'),
          ...sourceEventId(message.id),
          eventKind: 'message',
          role: 'assistant',
          origin: 'synthetic',
          text,
          model,
        });
      }
      reasoningFromContent(message.content).forEach((reasoning, reasoningIndex) => {
        events.push({
          ...base(`reasoning-${reasoningIndex}`),
          ...sourceEventId(message.id),
          eventKind: 'model_activity',
          activityKind: 'reasoning',
          contentVisibility: 'plaintext',
          contentSource: 'content',
          text: reasoning,
          model,
        });
      });
      if (isRecord(data.usage)) {
        const inputTokens = nonNegativeInteger(data.usage.inputTokens);
        const outputTokens = nonNegativeInteger(data.usage.outputTokens);
        if (inputTokens === undefined || outputTokens === undefined) {
          throw new Error(`DSH assistant/message usage 非法：seq=${event.seq}。`);
        }
        events.push({
          ...base('usage'),
          eventKind: 'usage',
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens: nonNegativeInteger(data.usage.cacheReadTokens),
          cacheCreationTokens: nonNegativeInteger(data.usage.cacheWriteTokens),
          reasoningTokens: nonNegativeInteger(data.usage.reasoningTokens),
        });
      }
      return;
    }
    if (event.type === 'assistant/chunk') {
      const turn = nonNegativeInteger(data.turn);
      const step = nonNegativeInteger(data.step);
      const chunk = isRecord(data.chunk) ? data.chunk : {};
      if (turn !== undefined && step !== undefined && assembledSteps.has(`${turn}:${step}`)) {
        ignoredChunkCount += 1;
        return;
      }
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text) {
        events.push({
          ...base('reasoning-delta'),
          eventKind: 'model_activity',
          activityKind: 'reasoning',
          contentVisibility: 'plaintext',
          contentSource: 'text',
          text: chunk.text,
          model: observedModel,
        });
      } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        events.push({
          ...base('text-delta'),
          eventKind: 'message',
          role: 'assistant',
          origin: 'synthetic',
          text: chunk.text,
          model: observedModel,
        });
      } else {
        ignoredChunkCount += 1;
      }
      return;
    }
    if (event.type === 'tool/call') {
      const callId = stringValue(data.callId);
      const name = stringValue(data.name);
      if (!callId || !name) throw new Error(`DSH tool/call 缺少 callId／name：seq=${event.seq}。`);
      pendingTools.add(callId);
      events.push({
        ...base('tool-call'),
        ...sourceEventId(callId),
        eventKind: 'tool_call',
        callId,
        callInstanceId: `${runId}:${callId}`,
        tool: normalizeToolIdentity({ sourceName: name }),
        input: objectInput(data.arguments),
        model: observedModel,
      });
      return;
    }
    if (event.type === 'tool/result') {
      const result = toolResultData(data);
      if (!result.callId) throw new Error(`DSH tool/result 缺少 toolCallId：seq=${event.seq}。`);
      if (!pendingTools.delete(result.callId)) unmatchedToolResultCount += 1;
      events.push({
        ...base('tool-result'),
        ...sourceEventId(result.callId),
        eventKind: 'tool_result',
        callId: result.callId,
        callInstanceId: `${runId}:${result.callId}`,
        output: result.output,
        status: result.failed ? 'failure' : 'success',
        statusSource: 'runtime',
      });
      return;
    }
    if (event.type === 'request/header' || event.type === 'request/context') {
      const facts = requestFacts(data);
      observedModel = facts.model ?? observedModel;
      observedProvider = facts.provider ?? observedProvider;
      events.push({
        ...base('request-context'),
        eventKind: 'runtime_context',
        runtimeKind: 'execution_context',
        runtimeName: 'DeepSeek Harness',
        model: facts.model,
        modelProvider: facts.provider,
        reasoningEffort: facts.reasoningEffort,
        contextWindowId: facts.contextWindowId,
        summary: `${event.type}: ${jsonText(data)}`,
      });
      return;
    }
    if (event.type === 'session/end-seed') {
      events.push({
        ...base('seed-boundary'),
        eventKind: 'runtime_context',
        runtimeKind: 'session_context',
        historyMode: `seed-boundary:${event.seq}`,
        summary: 'DSH session seed boundary',
      });
      return;
    }
    if (event.type.startsWith('compaction/')) {
      events.push(...compactionEvents(runId, event, sourceIndex));
      return;
    }
    if (event.type === 'todo/write' || AUXILIARY_EVENT_TYPES.has(event.type)) {
      events.push(auxiliaryEvent(runId, event, sourceIndex));
      return;
    }
    if (event.ignorable === true) {
      unknownEventCount += 1;
      events.push({
        ...base('unknown'),
        eventKind: 'unknown',
        raw: event,
      });
      return;
    }
    throw new DshTraceUnsupportedEventError(event.type, event.seq);
  });

  const correlated = correlateTraceToolEvents(events);
  const bounds = traceTimestampBounds(correlated.map((event) => event.timestamp));
  const unmatchedToolCallCount = pendingTools.size;
  const openTurnCount = openTurns.size;
  const openStepCount = openSteps.size;
  const complete = unmatchedToolCallCount === 0
    && unmatchedToolResultCount === 0
    && openTurnCount === 0
    && openStepCount === 0
    && terminal.status !== 'open'
    && terminal.status !== 'unknown';
  return {
    session: {
      runId,
      rootRunId,
      ...(isSubagent && header.parentSession ? { parentRunId: header.parentSession } : {}),
      traceId,
      groupPath: options.groupPath ?? `dsh:${rootRunId}`,
      role,
      label: role === 'subagent' ? `DSH subagent ${runId}` : `DSH session ${runId}`,
      sourcePath,
      sourceKind: 'dsh',
      events: correlated,
      cwd: header.cwd,
      entrypoint: 'dsh',
      sourceMetadata: {
        provider: observedProvider,
        model: observedModel,
      },
      ...bounds,
    },
    integrity: {
      complete,
      status: terminal.status,
      unknownEventCount,
      ignoredChunkCount,
      unmatchedToolCallCount,
      unmatchedToolResultCount,
      openTurnCount,
      openStepCount,
    },
  };
}
