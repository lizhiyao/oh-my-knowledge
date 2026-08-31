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
} from '../../../evaluation-core/contracts/index.js';
import { ExecutionPortFailure } from '../../../evaluation-core/execution/index.js';
import {
  normalizeCodexProtocolEvent,
  type CodexEvent,
} from '../../../executors/openai/codex/protocol.js';
import { extractCodexTrace } from '../../../executors/openai/codex/trace.js';
import {
  SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR,
  SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
  SourceNeutralTraceWithoutMocksSchema,
} from '../source-neutral-trace.js';

export const CODEX_READ_ONLY_SANDBOX_ID = 'omk.codex.read-only/v1' as const;
export const CODEX_WORKSPACE_WRITE_SANDBOX_ID =
  'omk.codex.workspace-write/v1' as const;

export interface CodexCoreProtocolProfile {
  readonly adapterLabel: string;
  readonly errorCode: string;
  readonly schemaNamespace: string;
  readonly schemaUriNamespace: string;
  readonly sourceProtocol: string;
}

export interface ParsedCodexCoreStream {
  readonly events: readonly CodexEvent[];
  readonly output?: string;
  readonly trace?: JsonValue;
  readonly usage?: UsageRecord;
  readonly terminalStatus: 'completed' | 'failed';
}

const CODEX_SCHEMA_DESCRIPTORS = {
  input: { valueKind: 'json-value' },
  output: { valueKind: 'string' },
  trace: SOURCE_NEUTRAL_TRACE_WITHOUT_MOCKS_SCHEMA_DESCRIPTOR,
} as const satisfies Readonly<Record<'input' | 'output' | 'trace', JsonValue>>;

function fail(
  profile: CodexCoreProtocolProfile,
  message: string,
  usage?: UsageRecord,
): never {
  throw new ExecutionPortFailure({
    code: profile.errorCode,
    stage: 'execution',
    message,
  }, usage);
}

function schemaIdentity(
  profile: CodexCoreProtocolProfile,
  name: 'input' | 'output' | 'trace',
): SchemaIdentity {
  const contractVersion = name === 'trace' ? 'v2' : 'v1';
  const schemaVersion = `${profile.schemaNamespace}-${name}/${contractVersion}`;
  return {
    schemaVersion,
    schemaUri: `${profile.schemaUriNamespace}:${name}:${contractVersion}`,
    schemaDigest: digestCanonicalJson({
      schemaVersion,
      sourceProtocol: profile.sourceProtocol,
      contract: CODEX_SCHEMA_DESCRIPTORS[name],
    }),
  };
}

export function createCodexCoreSchemaValidators(
  profile: CodexCoreProtocolProfile,
): readonly CoreSchemaValidator[] {
  return Object.freeze([
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity(profile, 'input')),
      parse(value: unknown): JsonValue {
        return JsonValueSchema.parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity(profile, 'output')),
      parse(value: unknown): JsonValue {
        return z.string().parse(value);
      },
    }),
    Object.freeze({
      schema: deepFreezeCanonicalJson(schemaIdentity(profile, 'trace')),
      parse(value: unknown): JsonValue {
        return SourceNeutralTraceWithoutMocksSchema.parse(value) as JsonValue;
      },
    }),
  ]);
}

export function codexCoreExecutorCapabilities(
  profile: CodexCoreProtocolProfile,
): ExecutorCapabilities {
  return deepFreezeCanonicalJson(ExecutorCapabilitiesSchema.parse({
    schemaVersion: EXECUTOR_CAPABILITIES_SCHEMA_VERSION,
    protocols: [{
      protocolId: 'omk.invoke/v1',
      inputSchema: schemaIdentity(profile, 'input'),
      outputSchema: schemaIdentity(profile, 'output'),
      traceSchema: schemaIdentity(profile, 'trace'),
      execution: {
        concurrency: { safety: 'serialized', maxInFlight: 1 },
        cancellation: 'best-effort',
        state: { resourceLifecycle: 'per-invocation', trialState: 'stateless' },
        seedControl: 'unsupported',
        determinism: 'stochastic',
        features: {
          systemInstructions: 'prepended',
          workspace: ['copy-on-write-overlay'],
          mcp: [],
          mockInterception: [],
          toolPolicies: ['runtime-default'],
          skillDiscovery: ['runtime-default'],
          sandboxIds: [CODEX_READ_ONLY_SANDBOX_ID, CODEX_WORKSPACE_WRITE_SANDBOX_ID],
        },
        telemetry: {
          trace: 'optional',
          usage: 'optional',
          providerCost: { reporting: 'unsupported' },
        },
      },
    }],
  })) as ExecutorCapabilities;
}

