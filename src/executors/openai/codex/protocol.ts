import type { ExecResult } from '../../../types/index.js';
import {
  checkedSumTokenCounts,
  optionalTokenCount,
  splitInclusiveInputTokens,
  sumTokenCounts,
} from '../../../shared/token-usage.js';
import { extractCodexTrace, isCodexResultEvent } from './trace.js';

// Codex CLI `codex exec --json` 事件流 schema（基于 codex 0.125 实测）。
// schema 没有官方稳定文档，字段缺失静默 skip 不 throw。未来 schema 漂移时 fixture 测试会先红。
export interface CodexEvent {
  type?: string;
  turn_id?: string;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  elapsed_ms?: number;
  stop_reason?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
    path?: string;
    content?: string;
    query?: string;
    results?: unknown[];
    changes?: Array<{ path?: string; changeKind?: string }>;
    server?: string;
    tool?: string;
    name?: string;
    arguments?: unknown;
    result?: unknown;
    message?: string;
    error?: { message?: string };
  };
  error?: { message?: string };
  message?: string;
  ts?: number;
}

/**
 * Translate Codex's external event shape into omk's internal protocol model.
 * Codex currently calls file-change discriminators `kind`; omk reserves bare
 * `kind` for ArtifactKind, so the raw field is qualified at the boundary.
 */
export function normalizeCodexProtocolEvent(value: unknown): CodexEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const rawItem = event.item;
  if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) {
    return event as unknown as CodexEvent;
  }

  const item = rawItem as Record<string, unknown>;
  const rawChanges = item.changes;
  const normalizedItem = {
    ...item,
    ...(Array.isArray(rawChanges) && {
      changes: rawChanges.flatMap((change) => {
        if (typeof change !== 'object' || change === null || Array.isArray(change)) return [];
        const rawChange = change as Record<string, unknown>;
        return [{
          ...(typeof rawChange.path === 'string' && { path: rawChange.path }),
          ...(typeof rawChange.kind === 'string' && { changeKind: rawChange.kind }),
        }];
      }),
    }),
  };
  return { ...event, item: normalizedItem } as unknown as CodexEvent;
}

const CODEX_EVENT_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

const CODEX_ITEM_TYPES = new Set([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'todo_list',
  'error',
  // Older CLI releases emitted these directly.
  'file_read',
  'file_write',
]);

export function extractCodexUsage(events: CodexEvent[]): { input: number; cached: number; output: number } {
  const input: number[] = [];
  const cached: number[] = [];
  const output: number[] = [];
  for (const event of events) {
    if (!isCodexResultEvent(event) || !event.usage) continue;
    const normalized = splitInclusiveInputTokens(
      event.usage.input_tokens,
      event.usage.cached_input_tokens,
    );
    input.push(normalized.inputTokens);
    cached.push(normalized.cacheReadTokens);
    output.push(event.usage.output_tokens ?? 0);
  }
  return {
    input: sumTokenCounts(...input),
    cached: sumTokenCounts(...cached),
    output: sumTokenCounts(...output),
  };
}

/**
 * Match @openai/codex-sdk's `finalResponse`: the latest completed
 * agent_message is the answer. Earlier messages remain available in `turns`.
 */
export function extractCodexFinalOutput(events: CodexEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      return typeof event.item.text === 'string' ? event.item.text : '';
    }
  }
  return '';
}

export function extractCodexProtocolError(events: CodexEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'error') {
      return event.message || event.error?.message || 'codex stream error';
    }
  }
  return undefined;
}

export function validateCodexProtocol(events: CodexEvent[]): string | undefined {
  const pendingItems = new Map<string, number>();
  let openTurnCount = 0;
  const inputCounts: number[] = [];
  const cacheCounts: number[] = [];
  const outputCounts: number[] = [];
  const elapsedCounts: number[] = [];

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const eventType = event.type;
    if (!eventType || !CODEX_EVENT_TYPES.has(eventType)) {
      return `unsupported codex event type: ${eventType || '<missing>'}`;
    }
    if (event.elapsed_ms !== undefined) {
      const elapsed = optionalTokenCount(event.elapsed_ms);
      if (elapsed === undefined) return `invalid codex elapsed_ms at event ${eventIndex}`;
      elapsedCounts.push(elapsed);
    }

    if (eventType === 'turn.started') {
      openTurnCount += 1;
      continue;
    }

    if (eventType.startsWith('item.')) {
      const itemType = event.item?.type;
      if (!itemType || !CODEX_ITEM_TYPES.has(itemType)) {
        return `unsupported codex item type: ${itemType || '<missing>'}`;
      }
      const itemId = event.item?.id;
      if (typeof itemId !== 'string' || itemId.trim() === '') {
        return `missing codex item id at event ${eventIndex}`;
      }
      if (eventType === 'item.started') {
        pendingItems.set(itemId, (pendingItems.get(itemId) ?? 0) + 1);
      } else if (eventType === 'item.updated' && !pendingItems.has(itemId)) {
        return `codex item.updated without item.started: ${itemId}`;
      } else if (eventType === 'item.completed') {
        const pendingCount = pendingItems.get(itemId) ?? 0;
        if (pendingCount === 1) pendingItems.delete(itemId);
        else if (pendingCount > 1) pendingItems.set(itemId, pendingCount - 1);
      }
      continue;
    }

    if (eventType !== 'turn.completed' && eventType !== 'turn.failed') continue;
    if (pendingItems.size > 0) {
      return `codex turn ended with incomplete item(s): ${Array.from(pendingItems.keys()).join(', ')}`;
    }
    if (openTurnCount > 0) openTurnCount -= 1;

    if (event.usage !== undefined || eventType === 'turn.completed') {
      const usageError = validateCodexUsage(event.usage, eventIndex);
      if (usageError) return usageError;
      const normalized = splitInclusiveInputTokens(
        event.usage?.input_tokens,
        event.usage?.cached_input_tokens,
      );
      inputCounts.push(normalized.inputTokens);
      cacheCounts.push(normalized.cacheReadTokens);
      outputCounts.push(event.usage?.output_tokens ?? 0);
    }
  }

  if (openTurnCount > 0) return 'codex stream ended before turn completion';
  if (pendingItems.size > 0) {
    return `codex stream ended with incomplete item(s): ${Array.from(pendingItems.keys()).join(', ')}`;
  }
  if (
    !hasSafeAggregate(inputCounts)
    || !hasSafeAggregate(cacheCounts)
    || !hasSafeAggregate(outputCounts)
    || !hasSafeAggregate([...inputCounts, ...cacheCounts, ...outputCounts])
  ) {
    return 'codex token usage aggregate exceeds safe integer';
  }
  if (!hasSafeAggregate(elapsedCounts)) {
    return 'codex elapsed_ms aggregate exceeds safe integer';
  }
  return undefined;
}

