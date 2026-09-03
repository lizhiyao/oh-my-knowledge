import { z } from 'zod';
import {
  deepFreezeCanonicalJson,
  type JsonValue,
} from '../../eval-core/contracts/index.js';
import type { ToolCallInfo, TurnInfo } from '../../executors/contracts/trace.js';

const TOOL_STATUSES = new Set(['success', 'failure', 'cancelled', 'unknown']);
const TOOL_STATUS_SOURCES = new Set(['runtime', 'tool-output', 'inferred', 'unknown']);
const TRACE_ROLES = new Set(['standalone', 'main', 'subagent']);
const TRACE_SOURCES = new Set(['claude', 'codex', 'dsh', 'openclaw', 'markdown_log', 'unknown']);
const TURN_ROLES = new Set(['user', 'assistant', 'tool']);
const RFC3339_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isJsonValue(
  value: unknown,
  seen: Set<object> = new Set(),
  depth = 0,
): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= 32 || seen.has(value)) return false;
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length
          || value.some((_, index) => !Object.hasOwn(value, index))) return false;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((entry) => isJsonValue(entry, seen, depth + 1))
      : Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
    seen.delete(value);
    return valid;
  } catch {
    seen.delete(value);
    return false;
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isAbsoluteRfc3339Timestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const candidate = value.trim();
  const match = RFC3339_TIMESTAMP_RE.exec(candidate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
      || hour > 23 || minute > 59 || second > 60) return false;
  const offset = match[8].toUpperCase();
  if (offset === '-00:00') return false;
  if (offset !== 'Z'
      && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59)) return false;
  const parseable = second === 60
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:59${match[7] ? `.${match[7]}` : ''}${offset}`
    : candidate;
  const parsed = Date.parse(parseable);
  if (!Number.isFinite(parsed)) return false;
  if (second !== 60) return true;
  const beforeLeap = new Date(parsed);
  return beforeLeap.getUTCHours() === 23
    && beforeLeap.getUTCMinutes() === 59
    && beforeLeap.getUTCSeconds() === 59
    && beforeLeap.getUTCDate()
      === daysInMonth(beforeLeap.getUTCFullYear(), beforeLeap.getUTCMonth() + 1);
}

function isValidToolCallInfo(value: unknown): value is ToolCallInfo {
  if (!isRecord(value)
      || typeof value.tool !== 'string'
      || value.tool.trim() === ''
      || !isJsonValue(value.input)
      || !isJsonValue(value.output)
      || typeof value.success !== 'boolean'
      || (value.messageIndex !== undefined && !isCount(value.messageIndex))) return false;
  if (value.status !== undefined
      && (typeof value.status !== 'string'
        || !TOOL_STATUSES.has(value.status)
        || value.success !== (value.status === 'success'))) return false;
  if (value.statusSource !== undefined
      && (typeof value.statusSource !== 'string'
        || !TOOL_STATUS_SOURCES.has(value.statusSource))) return false;
  if (value.sourceKind !== undefined
      && (typeof value.sourceKind !== 'string' || !TRACE_SOURCES.has(value.sourceKind))) return false;
  if (value.traceRole !== undefined
      && (typeof value.traceRole !== 'string' || !TRACE_ROLES.has(value.traceRole))) return false;
  if (value.timestamp !== undefined && !isAbsoluteRfc3339Timestamp(value.timestamp)) return false;
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

function isValidTurnInfo(value: unknown): value is TurnInfo {
  return isRecord(value)
    && typeof value.role === 'string'
    && TURN_ROLES.has(value.role)
    && typeof value.content === 'string'
    && (value.toolCalls === undefined
      || (Array.isArray(value.toolCalls) && value.toolCalls.every(isValidToolCallInfo)))
    && (value.durationMs === undefined
      || (typeof value.durationMs === 'number'
        && Number.isFinite(value.durationMs)
        && value.durationMs >= 0
        && value.durationMs <= Number.MAX_SAFE_INTEGER));
}

function isValidMockStats(value: unknown): boolean {
  if (!isRecord(value) || !isCount(value.hits) || !isCount(value.misses) || !isRecord(value.perMock)) {
    return false;
  }
  let total = 0;
  for (const count of Object.values(value.perMock)) {
    if (!isCount(count) || total > Number.MAX_SAFE_INTEGER - count) return false;
    total += count;
  }
  return total === value.hits;
}

export const SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION =
  'omk.source-neutral-trace/v2' as const;

export const SourceNeutralMockStatsSchema = z.custom<{
  readonly hits: number;
  readonly misses: number;
  readonly perMock: Readonly<Record<string, number>>;
}>((value) => (
  isValidMockStats(value)
  && value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && 'perMock' in value
  && value.perMock !== null
  && typeof value.perMock === 'object'
  && !Array.isArray(value.perMock)
  && Object.keys(value.perMock).every((key) => /^.+:[1-9]\d*$/.test(key))
));

/**
 * Canonical trace projection consumed by source-neutral evaluators.
 * `numTurns` is the provider/runtime measurement used by turn assertions;
 * `fullNumTurns` is diagnostic transcript breadth and must never substitute it.
 */
export const SourceNeutralTraceSchema = z.object({
  schemaVersion: z.literal(SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION),
  turns: z.array(z.custom<JsonValue>(isValidTurnInfo)),
  toolCalls: z.array(z.custom<JsonValue>(isValidToolCallInfo)),
  numTurns: z.number().int().nonnegative(),
  fullNumTurns: z.number().int().nonnegative(),
  numSubAgents: z.number().int().nonnegative(),
  mockStats: SourceNeutralMockStatsSchema.optional(),
}).strict();

export type SourceNeutralTrace = z.infer<typeof SourceNeutralTraceSchema>;
export type SourceNeutralMockStats = z.infer<typeof SourceNeutralMockStatsSchema>;

export const SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR: JsonValue =
  deepFreezeCanonicalJson({
    schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
    fields: [
      'fullNumTurns',
      'mockStats',
      'numSubAgents',
      'numTurns',
      'schemaVersion',
      'toolCalls',
      'turns',
    ],
    requiredFields: [
      'fullNumTurns',
      'numSubAgents',
      'numTurns',
      'schemaVersion',
      'toolCalls',
      'turns',
    ],
    turnAndToolCallItems: 'source-neutral-executor-trace/v1',
    numTurnsSemantics: 'provider-or-runtime-reported-root-turn-count',
    fullNumTurnsSemantics: 'diagnostic-source-normalized-conversation-breadth',
    mockStatsSemantics: 'present-only-when-mock-interception-is-configured',
  });

export const SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR: JsonValue =
  deepFreezeCanonicalJson({
    base: SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
    constraints: { mockStats: 'forbidden' },
  });

export const SourceNeutralTraceWithoutMocksSchema = SourceNeutralTraceSchema.refine(
  (trace) => trace.mockStats === undefined,
  { message: 'mockStats is forbidden when the Executor cannot intercept mocks.' },
);

export function parseSourceNeutralTrace(value: unknown): SourceNeutralTrace {
  return SourceNeutralTraceSchema.parse(value);
}

export function attachSourceNeutralMockStats(
  trace: JsonValue,
  mockStats: SourceNeutralMockStats | undefined,
): JsonValue {
  const parsed = SourceNeutralTraceSchema.parse(trace);
  return SourceNeutralTraceSchema.parse({
    ...parsed,
    ...(mockStats === undefined ? {} : { mockStats: structuredClone(mockStats) }),
  }) as JsonValue;
}
