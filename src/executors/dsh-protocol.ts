import type { ExecResult, ToolCallInfo, TurnInfo } from '../types/index.js';
import { checkedSumTokenCounts, optionalTokenCount } from '../shared/token-usage.js';
import { normalizeToolIdentity } from '../shared/tool-identity.js';
import { safeSliceForJson } from '../util/safe-slice.js';

type UnknownRecord = Record<string, unknown>;

/** The stable portion of the SDK result consumed by the adapter. Keeping this
 * structural prevents DSH's type-only ecosystem peers from leaking through
 * OMK's public declarations; the runtime boundary is still the official SDK. */
export interface DshRunResult {
  sessionId: string;
  finalResponse: string;
  events: UnknownRecord[];
  /** Trace origin used to distinguish SDK subprocesses from in-process hosts. */
  sourceTracePrefix?: 'dsh-sdk' | 'dsh-host';
  notifications: Array<{
    method: string;
    params: UnknownRecord;
  }>;
}

interface DshEventRecord {
  sessionId: string;
  event: UnknownRecord;
  traceRole: 'main' | 'subagent';
}

interface MutableToolCall {
  info: ToolCallInfo;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function eventTimestamp(event: UnknownRecord): string | undefined {
  const time = finiteInteger(event.time);
  if (time === undefined) return undefined;
  try {
    return new Date(time).toISOString();
  } catch {
    return undefined;
  }
}

function contentBlocks(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textFromBlocks(value: unknown): string {
  return contentBlocks(value)
    .flatMap((block) => block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : [])
    .join('');
}

function serializableToolInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function boundedToolOutput(value: unknown): unknown {
  if (typeof value === 'string') return safeSliceForJson(value, 50_000);
  return value ?? null;
}

function resultBlock(data: UnknownRecord): UnknownRecord | undefined {
  const message = isRecord(data.message) ? data.message : undefined;
  return contentBlocks(message?.content).find((block) => block.type === 'tool-result');
}

function childSessionIds(result: DshRunResult): Set<string> {
  const ids = new Set<string>();
  for (const notification of result.notifications) {
    if (notification.method !== 'subagent.started') continue;
    const child = nonEmptyString(notification.params.childSessionId);
    if (child) ids.add(child);
  }
  return ids;
}

function collectEvents(result: DshRunResult): DshEventRecord[] {
  const records: DshEventRecord[] = result.events.map((event) => ({
    sessionId: result.sessionId,
    event,
    traceRole: 'main',
  }));
  for (const notification of result.notifications) {
    if (notification.method !== 'session.event') continue;
    const sessionId = nonEmptyString(notification.params.sessionId);
    if (!sessionId || sessionId === result.sessionId || !isRecord(notification.params.event)) continue;
    records.push({
      sessionId,
      event: notification.params.event,
      traceRole: 'subagent',
    });
  }
  return records;
}

function terminalReason(events: DshEventRecord[], rootSessionId: string): {
  stopReason: string;
  error?: string;
} {
  const terminal = [...events].reverse().find(({ sessionId, event }) => (
    sessionId === rootSessionId && event.type === 'turn/end'
  ));
  if (!terminal || !isRecord(terminal.event.data)) {
    return { stopReason: 'unknown', error: 'dsh runtime reached idle without a root turn/end event' };
  }
  const reason = isRecord(terminal.event.data.reason) ? terminal.event.data.reason : undefined;
  const stopReason = nonEmptyString(reason?.kind) ?? 'unknown';
  if (stopReason === 'error') {
    const failure = isRecord(reason?.error) ? reason.error : undefined;
    return {
      stopReason,
      error: nonEmptyString(failure?.message) ?? 'dsh turn failed',
    };
  }
  if (['aborted', 'blocked', 'interrupted'].includes(stopReason)) {
    return { stopReason, error: `dsh turn ended with ${stopReason}` };
  }
  return { stopReason };
}

/**
 * Map DSH's append-only session log into OMK's source-neutral executor result.
 * Root and descendant token/tool evidence are included; final output remains
 * the root session's last assistant text, matching the SDK-owned run interval.
 */
export function buildDshResult(result: DshRunResult, wallClockDurationMs: number): ExecResult {
  const events = collectEvents(result);
  const sourceTracePrefix = result.sourceTracePrefix ?? 'dsh-sdk';
  const tools = new Map<string, MutableToolCall>();
  const orderedTools: MutableToolCall[] = [];
  const turns: TurnInfo[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let usageReported = true;
  let assistantMessages = 0;
  let rootTurns = 0;

  for (const record of events) {
    const { event, sessionId, traceRole } = record;
    const data = isRecord(event.data) ? event.data : {};
    const eventType = nonEmptyString(event.type);

    if (eventType === 'turn/end' && sessionId === result.sessionId) rootTurns += 1;

    if (eventType === 'assistant/message') {
      assistantMessages += 1;
      const message = isRecord(data.message) ? data.message : {};
      const text = textFromBlocks(message.content);
      const usage = isRecord(data.usage) ? data.usage : undefined;
      const nextInput = optionalTokenCount(usage?.inputTokens);
      const nextOutput = optionalTokenCount(usage?.outputTokens);
      const nextCacheRead = usage?.cacheReadTokens === undefined
        ? 0
        : optionalTokenCount(usage.cacheReadTokens);
      const nextCacheWrite = usage?.cacheWriteTokens === undefined
        ? 0
        : optionalTokenCount(usage.cacheWriteTokens);
      const sums = usage && nextInput !== undefined && nextOutput !== undefined
        && nextCacheRead !== undefined && nextCacheWrite !== undefined
        ? {
          input: checkedSumTokenCounts(inputTokens, nextInput),
          output: checkedSumTokenCounts(outputTokens, nextOutput),
          cacheRead: checkedSumTokenCounts(cacheReadTokens, nextCacheRead),
          cacheWrite: checkedSumTokenCounts(cacheCreationTokens, nextCacheWrite),
        }
        : undefined;
      if (!sums || Object.values(sums).some((value) => value === undefined)) {
        usageReported = false;
      } else {
        inputTokens = sums.input ?? inputTokens;
        outputTokens = sums.output ?? outputTokens;
        cacheReadTokens = sums.cacheRead ?? cacheReadTokens;
        cacheCreationTokens = sums.cacheWrite ?? cacheCreationTokens;
      }
      turns.push({
        role: 'assistant',
        content: text,
      });
      continue;
    }

    if (eventType === 'user/message') {
      const message = isRecord(data.message) ? data.message : data;
      turns.push({ role: 'user', content: textFromBlocks(message.content) });
      continue;
    }

    if (eventType === 'tool/call') {
      const callId = nonEmptyString(data.callId);
      const sourceName = nonEmptyString(data.name);
      if (!callId || !sourceName) continue;
      const identity = normalizeToolIdentity({ sourceName });
      const timestamp = eventTimestamp(event);
      const info: ToolCallInfo = {
        tool: identity.name,
        ...(identity.sourceName && { sourceTool: identity.sourceName }),
        ...(identity.namespace && { toolNamespace: identity.namespace }),
        ...(identity.provider && { toolProvider: identity.provider }),
        input: serializableToolInput(data.arguments),
        output: null,
        status: 'unknown',
        statusSource: 'unknown',
        success: false,
        callInstanceId: `${sessionId}:${callId}`,
        toolUseId: callId,
        ...(timestamp && { timestamp }),
        sourceTrace: `${sourceTracePrefix}:${sessionId}`,
        traceRole,
      };
      const mutable = { info };
      tools.set(`${sessionId}\0${callId}`, mutable);
      orderedTools.push(mutable);
      continue;
    }

    if (eventType === 'tool/result') {
      const block = resultBlock(data);
      const callId = nonEmptyString(block?.toolCallId);
      if (!callId) continue;
      const tool = tools.get(`${sessionId}\0${callId}`);
      if (!tool) continue;
      const failed = Boolean(data.error) || block?.isError === true;
      const resultContent = contentBlocks(block?.content);
      const textOutput = textFromBlocks(resultContent);
      tool.info.output = boundedToolOutput(textOutput || resultContent);
      tool.info.status = failed ? 'failure' : 'success';
      tool.info.statusSource = 'runtime';
      tool.info.success = !failed;
    }
  }

  for (const mutable of orderedTools) {
    turns.push({
      role: 'tool',
      content: typeof mutable.info.output === 'string'
        ? mutable.info.output
        : JSON.stringify(mutable.info.output),
      toolCalls: [mutable.info],
    });
  }

  const terminal = terminalReason(events, result.sessionId);
  const output = result.finalResponse || null;
  const successfulStop = terminal.stopReason === 'completed' || terminal.stopReason === 'max-tokens';
  const error = terminal.error ?? (!output ? 'dsh runtime produced no root assistant output' : undefined);

  return {
    ok: successfulStop && Boolean(output) && !error,
    output,
    durationMs: wallClockDurationMs,
    durationApiMs: wallClockDurationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    tokenUsageReportedByExecutor: usageReported && assistantMessages > 0,
    costUSD: 0,
    costReportedByExecutor: false,
    stopReason: terminal.stopReason,
    numTurns: rootTurns,
    fullNumTurns: assistantMessages,
    numSubAgents: childSessionIds(result).size,
    ...(error && { error }),
    turns,
    toolCalls: orderedTools.map(({ info }) => info),
  };
}
