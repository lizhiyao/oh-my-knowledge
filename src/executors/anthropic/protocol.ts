import type { ExecResult } from '../../types/index.js';
import {
  checkedSumTokenCounts,
  nonNegativeMetric,
  optionalTokenCount,
} from '../../shared/token-usage.js';
import { extractAgentTrace, isClaudeSdkResultMessage } from './sdk-trace.js';

interface ClaudeTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeSdkQueryOptions {
  model?: string;
  systemPrompt?: string;
  cwd: string;
  permissionMode: 'bypassPermissions';
  allowDangerouslySkipPermissions: true;
  abortController: AbortController;
  env: NodeJS.ProcessEnv;
}

export interface ClaudeSdkQueryInput {
  prompt: string;
  options: ClaudeSdkQueryOptions;
}

export interface ClaudeSdkBaseMessage {
  type: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ClaudeSdkResultMessage extends ClaudeSdkBaseMessage {
  type: 'result';
  result?: string;
  usage?: ClaudeTokenUsage;
  total_cost_usd?: number;
  duration_api_ms?: number;
  duration_ms?: number;
  num_turns?: number;
  stop_reason?: string | null;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
  subtype?: string;
  errors?: string[];
}

export interface ClaudeSdkModule {
  query: (opts: ClaudeSdkQueryInput) => AsyncIterable<ClaudeSdkBaseMessage>;
}

export interface ClaudeSdkMeasurements {
  durationMs: number;
  durationApiMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  numTurns: number;
}

export function normalizeClaudeSdkMeasurements(
  result: ClaudeSdkResultMessage,
): ClaudeSdkMeasurements | { error: string } {
  const durationMs = optionalTokenCount(result.duration_ms);
  const durationApiMs = optionalTokenCount(result.duration_api_ms);
  const numTurns = optionalTokenCount(result.num_turns);
  const costUSD = nonNegativeMetric(result.total_cost_usd);
  if (
    durationMs === undefined
    || durationApiMs === undefined
    || numTurns === undefined
    || costUSD === undefined
    || costUSD > Number.MAX_SAFE_INTEGER
  ) {
    return { error: 'claude result contained invalid duration, turn, or cost metrics' };
  }

  const rawModelUsage = result.modelUsage;
  const modelUsageEntries = rawModelUsage
    && typeof rawModelUsage === 'object'
    && !Array.isArray(rawModelUsage)
    ? Object.values(rawModelUsage)
    : [];
  const buckets: [number[], number[], number[], number[]] = [[], [], [], []];
  if (modelUsageEntries.length > 0) {
    for (const entry of modelUsageEntries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return { error: 'claude result contained invalid modelUsage' };
      }
      const counts = [
        optionalTokenCount(entry.inputTokens),
        optionalTokenCount(entry.outputTokens),
        optionalTokenCount(entry.cacheReadInputTokens),
        optionalTokenCount(entry.cacheCreationInputTokens),
      ];
      if (counts.some((count) => count === undefined)) {
        return { error: 'claude result contained invalid modelUsage token counters' };
      }
      buckets.forEach((bucket, index) => bucket.push(counts[index]!));
    }
  } else {
    const usage = result.usage;
    const counts = [
      optionalTokenCount(usage?.input_tokens),
      optionalTokenCount(usage?.output_tokens),
      usage?.cache_read_input_tokens === undefined
        ? 0
        : optionalTokenCount(usage.cache_read_input_tokens),
      usage?.cache_creation_input_tokens === undefined
        ? 0
        : optionalTokenCount(usage.cache_creation_input_tokens),
    ];
    if (counts.some((count) => count === undefined)) {
      return { error: 'claude result contained missing or invalid token usage' };
    }
    buckets.forEach((bucket, index) => bucket.push(counts[index]!));
  }

  const totals = buckets.map((bucket) => checkedSumTokenCounts(...bucket));
  if (
    totals.some((total) => total === undefined)
    || checkedSumTokenCounts(...(totals as number[])) === undefined
  ) {
    return { error: 'claude token usage aggregate exceeds safe integer' };
  }
  return {
    durationMs,
    durationApiMs,
    inputTokens: totals[0]!,
    outputTokens: totals[1]!,
    cacheReadTokens: totals[2]!,
    cacheCreationTokens: totals[3]!,
    costUSD,
    numTurns,
  };
}

