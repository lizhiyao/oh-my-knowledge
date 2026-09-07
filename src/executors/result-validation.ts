import type { ExecResult } from './contracts/result.js';
import type { ToolCallInfo, TurnInfo } from './contracts/trace.js';
import { isJsonValue } from '../shared/json-value.js';
import { normalizeRfc3339Timestamp } from '../shared/timestamp.js';
import { checkedSumTokenCounts, optionalTokenCount } from './core/token-usage.js';
import { normalizeToolIdentity } from './core/tool-identity.js';
import { isTraceSourceKind } from './core/trace-source-kind.js';

const TOOL_STATUSES = new Set(['success', 'failure', 'cancelled', 'unknown']);
const TOOL_STATUS_SOURCES = new Set(['runtime', 'tool-output', 'inferred', 'unknown']);
const TRACE_ROLES = new Set(['standalone', 'main', 'subagent']);
const TURN_ROLES = new Set(['user', 'assistant', 'tool']);

/**
 * Validate the source-neutral executor result contract at process/cache
 * boundaries. Provider payloads and custom executors are untrusted input; a
 * malformed metric must fail the sample instead of entering a report.
 */
export function executorResultValidationError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'executor result must be an object';
  if (typeof value.ok !== 'boolean') return '"ok" must be boolean';
  if (value.output !== null && typeof value.output !== 'string') {
    return '"output" must be string or null';
  }
  if (value.ok && (typeof value.output !== 'string' || value.output.trim() === '')) {
    return 'successful executor result must contain model output';
  }

  for (const field of ['durationMs', 'durationApiMs'] as const) {
    if (!isNonNegativeSafeMetric(value[field])) {
      return `"${field}" must be a non-negative safe number`;
    }
  }
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'numTurns',
  ] as const) {
    if (optionalTokenCount(value[field]) === undefined) {
      return `"${field}" must be a non-negative safe integer`;
    }
  }
  if (
    checkedSumTokenCounts(
      value.inputTokens,
      value.outputTokens,
      value.cacheReadTokens,
      value.cacheCreationTokens,
    ) === undefined
  ) {
    return 'token usage aggregate exceeds safe integer';
  }
  if (!isNonNegativeSafeMetric(value.costUSD)) {
    return '"costUSD" must be a non-negative safe number';
  }
  if (typeof value.stopReason !== 'string') return '"stopReason" must be string';
  if (!isOptionalBoolean(value.costReportedByExecutor)) {
    return '"costReportedByExecutor" must be boolean when present';
  }
  if (!isOptionalBoolean(value.tokenUsageReportedByExecutor)) {
    return '"tokenUsageReportedByExecutor" must be boolean when present';
  }
  if (!isOptionalBoolean(value.cached)) return '"cached" must be boolean when present';
  if (!isOptionalString(value.error)) return '"error" must be string when present';
  if (!isOptionalCount(value.fullNumTurns)) {
    return '"fullNumTurns" must be a non-negative safe integer when present';
  }
  if (!isOptionalCount(value.numSubAgents)) {
    return '"numSubAgents" must be a non-negative safe integer when present';
  }
  if (
    value.attemptCount !== undefined
    && (
      typeof value.attemptCount !== 'number'
      || !Number.isSafeInteger(value.attemptCount)
      || value.attemptCount < 1
    )
  ) {
    return '"attemptCount" must be a positive safe integer when present';
  }

  if (value.turns !== undefined) {
    if (!Array.isArray(value.turns) || !value.turns.every(isValidTurnInfo)) {
      return '"turns" contains an invalid trace entry';
    }
  }
  if (value.toolCalls !== undefined) {
    if (!Array.isArray(value.toolCalls) || !value.toolCalls.every(isValidToolCallInfo)) {
      return '"toolCalls" contains an invalid trace entry';
    }
  }
  if (value.mockStats !== undefined && !isValidMockStats(value.mockStats)) {
    return '"mockStats" contains invalid counters';
  }
  return undefined;
}

/**
 * Canonicalize every execution trace after structural validation. This keeps
 * programmatic/custom executors and restored caches in the same comparison
 * namespace as built-in provider adapters.
 */
