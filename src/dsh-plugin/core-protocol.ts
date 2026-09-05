import { z } from 'zod';
import {
  EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
  ExecutorCapabilitiesSchema,
  JsonValueSchema,
  UsageRecordSchema,
  deepFreezeCanonicalJson,
  digestCanonicalJson,
  type CoreSchemaValidator,
  type ExecutorCapabilities,
  type JsonValue,
  type SchemaIdentity,
  type UsageRecord,
} from '../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../eval-core/execution/index.js';
import {
  SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR,
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceWithoutMocksSchema,
} from '../eval-runtime/traces/source-neutral.js';
import { buildDshHostResult, type DshHostRunResult } from './protocol.js';
import { supportsDshTraceEventType } from './trace-adapter.js';

export const DSH_HOST_CORE_ADAPTER_IMPLEMENTATION_VERSION = '2.0.0' as const;

export interface ParsedDshHostCoreResult {
  readonly output?: string;
  readonly trace: JsonValue;
  readonly usage: UsageRecord;
  readonly terminalStatus: 'completed' | 'failed';
  readonly stopReason: string;
}

const SCHEMA_DESCRIPTORS = {
  input: { valueKind: 'json-value' },
  output: { valueKind: 'string' },
  trace: SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR,
} as const satisfies Readonly<Record<'input' | 'output' | 'trace', JsonValue>>;