export interface ClaudeStreamParseResult {
  messages: ClaudeSdkBaseMessage[];
  malformedLineCount: number;
}

export function parseClaudeStreamJson(stdout: string): ClaudeStreamParseResult {
  const messages: ClaudeSdkBaseMessage[] = [];
  let malformedLineCount = 0;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (
        !value
        || typeof value !== 'object'
        || Array.isArray(value)
        || typeof (value as { type?: unknown }).type !== 'string'
      ) {
        malformedLineCount += 1;
      } else {
        messages.push(value as ClaudeSdkBaseMessage);
      }
    } catch {
      malformedLineCount += 1;
    }
  }
  return { messages, malformedLineCount };
}

export function buildClaudeResult(options: {
  messages: ClaudeSdkBaseMessage[];
  wallClockDurationMs: number;
  source: 'claude stream-json' | 'claude-sdk';
  malformedLineCount?: number;
  forcedError?: string;
  messageTimestamps?: number[];
}): ExecResult {
  const {
    messages,
    wallClockDurationMs,
    source,
    malformedLineCount = 0,
    forcedError,
    messageTimestamps,
  } = options;
  const resultMessages = messages.filter(isClaudeSdkResultMessage) as ClaudeSdkResultMessage[];
  const trace = extractAgentTrace(messages, messageTimestamps);
  const traceFields = {
    fullNumTurns: trace.fullNumTurns,
    numSubAgents: trace.numSubAgents,
    ...(trace.turns.length > 0 && { turns: trace.turns }),
    ...(trace.toolCalls.length > 0 && { toolCalls: trace.toolCalls }),
  };
  const errors: string[] = [];
  if (forcedError) errors.push(forcedError);
  if (malformedLineCount > 0) {
    errors.push(`${source} output contained ${malformedLineCount} malformed line(s)`);
  }
  if (resultMessages.length !== 1) {
    errors.push(
      resultMessages.length === 0
        ? `no result message in ${source} output`
        : `expected exactly one result message in ${source} output, received ${resultMessages.length}`,
    );
    return {
      ok: false,
      error: [...new Set(errors)].join('; '),
      durationMs: wallClockDurationMs,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenUsageReportedByExecutor: false,
      costUSD: 0,
      costReportedByExecutor: false,
      output: null,
      stopReason: 'error',
      numTurns: 0,
      ...traceFields,
    };
  }

  const result = resultMessages[0];
  const measurements = normalizeClaudeSdkMeasurements(result);
  if ('error' in measurements) {
    errors.push(measurements.error);
    return {
      ok: false,
      error: [...new Set(errors)].join('; '),
      durationMs: wallClockDurationMs,
      durationApiMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      tokenUsageReportedByExecutor: false,
      costUSD: 0,
      costReportedByExecutor: false,
      output: typeof result.result === 'string' && result.result ? result.result : null,
      stopReason: 'error',
      numTurns: 0,
      ...traceFields,
    };
  }

  if (result.subtype !== 'success') {
    errors.push(result.errors?.filter(Boolean).join('; ') || result.subtype || `${source} failed`);
  } else if (result.errors?.length) {
    errors.push(result.errors.filter(Boolean).join('; '));
  }
  const output = typeof result.result === 'string' && result.result.trim()
    ? result.result
    : null;
  if (!output) errors.push(`${source} completed without an assistant response`);
  const uniqueErrors = [...new Set(errors.filter(Boolean))];
  return {
    ok: uniqueErrors.length === 0,
    ...(uniqueErrors.length > 0 && { error: uniqueErrors.join('; ') }),
    ...measurements,
    ...((forcedError || malformedLineCount > 0) && {
      tokenUsageReportedByExecutor: false,
    }),
    output,
    stopReason: uniqueErrors.length === 0 ? result.stop_reason || 'end_turn' : 'error',
    ...traceFields,
  };
}