function safeToken(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function usageFromEvent(
  profile: CodexCoreProtocolProfile,
  event: CodexEvent,
): UsageRecord | undefined {
  if (event.usage === undefined) return undefined;
  const inputTokens = safeToken(event.usage.input_tokens);
  const outputTokens = safeToken(event.usage.output_tokens);
  const cachedInputTokens = safeToken(event.usage.cached_input_tokens);
  const cacheWriteInputTokens = safeToken(event.usage.cache_write_input_tokens);
  const reasoningOutputTokens = safeToken(event.usage.reasoning_output_tokens);
  if (
    (event.usage.input_tokens !== undefined && inputTokens === undefined)
    || (event.usage.output_tokens !== undefined && outputTokens === undefined)
    || (event.usage.cached_input_tokens !== undefined && cachedInputTokens === undefined)
    || (event.usage.cache_write_input_tokens !== undefined && cacheWriteInputTokens === undefined)
    || (event.usage.reasoning_output_tokens !== undefined && reasoningOutputTokens === undefined)
    || (cachedInputTokens !== undefined && inputTokens !== undefined && cachedInputTokens > inputTokens)
  ) fail(profile, `${profile.adapterLabel} reported invalid usage.`);
  const totalTokens = inputTokens !== undefined && outputTokens !== undefined
    && Number.isSafeInteger(inputTokens + outputTokens)
    ? inputTokens + outputTokens
    : undefined;
  const usage = UsageRecordSchema.parse({
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(
      cachedInputTokens === undefined
      && cacheWriteInputTokens === undefined
      && reasoningOutputTokens === undefined
        ? {}
        : {
            details: {
              ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
              ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
              ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
            },
          }
    ),
  });
  return Object.keys(usage).length === 0 ? undefined : usage;
}

export function parseCodexCoreEvents(
  values: readonly unknown[],
  profile: CodexCoreProtocolProfile,
): ParsedCodexCoreStream {
  const events: CodexEvent[] = [];
  for (const value of values) {
    const captured = JsonValueSchema.safeParse(value);
    if (!captured.success) fail(profile, `${profile.adapterLabel} returned an invalid event.`);
    const event = normalizeCodexProtocolEvent(captured.data);
    if (event === null || typeof event.type !== 'string') {
      fail(profile, `${profile.adapterLabel} returned an invalid event.`);
    }
    events.push(event);
  }
  const supportedEvents = new Set([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
    'item.started', 'item.updated', 'item.completed', 'error',
  ]);
  const supportedItems = new Set([
    'agent_message', 'reasoning', 'command_execution', 'file_change',
    'mcp_tool_call', 'web_search', 'todo_list', 'error', 'file_read', 'file_write',
  ]);
  const pending = new Map<string, string>();
  const completed = new Set<string>();
  let threadStarted = 0;
  let started = 0;
  let terminal: CodexEvent | undefined;
  let protocolError = false;
  for (const [index, event] of events.entries()) {
    if (!supportedEvents.has(event.type ?? '')) protocolError = true;
    if (terminal !== undefined) protocolError = true;
    if (event.type === 'thread.started') {
      threadStarted += 1;
      if (index !== 0 || started > 0) protocolError = true;
    }
    if (event.type === 'turn.started') {
      started += 1;
      if (threadStarted !== 1) protocolError = true;
    }
    if (event.type?.startsWith('item.')) {
      if (started !== 1) protocolError = true;
      const itemId = event.item?.id;
      const itemType = event.item?.type;
      if (
        !supportedItems.has(itemType ?? '')
        || typeof itemId !== 'string'
        || itemId.trim() === ''
      ) protocolError = true;
      else if (event.type === 'item.started') {
        if (pending.has(itemId) || completed.has(itemId)) protocolError = true;
        pending.set(itemId, itemType as string);
      } else if (event.type === 'item.updated' && pending.get(itemId) !== itemType) {
        protocolError = true;
      } else if (event.type === 'item.completed') {
        if (
          completed.has(itemId)
          || (pending.has(itemId) && pending.get(itemId) !== itemType)
        ) protocolError = true;
        pending.delete(itemId);
        completed.add(itemId);
      }
    }
    if (event.type === 'error') protocolError = true;
    if (event.type === 'turn.completed' || event.type === 'turn.failed') {
      if (started !== 1) protocolError = true;
      terminal = event;
    }
  }
  if (events.length === 0 || threadStarted !== 1 || started !== 1 || pending.size > 0) {
    protocolError = true;
  }
  if (protocolError) fail(profile, `${profile.adapterLabel} event stream is invalid.`);
  if (terminal === undefined) fail(profile, `${profile.adapterLabel} event stream has no terminal event.`);
  const usage = usageFromEvent(profile, terminal);
  const finalMessage = [...events].reverse().find((event) => (
    event.type === 'item.completed' && event.item?.type === 'agent_message'
  ))?.item?.text;
  if (
    terminal.type === 'turn.completed'
    && (typeof finalMessage !== 'string' || finalMessage.trim() === '')
  ) fail(profile, `${profile.adapterLabel} completed without an assistant response.`, usage);
  const neutral = extractCodexTrace(events);
  const trace = SourceNeutralTraceWithoutMocksSchema.parse({
    schemaVersion: SOURCE_NEUTRAL_TRACE_SCHEMA_VERSION,
    turns: neutral.turns,
    toolCalls: neutral.toolCalls,
    numTurns: started,
    fullNumTurns: neutral.fullNumTurns,
    numSubAgents: neutral.numSubAgents,
  });
  return {
    events: Object.freeze(events),
    ...(typeof finalMessage === 'string' && finalMessage.trim() !== ''
      ? { output: finalMessage }
      : {}),
    trace,
    ...(usage === undefined ? {} : { usage }),
    terminalStatus: terminal.type === 'turn.completed' ? 'completed' : 'failed',
  };
}