function validateCodexUsage(
  usage: CodexEvent['usage'] | undefined,
  eventIndex: number,
): string | undefined {
  if (!usage) return `missing codex usage at event ${eventIndex}`;
  const input = optionalTokenCount(usage.input_tokens);
  const output = optionalTokenCount(usage.output_tokens);
  const cached = usage.cached_input_tokens === undefined
    ? 0
    : optionalTokenCount(usage.cached_input_tokens);
  const reasoning = usage.reasoning_output_tokens === undefined
    ? 0
    : optionalTokenCount(usage.reasoning_output_tokens);
  if (input === undefined || output === undefined || cached === undefined || reasoning === undefined) {
    return `invalid codex usage at event ${eventIndex}`;
  }
  if (cached > input) return `codex cached_input_tokens exceeds input_tokens at event ${eventIndex}`;
  return undefined;
}

function hasSafeAggregate(values: number[]): boolean {
  return checkedSumTokenCounts(...values) !== undefined;
}

export function extractCodexStopReason(events: CodexEvent[]): string {
  if (extractCodexProtocolError(events) || validateCodexProtocol(events)) return 'error';
  const last = [...events].reverse().find((event) => isCodexResultEvent(event));
  if (!last) return 'unknown';
  if (last.type === 'turn.failed') return 'error';
  return last.stop_reason || 'end_turn';
}

export function sumCodexElapsed(resultEvents: CodexEvent[], wallClock: number): number {
  const total = sumTokenCounts(...resultEvents.map((event) => event.elapsed_ms ?? 0));
  return total > 0 ? total : wallClock;
}

export interface BuildCodexResultOptions {
  events: CodexEvent[];
  wallClockDurationMs: number;
  source: 'codex --json' | 'codex-sdk';
  malformedLineCount?: number;
  forcedError?: string;
}

export function buildCodexResult({
  events,
  wallClockDurationMs,
  source,
  malformedLineCount = 0,
  forcedError,
}: BuildCodexResultOptions): ExecResult {
  const resultEvents = events.filter(isCodexResultEvent);
  const last = resultEvents.at(-1);
  const usage = extractCodexUsage(events);
  const trace = extractCodexTrace(events);
  const finalOutput = extractCodexFinalOutput(events);
  const errors: string[] = [];

  if (forcedError) errors.push(forcedError);
  if (malformedLineCount > 0) {
    errors.push(`${source} output contained ${malformedLineCount} malformed line(s)`);
  }
  const schemaError = validateCodexProtocol(events);
  if (schemaError) errors.push(schemaError);
  const streamError = extractCodexProtocolError(events);
  if (streamError) errors.push(streamError);
  if (!last) {
    errors.push(`no turn.completed/turn.failed event in ${source} output`);
  } else if (last.type === 'turn.failed' || last.error) {
    errors.push(last.error?.message || `${source} turn.failed`);
  } else if (!finalOutput.trim()) {
    errors.push(`${source} completed without an assistant response`);
  }

  const uniqueErrors = [...new Set(errors)];
  const ok = uniqueErrors.length === 0;
  const tokenUsageReported = !forcedError
    && malformedLineCount === 0
    && !schemaError
    && Boolean(last);
  return {
    ok,
    durationMs: sumCodexElapsed(resultEvents, wallClockDurationMs),
    durationApiMs: 0,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cached,
    cacheCreationTokens: 0,
    ...(!tokenUsageReported && { tokenUsageReportedByExecutor: false }),
    costUSD: 0,
    costReportedByExecutor: false,
    output: finalOutput.trim() ? finalOutput : null,
    stopReason: ok ? extractCodexStopReason(events) : 'error',
    ...(uniqueErrors.length > 0 && { error: uniqueErrors.join('; ') }),
    numTurns: resultEvents.length,
    fullNumTurns: trace.fullNumTurns,
    numSubAgents: trace.numSubAgents,
    ...(trace.turns.length > 0 && { turns: trace.turns }),
    ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
  };
}
