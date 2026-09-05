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
} from '../../../../eval-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../../eval-core/execution/index.js';
import {
  extractClaudeTrace,
  isClaudeResultMessage,
} from '../../../../executors/anthropic/claude/trace.js';
import type {
  ClaudeMessage,
  ClaudeResultMessage,
} from '../../../../executors/anthropic/claude/protocol.js';
import {
  SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceSchema,
} from '../../../../eval-runtime/traces/source-neutral.js';

export const CLAUDE_CLI_CORE_ADAPTER_IMPLEMENTATION_VERSION = '1.2.0' as const;

export interface ParsedClaudeCliStream {
  readonly messages: readonly ClaudeMessage[];
  readonly output?: string;
  readonly trace: JsonValue;
  readonly usage?: UsageRecord;
  readonly terminalStatus: 'completed' | 'failed';
}

const CLAUDE_SCHEMA_DESCRIPTORS = {
  input: { valueKind: 'json-value' },
  output: { valueKind: 'string' },
  trace: SOURCE_NEUTRAL_TRACE_SCHEMA_DESCRIPTOR,
} as const satisfies Readonly<Record<'input' | 'output' | 'trace', JsonValue>>;

export interface ClaudeMessageProtocolProfile {
  readonly adapterLabel: string;
  readonly errorCode: string;
}

const CLAUDE_CLI_MESSAGE_PROFILE = Object.freeze({
  adapterLabel: 'Claude CLI',
  errorCode: 'OMK_CLAUDE_CLI_PROTOCOL_INVALID',
}) satisfies ClaudeMessageProtocolProfile;

function fail(
  profile: ClaudeMessageProtocolProfile,
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({
    code: profile.errorCode,
    stage: 'execution',
    message,
  }, usage);
}

function schemaIdentity(name: 'input' | 'output' | 'trace'): SchemaIdentity {
  const contractVersion = name === 'trace' ? 'v2' : 'v1';
  const schemaVersion = `omk.claude-cli-${name}/${contractVersion}`;
  return {
    schemaVersion,
    schemaUri: `urn:omk:runtime:claude-cli:${name}:${contractVersion}`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      sourceProtocol: 'claude --print --output-format stream-json',
      contract: CLAUDE_SCHEMA_DESCRIPTORS[name],
    }),
  };
}