export function normalizeExecResultToolIdentities(result: ExecResult): ExecResult {
  const normalizeCall = (call: ToolCallInfo): ToolCallInfo => {
    const sourceName = call.sourceTool ?? call.tool;
    const isMcpIdentity = sourceName.startsWith('mcp__')
      || sourceName === 'mcp_tool_call'
      || call.toolNamespace?.startsWith('mcp__');
    const identity = normalizeToolIdentity({
      sourceName,
      namespace: call.toolNamespace,
      provider: call.toolProvider,
      authoritativeName: isMcpIdentity && call.tool !== sourceName
        ? call.tool
        : undefined,
    });
    const normalizedCall: ToolCallInfo = {
      ...call,
      tool: identity.name,
    };
    if (identity.sourceName) normalizedCall.sourceTool = identity.sourceName;
    else delete normalizedCall.sourceTool;
    if (identity.namespace) normalizedCall.toolNamespace = identity.namespace;
    else delete normalizedCall.toolNamespace;
    if (identity.provider) normalizedCall.toolProvider = identity.provider;
    else delete normalizedCall.toolProvider;
    return normalizedCall;
  };
  return {
    ...result,
    ...(result.toolCalls && {
      toolCalls: result.toolCalls.map(normalizeCall),
    }),
    ...(result.turns && {
      turns: result.turns.map((turn) => ({
        ...turn,
        ...(turn.toolCalls && {
          toolCalls: turn.toolCalls.map(normalizeCall),
        }),
      })),
    }),
  };
}

export function isValidTurnInfo(value: unknown): value is TurnInfo {
  return isRecord(value)
    && typeof value.role === 'string'
    && TURN_ROLES.has(value.role)
    && typeof value.content === 'string'
    && (
      value.toolCalls === undefined
      || (Array.isArray(value.toolCalls) && value.toolCalls.every(isValidToolCallInfo))
    )
    && (
      value.durationMs === undefined
      || isNonNegativeSafeMetric(value.durationMs)
    );
}

export function isValidToolCallInfo(value: unknown): value is ToolCallInfo {
  if (
    !isRecord(value)
    || typeof value.tool !== 'string'
    || value.tool.trim() === ''
    || !isJsonValue(value.input)
    || !isJsonValue(value.output)
    || typeof value.success !== 'boolean'
    || !isOptionalCount(value.messageIndex)
  ) return false;
  if (
    value.status !== undefined
    && (
      typeof value.status !== 'string'
      || !TOOL_STATUSES.has(value.status)
      || value.success !== (value.status === 'success')
    )
  ) return false;
  if (
    value.statusSource !== undefined
    && (
      typeof value.statusSource !== 'string'
      || !TOOL_STATUS_SOURCES.has(value.statusSource)
    )
  ) return false;
  if (
    value.sourceKind !== undefined
    && !isTraceSourceKind(value.sourceKind)
  ) return false;
  if (
    value.traceRole !== undefined
    && (
      typeof value.traceRole !== 'string'
      || !TRACE_ROLES.has(value.traceRole)
    )
  ) return false;
  if (
    value.timestamp !== undefined
    && normalizeRfc3339Timestamp(value.timestamp) === undefined
  ) return false;
  return [
    value.sourceTool,
    value.toolNamespace,
    value.toolProvider,
    value.messageUuid,
    value.callInstanceId,
    value.toolUseId,
    value.sourceTrace,
    value.traceLabel,
  ].every(isOptionalString);
}

export function isValidMockStats(value: unknown): boolean {
  if (
    !isRecord(value)
    || optionalTokenCount(value.hits) === undefined
    || optionalTokenCount(value.misses) === undefined
    || !isRecord(value.perMock)
  ) return false;
  const perMock = Object.values(value.perMock);
  if (perMock.some((count) => optionalTokenCount(count) === undefined)) return false;
  return checkedSumTokenCounts(...perMock) === value.hits;
}

function isNonNegativeSafeMetric(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || optionalTokenCount(value) !== undefined;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
