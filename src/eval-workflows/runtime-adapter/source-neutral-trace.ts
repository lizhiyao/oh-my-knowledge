import { z } from 'zod';
import {
  deepFreezeCanonicalJson,
  type JsonValue,
} from '../../evaluation-core/contracts/index.js';
import {
  isValidMockStats,
  isValidToolCallInfo,
  isValidTurnInfo,
} from '../../shared/executor-result.js';

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