function schemaIdentity(name: 'input' | 'output' | 'trace'): SchemaIdentity {
  const contractVersion = name === 'trace' ? 'v2' : 'v1';
  const schemaVersion = `omk.dsh-host-${name}/${contractVersion}`;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:dsh-host:${name}:${contractVersion}`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      sourceProtocol: 'DeepSeek Harness host session events',
      contract: SCHEMA_DESCRIPTORS[name],
    }),
  };
}

export function createDshHostCoreSchemaValidators(): readonly CoreSchemaValidator[] {
  return Object.freeze([
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity('input')),
      parse(value: unknown): JsonValue {
        return JsonValueSchema.parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity('output')),
      parse(value: unknown): JsonValue {
        return z.string().parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity('trace')),
      parse(value: unknown): JsonValue {
        return SourceNeutralTraceWithoutMocksSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function dshHostCoreExecutorCapabilities(): ExecutorCapabilities {
  return deepFreezeCanonicalJson(ExecutorCapabilitiesSchema.parse({
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: schemaIdentity('input'),
      outputSchema: schemaIdentity('output'),
      traceSchema: schemaIdentity('trace'),
      execution: {
        concurrency: { safety: 'serialized', maxInFlight: 1 },
        cancellation: 'best-effort',
        state: { resourceLifecycle: 'per-invocation', trialState: 'stateless' },
        seedControl: 'unsupported',
        determinism: 'stochastic',
        features: {
          systemInstructions: 'native',
          workspace: ['copy-on-write-overlay'],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['allow-list', 'runtime-default'],
          skillDiscovery: ['disabled', 'runtime-default'],
          sandboxIds: [],
        },
        telemetry: {
          trace: 'required',
          usage: 'optional',
          providerCost: { reporting: 'unsupported' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function checkedSum(values: readonly number[]): number | undefined {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) return undefined;
  }
  return sum;
}

function fail(message: string, usage?: UsageRecord): never {
  throw new ExecutionPortFailure({
    code: 'OMK_DSH_HOST_PROTOCOL_INVALID',
    stage: 'execution',
    message,
  }, usage);
}

function validateEvents(result: DshHostRunResult): void {
  const childSessionIds = new Set(result.childSessionIds);
  if (
    childSessionIds.size !== result.childSessionIds.length
    || childSessionIds.has(result.rootSessionId)
    || [...childSessionIds].some((sessionId) => sessionId.trim() === '')
  ) fail('DSH Host returned invalid session lineage.');
  const expectedSequenceBySession = new Map<string, number>();
  for (const record of result.events) {
    const captured = JsonValueSchema.safeParse(record.event);
    const expectedRole = record.sessionId === result.rootSessionId ? 'main' : 'subagent';
    const sequence = tokenCount(record.event.seq);
    const eventTime = tokenCount(record.event.time);
    const expectedSequence = expectedSequenceBySession.get(record.sessionId) ?? 0;
    if (
      !captured.success
      || record.sessionId.trim() === ''
      || record.traceRole !== expectedRole
      || (expectedRole === 'subagent' && !childSessionIds.has(record.sessionId))
      || typeof record.event.type !== 'string'
      || record.event.type === ''
      || sequence !== expectedSequence
      || eventTime === undefined
    ) {
      fail('DSH Host returned an invalid session event.');
    }
    expectedSequenceBySession.set(record.sessionId, expectedSequence + 1);
    if (
      record.event.ignorable !== true
      && !supportsDshTraceEventType(record.event.type)
    ) fail('DSH Host returned an unsupported required session event.');
  }
}

function usageFromEvents(
  result: DshHostRunResult,
  model: string,
  provider: string | undefined,
  stopReason: string,
): UsageRecord {
  let assistantMessages = 0;
  let completeUsage = true;
  let completeReasoningUsage = true;
  let uncachedInputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let outputTokens = 0;
  let reasoningOutputTokens = 0;
  for (const record of result.events) {
    if (record.event.type !== 'assistant/message') continue;
    assistantMessages += 1;
    const data = isRecord(record.event.data) ? record.event.data : undefined;
    const rawUsage = data?.usage;
    if (rawUsage === undefined || rawUsage === null) {
      completeUsage = false;
      completeReasoningUsage = false;
      continue;
    }
    if (!isRecord(rawUsage)) fail('DSH Host reported invalid usage.');
    const nextInput = tokenCount(rawUsage.inputTokens);
    const nextOutput = tokenCount(rawUsage.outputTokens);
    const nextCacheRead = rawUsage.cacheReadTokens === undefined
      || rawUsage.cacheReadTokens === null
      ? 0
      : tokenCount(rawUsage.cacheReadTokens);
    const nextCacheWrite = rawUsage.cacheWriteTokens === undefined
      || rawUsage.cacheWriteTokens === null
      ? 0
      : tokenCount(rawUsage.cacheWriteTokens);
    if (
      nextInput === undefined
      || nextOutput === undefined
      || nextCacheRead === undefined
      || nextCacheWrite === undefined
    ) fail('DSH Host reported invalid usage.');
    const inputSum = checkedSum([uncachedInputTokens, nextInput]);
    const outputSum = checkedSum([outputTokens, nextOutput]);
    const cacheReadSum = checkedSum([cacheReadInputTokens, nextCacheRead]);
    const cacheWriteSum = checkedSum([cacheCreationInputTokens, nextCacheWrite]);
    if (
      inputSum === undefined
      || outputSum === undefined
      || cacheReadSum === undefined
      || cacheWriteSum === undefined
    ) fail('DSH Host reported overflowing usage.');
    uncachedInputTokens = inputSum;
    outputTokens = outputSum;
    cacheReadInputTokens = cacheReadSum;
    cacheCreationInputTokens = cacheWriteSum;
    if (rawUsage.reasoningTokens === undefined || rawUsage.reasoningTokens === null) {
      completeReasoningUsage = false;
    } else {
      const nextReasoning = tokenCount(rawUsage.reasoningTokens);
      if (nextReasoning === undefined || nextReasoning > nextOutput) {
        fail('DSH Host reported invalid reasoning token usage.');
      }
      const reasoningSum = checkedSum([reasoningOutputTokens, nextReasoning]);
      if (reasoningSum === undefined) fail('DSH Host reported overflowing usage.');
      reasoningOutputTokens = reasoningSum;
    }
  }
  const details = {
    provider: 'dsh-host',
    model,
    ...(provider === undefined ? {} : { providerRoute: provider }),
    stopReason,
    tokenAccounting: 'exclusive-cache-input-buckets',
  };
  if (assistantMessages === 0 || !completeUsage) {
    return UsageRecordSchema.parse({ details });
  }
  const inputTokens = checkedSum([
    uncachedInputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  ]);
  const totalTokens = inputTokens === undefined
    ? undefined
    : checkedSum([inputTokens, outputTokens]);
  if (inputTokens === undefined || totalTokens === undefined) {
    fail('DSH Host reported overflowing usage.');
  }
  return UsageRecordSchema.parse({
    inputTokens,
    outputTokens,
    totalTokens,
    details: {
      ...details,
      uncachedInputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      ...(completeReasoningUsage ? { reasoningOutputTokens } : {}),
    },
  });
}

export function parseDshHostCoreResult(
  result: DshHostRunResult,
  input: Readonly<{ model: string; provider?: string }>,
): ParsedDshHostCoreResult {
  validateEvents(result);
  const projected = buildDshHostResult(result, 0);
  const usage = usageFromEvents(result, input.model, input.provider, projected.stopReason);
  const trace = SourceNeutralTraceWithoutMocksSchema.parse({
    schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
    turns: projected.turns ?? [],
    toolCalls: projected.toolCalls ?? [],
    numTurns: projected.numTurns,
    fullNumTurns: projected.fullNumTurns ?? 0,
    numSubAgents: projected.numSubAgents ?? 0,
  }) as JsonValue;
  return Object.freeze({
    ...(typeof projected.output === 'string' && projected.output.trim() !== ''
      ? { output: projected.output }
      : {}),
    trace,
    usage,
    terminalStatus: projected.ok ? 'completed' : 'failed',
    stopReason: projected.stopReason,
  });
}