/** Validators matching the schema identities advertised by this adapter. */
export function createClaudeCliCoreSchemaValidators(): readonly CoreSchemaValidator[] {
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
        return SourceNeutralTraceSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function claudeCliExecutorCapabilities(): ExecutorCapabilities {
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
          mcp: ['native-config'],
          mockInterception: ['pre-tool-call'],
          toolPolicies: ['allow-list', 'runtime-default'],
          skillDiscovery: ['disabled', 'runtime-default'],
          sandboxIds: [],
        },
        telemetry: {
          trace: 'required',
          usage: 'optional',
          providerCost: { reporting: 'optional' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}

function safeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function safeMetric(value: unknown): number | undefined {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
    ? value
    : undefined;
}

function checkedSum(values: readonly number[]): number | undefined {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function usageFromResult(
  result: ClaudeResultMessage,
  profile: ClaudeMessageProtocolProfile,
): UsageRecord | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  const rawModelUsage = result.modelUsage;
  if (rawModelUsage !== undefined) {
    if (
      rawModelUsage === null
      || typeof rawModelUsage !== 'object'
      || Array.isArray(rawModelUsage)
    ) fail(profile, `${profile.adapterLabel} reported invalid model usage.`);
    const values = Object.values(rawModelUsage);
    const buckets: number[][] = [[], [], [], []];
    for (const value of values) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(profile, `${profile.adapterLabel} reported invalid model usage.`);
      }
      const entry = value as Record<string, unknown>;
      const counts = [
        safeInteger(entry.inputTokens),
        safeInteger(entry.outputTokens),
        safeInteger(entry.cacheReadInputTokens),
        safeInteger(entry.cacheCreationInputTokens),
      ];
      if (counts.some((count) => count === undefined)) {
        fail(profile, `${profile.adapterLabel} reported invalid model usage.`);
      }
      counts.forEach((count, index) => buckets[index]!.push(count!));
    }
    if (values.length > 0) {
      const totals = buckets.map(checkedSum);
      if (totals.some((total) => total === undefined)) {
        fail(profile, `${profile.adapterLabel} reported overflowing model usage.`);
      }
      [inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens] = totals;
    }
  }
  if (inputTokens === undefined && outputTokens === undefined) {
    const rawUsage = result.usage;
    if (rawUsage !== undefined) {
      if (rawUsage === null || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
        fail(profile, `${profile.adapterLabel} reported invalid token usage.`);
      }
      const record = rawUsage as Record<string, unknown>;
      inputTokens = safeInteger(record.input_tokens);
      outputTokens = safeInteger(record.output_tokens);
      cacheReadInputTokens = record.cache_read_input_tokens === undefined
        || record.cache_read_input_tokens === null
        ? undefined
        : safeInteger(record.cache_read_input_tokens);
      cacheCreationInputTokens = record.cache_creation_input_tokens === undefined
        || record.cache_creation_input_tokens === null
        ? undefined
        : safeInteger(record.cache_creation_input_tokens);
      if (
        inputTokens === undefined
        || outputTokens === undefined
        || (
          record.cache_read_input_tokens !== undefined
          && record.cache_read_input_tokens !== null
          && cacheReadInputTokens === undefined
        )
        || (
          record.cache_creation_input_tokens !== undefined
          && record.cache_creation_input_tokens !== null
          && cacheCreationInputTokens === undefined
        )
      ) fail(profile, `${profile.adapterLabel} reported invalid token usage.`);
    }
  }
  const uncachedInputTokens = inputTokens;
  const normalizedInputTokens = uncachedInputTokens === undefined
    || cacheReadInputTokens === undefined
    || cacheCreationInputTokens === undefined
    ? undefined
    : checkedSum([uncachedInputTokens, cacheReadInputTokens, cacheCreationInputTokens]);
  if (
    uncachedInputTokens !== undefined
    && cacheReadInputTokens !== undefined
    && cacheCreationInputTokens !== undefined
    && normalizedInputTokens === undefined
  ) fail(profile, `${profile.adapterLabel} reported overflowing token usage.`);
  const totalTokens = normalizedInputTokens === undefined || outputTokens === undefined
    ? undefined
    : checkedSum([normalizedInputTokens, outputTokens]);
  if (normalizedInputTokens !== undefined && outputTokens !== undefined && totalTokens === undefined) {
    fail(profile, `${profile.adapterLabel} reported overflowing token usage.`);
  }
  const rawCost = result.total_cost_usd;
  const providerCost = rawCost === undefined
    ? undefined
    : safeMetric(rawCost);
  if (rawCost !== undefined && providerCost === undefined) {
    fail(profile, `${profile.adapterLabel} reported invalid provider cost.`);
  }
  const usage = UsageRecordSchema.parse({
    ...(normalizedInputTokens === undefined ? {} : { inputTokens: normalizedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(providerCost === undefined ? {} : {
      providerCost: { amount: providerCost, currency: 'USD', reportedByProvider: true },
    }),
    ...(
      uncachedInputTokens === undefined
      && cacheReadInputTokens === undefined
      && cacheCreationInputTokens === undefined
        ? {}
        : {
            details: {
              tokenAccounting: 'exclusive-cache-input-buckets',
              ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
              ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
              ...(cacheCreationInputTokens === undefined
                ? {}
                : { cacheCreationInputTokens }),
            },
          }
    ),
  });
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function parseClaudeMessageSequence(
  input: readonly unknown[],
  profile: ClaudeMessageProtocolProfile,
): ParsedClaudeCliStream {
  const messages: ClaudeMessage[] = [];
  for (const value of input) {
    const captured = JsonValueSchema.safeParse(value);
    if (
      !captured.success
      || captured.data === null
      || typeof captured.data !== 'object'
      || Array.isArray(captured.data)
      || typeof captured.data.type !== 'string'
      || captured.data.type.trim() === ''
    ) fail(profile, `${profile.adapterLabel} returned an invalid stream message.`);
    if (captured.data.type === 'assistant' || captured.data.type === 'user') {
      const message = captured.data.message;
      if (message === null
          || typeof message !== 'object'
          || Array.isArray(message)
          || !Array.isArray((message as Record<string, unknown>).content)) {
        fail(profile, `${profile.adapterLabel} returned an invalid conversational message.`);
      }
    }
    messages.push(captured.data as unknown as ClaudeMessage);
  }
  const resultIndexes = messages
    .map((message, index) => isClaudeResultMessage(message) ? index : -1)
    .filter((index) => index >= 0);
  if (resultIndexes.length !== 1) {
    fail(profile, resultIndexes.length === 0
      ? `${profile.adapterLabel} stream has no terminal result.`
      : `${profile.adapterLabel} stream has multiple terminal results.`);
  }
  const terminalIndex = resultIndexes[0]!;
  if (messages.slice(terminalIndex + 1).some((message) => (
    message.type === 'assistant' || message.type === 'user' || message.type === 'result'
  ))) fail(profile, `${profile.adapterLabel} emitted conversational messages after its terminal result.`);
  const result = messages[terminalIndex] as ClaudeResultMessage;
  const resultRecord = result as unknown as Record<string, unknown>;
  if (
    typeof resultRecord.subtype !== 'string'
    || resultRecord.subtype.trim() === ''
    || typeof resultRecord.is_error !== 'boolean'
    || (resultRecord.result !== undefined && typeof resultRecord.result !== 'string')
    || (resultRecord.errors !== undefined && (
      !Array.isArray(resultRecord.errors)
      || resultRecord.errors.some((message) => typeof message !== 'string')
    ))
    || (resultRecord.subtype === 'success') === resultRecord.is_error
  ) fail(profile, `${profile.adapterLabel} returned an invalid terminal result.`);
  const usage = usageFromResult(result, profile);
  const numTurns = safeInteger(resultRecord.num_turns);
  if (numTurns === undefined) {
    fail(profile, `${profile.adapterLabel} reported an invalid root turn count.`, usage);
  }
  let trace: JsonValue;
  try {
    const neutral = extractClaudeTrace(messages);
    trace = SourceNeutralTraceSchema.parse({
      schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
      turns: neutral.turns,
      toolCalls: neutral.toolCalls,
      numTurns,
      fullNumTurns: neutral.fullNumTurns,
      numSubAgents: neutral.numSubAgents,
    }) as JsonValue;
  } catch (error) {
    if (error instanceof ExecutionPortFailure) throw error;
    fail(profile, `${profile.adapterLabel} trace could not be projected.`, usage);
  }
  const output = typeof result.result === 'string' && result.result.trim() !== ''
    ? result.result
    : undefined;
  const terminalStatus = result.subtype === 'success' && result.is_error !== true
    ? 'completed' as const
    : 'failed' as const;
  if (terminalStatus === 'completed' && output === undefined) {
    fail(profile, `${profile.adapterLabel} completed without an assistant response.`, usage);
  }
  return {
    messages: Object.freeze(messages),
    ...(output === undefined ? {} : { output }),
    trace,
    ...(usage === undefined ? {} : { usage }),
    terminalStatus,
  };
}

export function parseClaudeCliStream(stdout: string): ParsedClaudeCliStream {
  const messages: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      fail(CLAUDE_CLI_MESSAGE_PROFILE, 'Claude CLI returned malformed JSONL.');
    }
    messages.push(value);
  }
  return parseClaudeMessageSequence(messages, CLAUDE_CLI_MESSAGE_PROFILE);
}
