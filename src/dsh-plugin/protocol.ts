import type { ExecResult, ToolCallInfo, TurnInfo } from '../types/index.js';
import { checkedSumTokenCounts, optionalTokenCount } from '../shared/token-usage.js';
import { normalizeToolIdentity } from '../shared/tool-identity.js';
import { safeSliceForJson } from '../util/safe-slice.js';

type UnknownRecord = Record<string, unknown>;

/** Host-owned DSH events consumed by OMK without importing DSH runtime types. */
export interface DshHostRunResult {
  rootSessionId: string;
  finalResponse: string;
  /** Root and descendant events in host-observed receive order. */
  events: Array<{
    sessionId: string;
    event: UnknownRecord;
    traceRole: 'main' | 'subagent';
  }>;
  childSessionIds: string[];
}

interface DshEventRecord {
  sessionId: string;
  event: UnknownRecord;
  traceRole: 'main' | 'subagent';
}

interface MutableToolCall {
  info: ToolCallInfo;
  turn: TurnInfo;
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
  if (typeof value === 'string') return value;
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

function collectEvents(result: DshHostRunResult): DshEventRecord[] {
  return result.events.map(({ sessionId, event, traceRole }) => ({
    sessionId,
    event,
    traceRole,
  }));
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
  if (stopReason === 'max-tokens') {
    return { stopReason, error: 'dsh turn ended after reaching the output-token limit' };
  }
  return { stopReason };
}

/**
 * Map DSH's append-only session log into OMK's source-neutral executor result.
 * Root and descendant token/tool evidence are included; final output remains
 * the root session's last assistant text.
 */
export function buildDshHostResult(result: DshHostRunResult, wallClockDurationMs: number): ExecResult {
  const events = collectEvents(result);
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

    if (eventType === 'turn/end' && sessionId === result.rootSessionId) rootTurns += 1;

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
        sourceTrace: `dsh-host:${sessionId}`,
        traceRole,
      };
      const turn: TurnInfo = {
        role: 'tool',
        content: 'null',
        toolCalls: [info],
      };
      const mutable = { info, turn };
      tools.set(`${sessionId}\0${callId}`, mutable);
      orderedTools.push(mutable);
      turns.push(turn);
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
      tool.turn.content = typeof tool.info.output === 'string'
        ? tool.info.output
        : JSON.stringify(tool.info.output);
    }
  }

  const terminal = terminalReason(events, result.rootSessionId);
  const output = result.finalResponse || null;
  const successfulStop = terminal.stopReason === 'completed';
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
    numSubAgents: new Set(result.childSessionIds).size,
    ...(error && { error }),
    turns,
    toolCalls: orderedTools.map(({ info }) => info),
  };
}
